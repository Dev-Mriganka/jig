// The network modes through the plugin, with a fake Pi and a broker that does not sandbox: the broker's question about a host
// reaches the policy and comes back as an answer, the questions use jig-core's queue, every command is wrapped with the
// forwarders, and `/sandbox` says what is allowed. What the real sandbox does with a refusal is in `network-real.test.ts`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type { SandboxSettings } from "../src/config.ts";
import { fakeSession } from "./support/fake-session.ts";
import type { FakeSession, FakeSessionOptions } from "./support/fake-session.ts";
import { until } from "./support/session.ts";

let current: FakeSession | undefined;
afterEach(async () => {
    await current?.end();
    current = undefined;
});

function network(mode: SandboxSettings["network"]["mode"], over: Partial<SandboxSettings["network"]> = {}) {
    return { network: { ...DEFAULT_SETTINGS.network, mode, ...over } };
}

async function begin(over: FakeSessionOptions): Promise<FakeSession> {
    current = fakeSession(over);
    await current.start();
    // A command makes sure the sandbox has started, as it does for the agent.
    await current.tool("bash", { command: "true" });
    return current;
}

let counter = 0;
/** The broker asks about a host; resolves with the answer Pi sent back. */
async function connect(s: FakeSession, host: string, port: number): Promise<{ allow: boolean; reason?: string }> {
    const askId = ++counter;
    const before = s.brokers.log.requests.filter((request) => request.type === "answer-host").length;
    s.brokers.emit({ event: "ask-host", askId, host, port });
    await until(
        () => s.brokers.log.requests.filter((request) => request.type === "answer-host").length > before,
        5000,
        "an answer",
    );
    const answer = s.brokers.log.requests
        .filter((request) => request.type === "answer-host")
        .find((request) => request.fields.askId === askId);
    return {
        allow: answer?.fields.allow === true,
        ...(typeof answer?.fields.reason === "string" ? { reason: answer.fields.reason } : {}),
    };
}

