// The decision: every cell of the rules table, the tool's `atLeast`, configuration rules, session allows, and every
// part of the floor.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Decision, Effect, EnvironmentKind, Rule } from "../src/contract.ts";
import { decide, ruleMatches, sessionKey } from "../src/decide.ts";
import type { DecidedCall, DecideInput } from "../src/decide.ts";

/** A call in an environment of the given kind. The environment is named after its kind. */
function call(kind: EnvironmentKind, effect: Effect, extra: Partial<DecidedCall> = {}): DecidedCall {
    return { tool: "tool", environment: kind, environmentKind: kind, effect, unknown: false, ...extra };
}

function run(c: DecidedCall, extra: Partial<DecideInput> = {}) {
    return decide({ call: c, rules: [], sessionAllows: new Set(), hasUI: true, ...extra });
}

describe("the rules table", () => {
    const table: Array<[EnvironmentKind, Effect, Decision]> = [
        ["local", "read", "allow"],
        ["local", "write", "allow"],
        ["external", "read", "allow"],
        ["external", "write", "ask"],
        ["test", "read", "allow"],
        ["test", "write", "ask"],
        ["production", "read", "allow"],
        ["production", "write", "deny"],
    ];
    for (const [kind, effect, expected] of table) {
        test(`${kind} ${effect} is ${expected}`, () => {
            const verdict = run(call(kind, effect));
            assert.equal(verdict.decision, expected);
            // The production write cell is the floor; every other cell is the table.
            assert.equal(verdict.source, kind === "production" && effect === "write" ? "floor" : "table");
        });
    }

    test("a deny carries a reason for the model", () => {
        assert.match(run(call("production", "write")).reason ?? "", /writes to production are never allowed/);
        assert.equal(run(call("local", "read")).reason, undefined);
    });
});

