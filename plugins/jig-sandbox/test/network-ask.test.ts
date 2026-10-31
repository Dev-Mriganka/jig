// Asking you about a host in `ask` mode: the four answers and what each remembers, one question for connections that arrive
// together, a place in jig-core's queue, and no screen meaning no.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAllowed } from "../src/allowed.ts";
import { createHostAsker } from "../src/network/ask-host.ts";
import type { Screen } from "../src/network/ask-host.ts";

let root: string;
beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "jig-ask-host-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
    answer: (title: string, options: string[]) => string | undefined | Promise<string | undefined>,
    over: { screen?: boolean; now?: { at: number }; onceMs?: number } = {},
) {
    const asked: Array<{ title: string; options: string[]; timeout: number | undefined }> = [];
    const screen: Screen = {
        hasUI: true,
        ui: {
            select: async (title: string, options: string[], dialog?: { timeout?: number }) => {
                asked.push({ title, options, timeout: dialog?.timeout });
                return answer(title, options);
            },
        },
    } as never;
    const allowed = createAllowed(() => path.join(root, "agent"));
    const clock = over.now ?? { at: 0 };
    const notices: string[] = [];
    let turns = 0;
    const asker = createHostAsker({
        allowed,
        screen: () => (over.screen === false ? undefined : screen),
        inTurn: (job) => {
            turns++;
            return job();
        },
        now: () => clock.at,
        ...(over.onceMs === undefined ? {} : { onceMs: over.onceMs }),
        notify: (message) => notices.push(message),
    });
    return { asker, asked, allowed, clock, notices, turns: () => turns };
}

describe("the question", () => {
    test("names the host and port, offers four answers, and closes itself after two minutes", async () => {
        const { asker, asked } = setup(() => "No");
        await asker.ask("api.example.com", 443);
        assert.equal(asked.length, 1);
        assert.match(asked[0]?.title ?? "", /^bash wants to reach api\.example\.com:443\./);
        assert.deepEqual(asked[0]?.options, ["Once", "This session", "Always", "No"]);
        assert.equal(asked[0]?.timeout, 120_000);
    });

    test("an IPv6 host that was allowed is remembered under its bracketed form", async () => {
        const { asker, allowed, asked } = setup(() => "This session");
        await asker.ask("2606:4700::1111", 443);
        assert.deepEqual(allowed.hosts(), ["[2606:4700::1111]:443"]);
        assert.deepEqual(await asker.ask("2606:4700::1111", 443), { allow: true });
        assert.equal(asked.length, 1, "not asked again");
    });

    test("an IPv6 host is shown in brackets", async () => {
        const { asker, asked } = setup(() => "No");
        await asker.ask("2606:4700::1111", 443);
        assert.match(asked[0]?.title ?? "", /bash wants to reach \[2606:4700::1111\]:443\./);
    });

    test("it waits in the queue it was given", async () => {
        const { asker, turns } = setup(() => "Once");
        await asker.ask("api.example.com", 443);
        assert.equal(turns(), 1);
    });
});