describe("the broker's question about a host", () => {
    test("filtered: a public host is allowed, the others are refused with their reasons", async () => {
        const s = await begin({ settings: network("filtered", { localhost: [5432] }) });
        assert.deepEqual(await connect(s, "registry.npmjs.org", 443), { allow: true });
        const metadata = await connect(s, "169.254.169.254", 80);
        assert.equal(metadata.allow, false);
        assert.match(
            metadata.reason ?? "",
            /169\.254\.169\.254:80 is a cloud metadata address, and those are always blocked/,
        );
        const loopback = await connect(s, "127.0.0.1", 8080);
        assert.match(loopback.reason ?? "", /this machine's own address; list its port in sandbox\.network\.localhost/);
        assert.deepEqual(await connect(s, "127.0.0.1", 5432), { allow: true }, "a listed port");
        assert.match((await connect(s, "10.0.0.8", 22)).reason ?? "", /private network address/);
    });

    test("deny refuses with the entry that matched", async () => {
        const s = await begin({ settings: network("filtered", { deny: ["*.corp.example.com"] }) });
        const decision = await connect(s, "db.corp.example.com", 5432);
        assert.match(decision.reason ?? "", /on sandbox\.network\.deny \(\*\.corp\.example\.com\)/);
    });

    test("ask: a new host asks once, and the answer is remembered as the user gave it", async () => {
        const answers: string[] = [];
        const s = await begin({
            settings: network("ask", { allow: ["registry.npmjs.org"] }),
            select: (title, options) => {
                if (!options.includes("This session")) return undefined;
                answers.push(title);
                return title.includes("session.example.com")
                    ? "This session"
                    : title.includes("always.example.com")
                      ? "Always"
                      : "No";
            },
        });
        assert.deepEqual(await connect(s, "registry.npmjs.org", 443), { allow: true }, "configured: not asked");
        assert.equal(answers.length, 0);
        assert.deepEqual(await connect(s, "session.example.com", 443), { allow: true });
        assert.deepEqual(await connect(s, "session.example.com", 443), { allow: true });
        assert.equal(answers.length, 1, "the second connection was not asked about");
        assert.deepEqual(await connect(s, "always.example.com", 443), { allow: true });
        assert.deepEqual(await connect(s, "always.example.com", 443), { allow: true });
        assert.equal(answers.length, 2);
        const file = path.join(s.agentDir, "jig-sandbox", "allowed.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hosts, ["always.example.com:443"]);
        const no = await connect(s, "other.example.com", 443);
        assert.equal(no.allow, false);
        assert.match(no.reason ?? "", /the user said no\. Do not try another way round it/);
        await connect(s, "other.example.com", 443);
        assert.equal(answers.length, 4, "No is asked again");
        assert.match(answers[0] ?? "", /^bash wants to reach session\.example\.com:443\./);
    });

    test("ask with no screen refuses and says how a person allows it", async () => {
        const s = await begin({ settings: network("ask"), ui: false });
        const decision = await connect(s, "new.example.com", 443);
        assert.equal(decision.allow, false);
        assert.match(
            decision.reason ?? "",
            /no screen to ask on\. A person can allow it with \/sandbox allowed add new\.example\.com/,
        );
    });

    test("ask never asks about what is always refused", async () => {
        let asked = 0;
        const s = await begin({ settings: network("ask"), select: () => (asked++, "Always") });
        for (const host of ["169.254.169.254", "127.0.0.1", "192.168.0.7", "100.64.0.1"]) {
            assert.equal((await connect(s, host, 80)).allow, false, host);
        }
        assert.equal(asked, 0);
        assert.equal(existsSync(path.join(s.agentDir, "jig-sandbox", "allowed.json")), false);
    });

    test("the question waits in jig-core's queue: never open over one of its own", async () => {
        let release: (answer: string) => void = () => undefined;
        const gate = new Promise<string>((resolve) => {
            release = resolve;
        });
        const s = await begin({
            core: true,
            settings: network("ask"),
            select: (_title, options) =>
                options.includes("Run once")
                    ? (gate as unknown as string)
                    : options.includes("This session")
                      ? "This session"
                      : undefined,
        });
        // jig-core's own question: a command that asks to run outside, which the test leaves open.
        const outside = s.gated("bash", { command: "echo hi", outside: true, reason: "a test" });
        await until(() => s.ctx.screen.selects.length > 0, 5000, "jig-core's question");
        const hostAnswer = connect(s, "new.example.com", 443);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(s.ctx.screen.selects.length, 1, "the host question has not been shown");
        release("Run once");
        assert.deepEqual(await hostAnswer, { allow: true });
        await outside;
        assert.equal(s.ctx.screen.selects.length, 2);
        assert.ok(s.ctx.screen.selects[1]?.options.includes("This session"));
    });

    test("a broker event that is not a question is ignored, and so is a question that cannot be answered", async () => {
        const s = await begin({ settings: network("filtered") });
        s.brokers.emit({ event: "something-else" });
        s.brokers.emit({ event: "ask-host", askId: 900, host: "", port: 80 });
        await until(
            () =>
                s.brokers.log.requests.some(
                    (request) => request.type === "answer-host" && request.fields.askId === 900,
                ),
            5000,
        );
        const answer = s.brokers.log.requests.find(
            (request) => request.type === "answer-host" && request.fields.askId === 900,
        );
        assert.equal(answer?.fields.allow, false);
    });
});

describe("every command", () => {
    test("is wrapped with the forwarders for the ports you listed, and the broker is told the command as the agent wrote it", async () => {
        const s = await begin({ settings: network("filtered", { localhost: [5432] }) });
        await s.tool("bash", { command: "psql -h localhost -c 'select 1'" });
        const wrap = s.brokers.log.requests.filter((request) => request.type === "wrap").at(-1);
        assert.match(
            String(wrap?.fields.command),
            /^\( _s='[^']+'; .*for _p in 5432; do .*\); psql -h localhost -c 'select 1'$/,
        );
        assert.equal(String(wrap?.fields.command).split("\n").length, 1, "the command's own lines do not move");
        assert.equal(wrap?.fields.commandText, "psql -h localhost -c 'select 1'");
    });

    test("open and off wrap the command as it was", async () => {
        for (const mode of ["open", "off"] as const) {
            const s = await begin({ settings: network(mode, { localhost: [5432] }) });
            await s.tool("bash", { command: "echo plain" });
            const wrap = s.brokers.log.requests.filter((request) => request.type === "wrap").at(-1);
            assert.equal(wrap?.fields.command, "echo plain", mode);
            await s.end();
            current = undefined;
        }
    });

    test("with nothing to carry the command is not changed in filtered either", async () => {
        const s = await begin({ settings: network("filtered") });
        await s.tool("bash", { command: "echo plain" });
        const wrap = s.brokers.log.requests.filter((request) => request.type === "wrap").at(-1);
        assert.equal(wrap?.fields.command, "echo plain");
    });
});

describe("/sandbox", () => {
    test("says what the mode lets through", async () => {
        const s = await begin({
            settings: network("ask", { allow: ["registry.npmjs.org"], deny: ["db.example.com"], localhost: [5432] }),
        });
        const lines = (await s.command("sandbox", "")).join("\n");
        assert.match(lines, /bash is sandboxed, network ask/);
        assert.match(lines, /hosts allowed without asking: registry\.npmjs\.org/);
        assert.match(lines, /hosts refused: db\.example\.com/);
        assert.match(lines, /ports on this machine commands may reach: 5432/);
    });

    test("shows nothing of it in open mode", async () => {
        const s = await begin({ settings: network("open") });
        assert.doesNotMatch((await s.command("sandbox", "")).join("\n"), /hosts allowed without asking/);
    });

    test("allowed lists hosts, adds one that is kept, refuses an address that is always refused, and forgets", async () => {
        const s = await begin({ settings: network("ask") });
        assert.match((await s.command("sandbox", "allowed")).join("\n"), /Hosts allowed always: nothing/);
        const added = (await s.command("sandbox", "allowed add api.example.com:443")).join("\n");
        assert.match(added, /Allowed api\.example\.com:443, always\./);
        assert.deepEqual(JSON.parse(readFileSync(path.join(s.agentDir, "jig-sandbox", "allowed.json"), "utf8")).hosts, [
            "api.example.com:443",
        ]);
        assert.deepEqual(await connect(s, "api.example.com", 443), { allow: true });
        assert.match(
            (await s.command("sandbox", "allowed")).join("\n"),
            /Hosts allowed always:\n\s+api\.example\.com:443/,
        );
        assert.match(
            (await s.command("sandbox", "")).join("\n"),
            /Hosts allowed by you[^\n]*\n\s+api\.example\.com:443/,
        );
        assert.match(
            (await s.command("sandbox", "allowed add 10.0.0.5")).join("\n"),
            /an address the sandbox always refuses \(private\)/,
        );
        assert.match(
            (await s.command("sandbox", "allowed add 169.254.169.254")).join("\n"),
            /always refuses \(metadata\)/,
        );
        assert.match(
            (await s.command("sandbox", "allowed forget api.example.com:443")).join("\n"),
            /Forgot api\.example\.com:443: it asks again/,
        );
        assert.deepEqual(
            JSON.parse(readFileSync(path.join(s.agentDir, "jig-sandbox", "allowed.json"), "utf8")).hosts ?? [],
            [],
        );
    });

    test("allowed add of a folder still works as before, and a host in another mode says when it matters", async () => {
        const s = await begin({ settings: network("filtered") });
        assert.match(
            (await s.command("sandbox", "allowed add example.org")).join("\n"),
            /It matters in the ask network mode; the mode now is filtered/,
        );
        assert.match(
            (await s.command("sandbox", "allowed add ~/.nothing-like-it")).join("\n"),
            /is not a folder the sandbox asks about/,
        );
    });
});