describe("the tool's atLeast", () => {
    test("makes a call stricter than the table", () => {
        const ask = run(call("local", "write", { atLeast: "ask" }));
        assert.deepEqual([ask.decision, ask.source], ["ask", "tool"]);
        const deny = run(call("external", "write", { atLeast: "deny" }));
        assert.deepEqual([deny.decision, deny.source], ["deny", "tool"]);
        assert.match(deny.reason ?? "", /tool's own declaration/);
        assert.equal(run(call("external", "write", { atLeast: "ask" })).decision, "ask");
        assert.equal(run(call("external", "write", { atLeast: "ask" })).source, "table", "the table already said ask");
    });

    test("can never make a call looser", () => {
        assert.equal(run(call("external", "write", { atLeast: "ask" })).decision, "ask");
        assert.equal(run(call("production", "write", { atLeast: "ask" })).decision, "deny");
    });
});

describe("rules from configuration", () => {
    const rule = (extra: Partial<Rule>): Rule => ({ tool: "tool", decision: "ask", ...extra });

    test("can make a call stricter", () => {
        const verdict = run(call("local", "write"), { rules: [rule({ decision: "ask" })] });
        assert.deepEqual([verdict.decision, verdict.source], ["ask", "rule"]);
        assert.deepEqual(run(call("local", "read"), { rules: [rule({ decision: "deny" })] }).decision, "deny");
    });

    test("can make a call looser, even past the tool's atLeast", () => {
        const verdict = run(call("external", "write", { atLeast: "ask" }), { rules: [rule({ decision: "allow" })] });
        assert.deepEqual([verdict.decision, verdict.source], ["allow", "rule"]);
        assert.equal(
            run(call("test", "write", { environment: "staging" }), {
                rules: [rule({ environment: "staging", decision: "allow" })],
            }).decision,
            "allow",
        );
    });

    test("the first matching rule decides, so rules are listed most specific first", () => {
        const specific = rule({ action: "push", decision: "ask" });
        const general = rule({ decision: "allow" });
        const push = call("external", "write", { action: "push" });
        assert.equal(run(push, { rules: [specific, general] }).decision, "ask");
        assert.equal(run(push, { rules: [general, specific] }).decision, "allow");
        assert.equal(
            run(call("external", "write", { action: "fetch" }), { rules: [specific, general] }).decision,
            "allow",
        );
    });

    test("match on tool, action, environment and effect, and a missing field matches anything", () => {
        const c = call("test", "write", { tool: "deploy", action: "run", environment: "staging" });
        assert.equal(ruleMatches({ tool: "deploy", decision: "ask" }, c), true);
        assert.equal(
            ruleMatches({ tool: "deploy", action: "run", environment: "staging", effect: "write", decision: "ask" }, c),
            true,
        );
        assert.equal(ruleMatches({ tool: "other", decision: "ask" }, c), false);
        assert.equal(ruleMatches({ tool: "deploy", action: "stop", decision: "ask" }, c), false);
        assert.equal(ruleMatches({ tool: "deploy", environment: "qa", decision: "ask" }, c), false);
        assert.equal(ruleMatches({ tool: "deploy", effect: "read", decision: "ask" }, c), false);
        assert.equal(
            ruleMatches({ tool: "deploy", action: "run", decision: "ask" }, call("test", "write", { tool: "deploy" })),
            false,
            "the call has no action",
        );
    });

    test("can name tools with a wildcard", () => {
        assert.equal(
            ruleMatches({ tool: "mcp__*", decision: "deny" }, call("local", "read", { tool: "mcp__db__query" })),
            true,
        );
        assert.equal(ruleMatches({ tool: "mcp__*", decision: "deny" }, call("local", "read", { tool: "git" })), false);
    });

    test("carry their choice of screen", () => {
        assert.equal(run(call("external", "write"), { rules: [rule({ approval: "review" })] }).approval, "review");
        assert.equal(run(call("external", "write", { approval: "form" })).approval, "form", "the tool's own choice");
        assert.equal(
            run(call("external", "write", { approval: "form" }), { rules: [rule({ approval: "dialog" })] }).approval,
            "dialog",
            "the rule's choice wins",
        );
    });
});

describe("session allows", () => {
    const c = call("external", "write", { tool: "git", action: "push" });
    const allowed = new Set([sessionKey(c)]);

    test("turn an ask into an allow", () => {
        const verdict = run(c, { sessionAllows: allowed });
        assert.deepEqual([verdict.decision, verdict.source], ["allow", "session"]);
    });

    test("apply to that tool, action and environment only", () => {
        assert.equal(run({ ...c, action: "force-push" }, { sessionAllows: allowed }).decision, "ask");
        assert.equal(run({ ...c, tool: "other" }, { sessionAllows: allowed }).decision, "ask");
        assert.equal(
            run({ ...c, environment: "elsewhere", environmentKind: "test" }, { sessionAllows: allowed }).decision,
            "ask",
        );
    });

    test("also turn an ask that a rule or the tool asked for", () => {
        assert.equal(
            run(call("local", "write", { tool: "git", action: "push", atLeast: "ask" }), { sessionAllows: allowed })
                .decision,
            "ask",
            "other environment, so no",
        );
        const local = call("local", "write", { tool: "git", action: "push", atLeast: "ask" });
        assert.equal(run(local, { sessionAllows: new Set([sessionKey(local)]) }).decision, "allow");
    });

    test("do not soften a deny", () => {
        const denied = call("external", "write", { tool: "git", action: "push" });
        const verdict = run(denied, {
            rules: [{ tool: "git", decision: "deny" }],
            sessionAllows: new Set([sessionKey(denied)]),
        });
        assert.equal(verdict.decision, "deny");
    });

    test("never reach past the floor", () => {
        const prod = call("production", "write", { tool: "mongo", action: "update" });
        const verdict = run(prod, { sessionAllows: new Set([sessionKey(prod)]) });
        assert.deepEqual([verdict.decision, verdict.source], ["deny", "floor"]);
    });
});

describe("the floor", () => {
    test("a production write is always denied, whatever a rule, the tool or a session allow says", () => {
        const prod = call("production", "write", { tool: "mongo", action: "update", environment: "prod" });
        for (const extra of [
            { rules: [{ tool: "mongo", decision: "allow" } as Rule] },
            { rules: [{ tool: "*", environment: "prod", effect: "write", decision: "ask" } as Rule] },
            { sessionAllows: new Set([sessionKey(prod)]) },
            { hasUI: false },
        ]) {
            const verdict = run(prod, extra);
            assert.equal(verdict.decision, "deny", JSON.stringify(extra));
            assert.equal(verdict.source, "floor");
            assert.equal(verdict.floor, "production-write");
        }
        assert.equal(run({ ...prod, atLeast: "ask" }).decision, "deny");
    });

    test("a production read is allowed, and a rule can make it ask", () => {
        const read = call("production", "read", { environment: "prod" });
        assert.equal(run(read).decision, "allow");
        assert.equal(
            run(read, { rules: [{ tool: "tool", environment: "prod", effect: "read", decision: "ask" }] }).decision,
            "ask",
        );
    });

    test("a protected path is denied whatever a rule, the tool, a session allow or the screen says", () => {
        const refusal = "read is refused: ~/.ssh holds credentials, so the file tools neither read nor write it";
        const read = call("local", "read", { tool: "read" });
        for (const extra of [
            {},
            { rules: [{ tool: "read", decision: "allow" } as Rule] },
            { rules: [{ tool: "*", decision: "allow" } as Rule] },
            { sessionAllows: new Set([sessionKey(read)]) },
            { hasUI: false },
        ]) {
            const verdict = run(read, { ...extra, protectedRefusal: refusal });
            assert.equal(verdict.decision, "deny", JSON.stringify(extra));
            assert.equal(verdict.source, "floor");
            assert.equal(verdict.floor, "protected-path");
            assert.equal(verdict.reason, refusal, "the reason is the line that names the path");
        }
        assert.equal(run(read).decision, "allow", "and without one, the call is as before");
    });

    test("an ask with no screen becomes a deny", () => {
        for (const c of [
            call("external", "write"),
            call("test", "write"),
            call("local", "write", { atLeast: "ask" }),
            call("local", "read", { unknown: true }),
        ]) {
            const verdict = run(c, { hasUI: false });
            assert.equal(verdict.decision, "deny", JSON.stringify(c));
            assert.equal(verdict.source, "floor");
            assert.equal(verdict.floor, "no-screen");
            assert.match(verdict.reason ?? "", /no screen to ask on/);
        }
        assert.equal(
            run(call("external", "write"), { hasUI: false, rules: [{ tool: "tool", decision: "ask" }] }).decision,
            "deny",
        );
    });

    test("with no screen, a call that needs no question still runs", () => {
        assert.equal(run(call("local", "write"), { hasUI: false }).decision, "allow");
        assert.equal(run(call("external", "read"), { hasUI: false }).decision, "allow");
        assert.equal(
            run(call("external", "write"), { hasUI: false, rules: [{ tool: "tool", decision: "allow" }] }).decision,
            "allow",
        );
    });

    describe("an unknown tool", () => {
        const unknown = call("external", "write", { tool: "mystery", unknown: true });

        test("asks, and says so", () => {
            const verdict = run(unknown);
            assert.deepEqual([verdict.decision, verdict.source], ["ask", "unknown"]);
        });

        test("is not allowed by a wildcard rule", () => {
            for (const tool of ["*", "mys*", "myst*y"]) {
                const verdict = run(unknown, { rules: [{ tool, decision: "allow" }] });
                assert.equal(verdict.decision, "ask", tool);
                assert.equal(verdict.source, "floor");
                assert.equal(verdict.floor, "unknown-tool");
            }
        });

        test("is allowed by a rule that names it exactly", () => {
            const verdict = run(unknown, { rules: [{ tool: "mystery", decision: "allow" }] });
            assert.deepEqual([verdict.decision, verdict.source], ["allow", "rule"]);
        });

        test("can still be denied or asked about by a wildcard rule", () => {
            assert.equal(run(unknown, { rules: [{ tool: "*", decision: "deny" }] }).decision, "deny");
            assert.equal(run(unknown, { rules: [{ tool: "*", decision: "ask" }] }).decision, "ask");
        });

        test("is allowed for the session once the user said so", () => {
            const verdict = run(unknown, { sessionAllows: new Set([sessionKey(unknown)]) });
            assert.deepEqual([verdict.decision, verdict.source], ["allow", "session"]);
        });

        test("with a wildcard allow and no screen, is denied", () => {
            const verdict = run(unknown, { hasUI: false, rules: [{ tool: "*", decision: "allow" }] });
            assert.deepEqual([verdict.decision, verdict.floor], ["deny", "no-screen"]);
        });

        test("a known tool is not held back by a wildcard allow", () => {
            assert.equal(
                run(call("external", "write"), { rules: [{ tool: "*", decision: "allow" }] }).decision,
                "allow",
            );
        });
    });
});

describe("session keys", () => {
    test("differ by tool, action and environment, and cannot be confused by their text", () => {
        const keys = new Set([
            sessionKey({ tool: "a", action: "b", environment: "c" }),
            sessionKey({ tool: "a", environment: "c" }),
            sessionKey({ tool: "a", action: "b", environment: "d" }),
            sessionKey({ tool: "a b", environment: "c" }),
            sessionKey({ tool: "a", action: "b c", environment: "" }),
        ]);
        assert.equal(keys.size, 5);
    });
});
