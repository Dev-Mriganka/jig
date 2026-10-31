// The callback's decision about one connection: what is always refused, what `localhost` ports open, `deny`, and the difference
// between `filtered` (every public host) and `ask` (a new host waits for you).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPolicy } from "../src/network/policy.ts";
import type { Decision, PolicyConfig } from "../src/network/policy.ts";

const OWN = ["127.0.0.1", "::1", "192.168.1.50", "203.0.113.9"];

function policy(
    over: Partial<PolicyConfig> = {},
    extra: { bridged?: number[]; allowed?: string[]; ask?: Decision } = {},
) {
    const asked: Array<[string, number]> = [];
    const config: PolicyConfig = { mode: "filtered", allow: [], deny: [], localhost: [], ...over };
    const p = createPolicy({
        config: () => config,
        bridged: (port) => (extra.bridged ?? []).includes(port),
        allowedHosts: () => extra.allowed ?? [],
        ask: async (host, port) => {
            asked.push([host, port]);
            return extra.ask ?? { allow: false, reason: "the user said no" };
        },
        own: () => OWN,
    });
    return { p, asked };
}

const refusal = (decision: Decision): string => (decision.allow ? "(allowed)" : decision.reason);

describe("always refused", () => {
    for (const mode of ["filtered", "ask"] as const) {
        test(`in ${mode}: metadata addresses and names, whatever else is configured`, async () => {
            const { p } = policy({
                mode,
                allow: ["169.254.169.254", "metadata.google.internal", "*.internal"],
                localhost: [80, 443],
            });
            for (const host of [
                "169.254.169.254",
                "metadata.google.internal",
                "METADATA.GOOGLE.INTERNAL.",
                "fd00:ec2::254",
                "[fd00:ec2::254]",
                "::ffff:169.254.169.254",
                "metadata",
                "169.254.170.2",
            ]) {
                const decision = await p.decide(host, 80);
                assert.equal(decision.allow, false, host);
                assert.match(refusal(decision), /cloud metadata address, and those are always blocked/, host);
            }
        });

        test(`in ${mode}: loopback, this machine's own addresses, link-local, private and carrier addresses`, async () => {
            const { p } = policy({ mode, allow: ["10.0.0.5", "localhost"] });
            const expectations: Array<[string, RegExp]> = [
                ["127.0.0.1", /this machine's own address; list its port in sandbox\.network\.localhost/],
                ["127.5.5.5", /this machine's own address/],
                ["::1", /this machine's own address/],
                ["localhost", /this machine's own address/],
                ["app.localhost", /this machine's own address/],
                ["::ffff:127.0.0.1", /this machine's own address/],
                ["192.168.1.50", /one of this machine's own addresses/],
                ["203.0.113.9", /one of this machine's own addresses/],
                ["192.168.1.99", /private network address/],
                ["10.0.0.5", /private network address/],
                ["172.20.0.1", /private network address/],
                ["fd12::1", /private network address/],
                ["169.254.1.1", /link-local address/],
                ["fe80::1", /link-local address/],
                ["100.64.1.1", /carrier-grade NAT/],
                ["0.0.0.0", /not a public address/],
                ["224.0.0.251", /not a public address/],
            ];
            for (const [host, why] of expectations) {
                const decision = await p.decide(host, 5432);
                assert.equal(decision.allow, false, host);
                assert.match(refusal(decision), why, host);
            }
        });
    }

    test("a host that cannot be checked is refused: spellings some programs read as 127.0.0.1", async () => {
        const { p } = policy({ localhost: [80] });
        for (const host of ["2130706433", "0x7f000001", "127.1", "0177.0.0.1", "", "exa mple.com"]) {
            const decision = await p.decide(host, 80);
            assert.equal(decision.allow, false, host);
            assert.match(refusal(decision), /not a valid host name or address/);
        }
    });
});

describe("a connection with no valid port", () => {
    test("is refused, whatever the host", async () => {
        const { p } = policy({ localhost: [80] });
        for (const port of [0, -1, 65536, Number.NaN, 1.5]) {
            const decision = await p.decide("registry.npmjs.org", port);
            assert.equal(decision.allow, false, String(port));
            assert.match(refusal(decision), /no valid port/);
        }
    });
});

describe("ports on this machine", () => {
    test("a port in network.localhost opens loopback and this machine's own addresses at that port, and nothing else", async () => {
        const { p } = policy({ localhost: [5432] });
        for (const host of ["127.0.0.1", "::1", "localhost", "127.7.7.7", "192.168.1.50", "203.0.113.9"]) {
            assert.deepEqual(await p.decide(host, 5432), { allow: true }, host);
            assert.equal((await p.decide(host, 5433)).allow, false, `${host}:5433`);
        }
        // Other private neighbours, link-local and carrier addresses stay refused at that port.
        for (const host of ["192.168.1.99", "10.1.2.3", "169.254.1.1", "100.64.0.9", "fd12::1"]) {
            assert.equal((await p.decide(host, 5432)).allow, false, host);
        }
        assert.equal((await p.decide("169.254.169.254", 5432)).allow, false, "metadata never");
    });

    test("a port a task's server is bridged on opens loopback and not this machine's other addresses", async () => {
        const { p } = policy({}, { bridged: [3000] });
        assert.deepEqual(await p.decide("127.0.0.1", 3000), { allow: true });
        assert.deepEqual(await p.decide("localhost", 3000), { allow: true });
        assert.equal((await p.decide("127.0.0.1", 3001)).allow, false);
        assert.equal((await p.decide("192.168.1.50", 3000)).allow, false, "the listener is on loopback only");
    });

    test("a jig-core tunnel's port is not reachable unless it is listed", async () => {
        const { p } = policy({ localhost: [8080] }, { bridged: [3000] });
        assert.equal((await p.decide("127.0.0.1", 15432)).allow, false);
        assert.match(refusal(await p.decide("127.0.0.1", 15432)), /list its port in sandbox\.network\.localhost/);
    });
});

describe("deny", () => {
    test("refuses with the entry that matched, and wins over allow and a kept answer", async () => {
        const { p, asked } = policy(
            { mode: "ask", allow: ["db.example.com"], deny: ["*.internal.example.com", "db.example.com:5432"] },
            { allowed: ["admin.internal.example.com:443"] },
        );
        const wildcard = await p.decide("admin.internal.example.com", 443);
        assert.equal(wildcard.allow, false);
        assert.match(
            refusal(wildcard),
            /admin\.internal\.example\.com:443 is on sandbox\.network\.deny \(\*\.internal\.example\.com\)/,
        );
        assert.match(
            refusal(await p.decide("db.example.com", 5432)),
            /on sandbox\.network\.deny \(db\.example\.com:5432\)/,
        );
        assert.deepEqual(
            await p.decide("db.example.com", 443),
            { allow: true },
            "another port of the same host is allowed",
        );
        assert.deepEqual(asked, []);
    });

    test("is checked in filtered mode too", async () => {
        const { p } = policy({ deny: ["blocked.example.com"] });
        assert.equal((await p.decide("blocked.example.com", 443)).allow, false);
        assert.deepEqual(await p.decide("fine.example.com", 443), { allow: true });
    });
});

describe("filtered and ask", () => {
    test("filtered allows every other host and asks nobody", async () => {
        const { p, asked } = policy();
        for (const host of ["registry.npmjs.org", "8.8.8.8", "2606:4700:4700::1111", "repo.maven.apache.org"]) {
            assert.deepEqual(await p.decide(host, 443), { allow: true }, host);
        }
        assert.deepEqual(asked, []);
    });

    test("ask lets a configured or kept host pass and asks about a new one", async () => {
        const { p, asked } = policy(
            { mode: "ask", allow: ["registry.npmjs.org", "*.maven.org:443"] },
            { allowed: ["api.example.com:443"], ask: { allow: true } },
        );
        assert.deepEqual(await p.decide("registry.npmjs.org", 443), { allow: true });
        assert.deepEqual(await p.decide("repo.maven.org", 443), { allow: true });
        assert.deepEqual(await p.decide("api.example.com", 443), { allow: true });
        assert.deepEqual(asked, []);
        assert.deepEqual(await p.decide("new.example.com", 443), { allow: true });
        assert.deepEqual(await p.decide("repo.maven.org", 80), { allow: true }, "the port is asked about: it said yes");
        assert.deepEqual(asked, [
            ["new.example.com", 443],
            ["repo.maven.org", 80],
        ]);
    });

    test("an answer of no is a refusal with its reason", async () => {
        const { p } = policy({ mode: "ask" }, { ask: { allow: false, reason: "the user said no" } });
        assert.deepEqual(await p.decide("new.example.com", 443), { allow: false, reason: "the user said no" });
    });

    test("the host is cleaned before it is asked about", async () => {
        const { p, asked } = policy({ mode: "ask" });
        await p.decide("New.Example.COM.", 443);
        assert.deepEqual(asked, [["new.example.com", 443]]);
    });

    test("a failure to decide is a refusal, never an allow", async () => {
        const p = createPolicy({
            config: () => ({ mode: "ask", allow: [], deny: [], localhost: [] }),
            bridged: () => false,
            allowedHosts: () => [],
            ask: async () => {
                throw new Error("the screen broke");
            },
            own: () => [],
        });
        const decision = await p.decide("new.example.com", 443);
        assert.equal(decision.allow, false);
        assert.match(refusal(decision), /could not decide \(the screen broke\)/);
    });
});