describe("the answers", () => {
    test("No refuses with a reason that tells the agent not to look for another way", async () => {
        const { asker, allowed } = setup(() => "No");
        const decision = await asker.ask("api.example.com", 443);
        assert.deepEqual(decision, {
            allow: false,
            reason: "api.example.com:443 was refused: the user said no. Do not try another way round it",
        });
        assert.deepEqual(allowed.hosts(), []);
        assert.deepEqual(await asker.ask("api.example.com", 443), decision, "and it asks again next time");
    });

    test("a question closed without an answer refuses and says so", async () => {
        const { asker } = setup(() => undefined);
        const decision = await asker.ask("api.example.com", 443);
        assert.equal(decision.allow, false);
        assert.match(decision.allow ? "" : decision.reason, /closed without an answer/);
    });

    test("a question that fails refuses, with the failure", async () => {
        const { asker } = setup(() => {
            throw new Error("the screen is gone");
        });
        const decision = await asker.ask("api.example.com", 443);
        assert.equal(decision.allow, false);
        assert.match(decision.allow ? "" : decision.reason, /the question failed \(the screen is gone\)/);
    });

    test("Once allows that host and port for a few seconds, then asks again", async () => {
        const { asker, asked, clock } = setup(() => "Once", { onceMs: 15_000 });
        assert.deepEqual(await asker.ask("api.example.com", 443), { allow: true });
        assert.deepEqual(asker.allowed(), ["api.example.com:443"]);
        clock.at = 14_000;
        assert.deepEqual(asker.allowed(), ["api.example.com:443"]);
        clock.at = 16_000;
        assert.deepEqual(asker.allowed(), [], "forgotten");
        await asker.ask("api.example.com", 443);
        assert.equal(asked.length, 2);
    });

    test("This session is remembered until Pi ends, and for that host and port only", async () => {
        const { asker, allowed } = setup(() => "This session");
        assert.deepEqual(await asker.ask("api.example.com", 443), { allow: true });
        assert.deepEqual(allowed.hosts(), ["api.example.com:443"]);
        assert.deepEqual(allowed.sessionHosts(), ["api.example.com:443"]);
        assert.deepEqual(allowed.always().hosts, [], "nothing kept on disk");
    });

    test("Always is kept in the agent folder with a private mode, and a new session reads it", async () => {
        const { asker } = setup(() => "Always");
        assert.deepEqual(await asker.ask("api.example.com", 443), { allow: true });
        const file = path.join(root, "agent", "jig-sandbox", "allowed.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { folders: [], hosts: ["api.example.com:443"] });
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(createAllowed(() => path.join(root, "agent")).hosts(), ["api.example.com:443"]);
    });

    test("Always that cannot be kept counts for the session, and you are told", async () => {
        // A file where the agent folder should be, so nothing can be made in it.
        const blocker = path.join(root, "blocker");
        writeFileSync(blocker, "x");
        const notices: string[] = [];
        const asker = createHostAsker({
            allowed: createAllowed(() => blocker),
            screen: () => ({ hasUI: true, ui: { select: async () => "Always" } }) as never,
            inTurn: (job) => job(),
            notify: (message) => notices.push(message),
        });
        assert.deepEqual(await asker.ask("api.example.com", 443), { allow: true });
        assert.match(
            notices[0] ?? "",
            /api\.example\.com:443 is allowed for this session only: the answer could not be kept/,
        );
        assert.deepEqual(asker.allowed(), ["api.example.com:443"]);
    });
});

describe("connections that arrive together", () => {
    test("share one question and one answer", async () => {
        let release: (answer: string) => void = () => undefined;
        const gate = new Promise<string>((resolve) => {
            release = resolve;
        });
        const { asker, asked } = setup(() => gate);
        const all = [
            asker.ask("registry.example.com", 443),
            asker.ask("registry.example.com", 443),
            asker.ask("registry.example.com", 443),
        ];
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(asked.length, 1);
        release("Once");
        assert.deepEqual(await Promise.all(all), [{ allow: true }, { allow: true }, { allow: true }]);
    });

    test("a host answered while another question waited its turn is not asked again", async () => {
        const turns: Array<() => void> = [];
        const asked: string[] = [];
        const allowed = createAllowed(() => path.join(root, "agent"));
        const asker = createHostAsker({
            allowed,
            screen: () =>
                ({
                    hasUI: true,
                    ui: { select: async (title: string) => (asked.push(title), "This session") },
                }) as never,
            // A queue we release by hand.
            inTurn: (job) => new Promise((resolve, reject) => turns.push(() => job().then(resolve, reject))),
        });
        const first = asker.ask("a.example.com", 443);
        const second = asker.ask("a.example.com", 80);
        const third = asker.ask("b.example.com", 443);
        allowed.allowHostSession("b.example.com:443");
        for (let index = 0; index < 3; index++) {
            turns.shift()?.();
            await new Promise((resolve) => setImmediate(resolve));
        }
        await Promise.all([first, second, third]);
        assert.equal(asked.length, 2, "b.example.com was answered meanwhile");
    });
});

describe("no screen", () => {
    test("means no, and says how a person allows it", async () => {
        const { asker, asked } = setup(() => "Always", { screen: false });
        const decision = await asker.ask("api.example.com", 443);
        assert.equal(asked.length, 0);
        assert.deepEqual(decision, {
            allow: false,
            reason: "api.example.com:443 is not allowed, and there is no screen to ask on. A person can allow it with /sandbox allowed add api.example.com",
        });
    });

    test("a screen that cannot ask (print mode) means no as well", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const asker = createHostAsker({
            allowed,
            screen: () => ({ hasUI: false, ui: {} }) as never,
            inTurn: (job) => job(),
        });
        assert.equal((await asker.ask("api.example.com", 443)).allow, false);
    });
});
