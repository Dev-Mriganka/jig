// The policy a role gives its child: written once by jig-agents, read by jig-agents' gate in the child and by jig-sandbox. One parser,
// so the two readers cannot disagree, and anything that is not a policy is "unreadable" and never "absent".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkRolePolicy, readRolePolicy, ROLE_POLICY_VARIABLE, writeRolePolicy } from "../src/kit/role-policy.ts";
import type { RolePolicy } from "../src/kit/role-policy.ts";

const policy: RolePolicy = {
    role: "scout",
    writes: false,
    actions: { git: ["status", "log"] },
    ask: { git: ["push"] },
};
const env = (text: string): Record<string, string> => ({ [ROLE_POLICY_VARIABLE]: text });

describe("the variable", () => {
    test("is JIG_ROLE_POLICY", () => {
        assert.equal(ROLE_POLICY_VARIABLE, "JIG_ROLE_POLICY");
    });

    test("a policy written is the policy read", () => {
        assert.deepEqual(readRolePolicy(env(writeRolePolicy(policy))), { kind: "policy", policy });
    });

    test("is absent only when the variable is not set; an empty one is unreadable", () => {
        assert.deepEqual(readRolePolicy({}), { kind: "absent" });
        assert.deepEqual(readRolePolicy({ OTHER: "x" }), { kind: "absent" });
        assert.equal(readRolePolicy(env("")).kind, "unreadable");
    });

    test("actions and ask may be left out, and a repeated action counts once", () => {
        const text = JSON.stringify({ v: 1, role: "worker", writes: true, actions: { git: ["status", "status"] } });
        assert.deepEqual(readRolePolicy(env(text)), {
            kind: "policy",
            policy: { role: "worker", writes: true, actions: { git: ["status"] }, ask: {} },
        });
    });

    test("an empty list of actions is a policy: the tool runs none", () => {
        const text = JSON.stringify({ v: 1, role: "r", writes: false, actions: { git: [] } });
        assert.deepEqual((readRolePolicy(env(text)) as { policy: RolePolicy }).policy.actions, { git: [] });
    });
});

describe("what is unreadable", () => {
    const bad = (value: unknown): string => {
        const read = readRolePolicy(env(typeof value === "string" ? value : JSON.stringify(value)));
        assert.equal(read.kind, "unreadable", JSON.stringify(value));
        return (read as { problem: string }).problem;
    };

    test("text that is not JSON, and JSON that is not an object", () => {
        assert.match(bad("{not json"), /not JSON/);
        assert.match(bad("[]"), /must be a JSON object/);
        assert.match(bad("null"), /must be a JSON object/);
        assert.match(bad("7"), /must be a JSON object/);
    });

    test("another version, an unknown field, a missing or wrong role or writes", () => {
        assert.match(bad({ v: 2, role: "r", writes: false }), /version 2/);
        assert.match(bad({ role: "r", writes: false }), /version undefined/);
        assert.match(bad({ v: 1, role: "r", writes: false, extra: 1 }), /unknown field "extra"/);
        assert.match(bad({ v: 1, writes: false }), /role's name/);
        assert.match(bad({ v: 1, role: "bad name", writes: false }), /role's name/);
        assert.match(bad({ v: 1, role: "r" }), /writes must be true or false/);
        assert.match(bad({ v: 1, role: "r", writes: "no" }), /writes must be true or false/);
    });

    test("an actions or ask value of the wrong shape, or with names that are not names", () => {
        assert.match(bad({ v: 1, role: "r", writes: false, actions: [] }), /actions must be an object/);
        assert.match(bad({ v: 1, role: "r", writes: false, actions: { git: "status" } }), /actions.git must be a list/);
        assert.match(bad({ v: 1, role: "r", writes: false, actions: { git: [5] } }), /not a name/);
        assert.match(bad({ v: 1, role: "r", writes: false, actions: { git: ["a b"] } }), /not a name/);
        assert.match(bad({ v: 1, role: "r", writes: false, ask: { "bad tool": ["x"] } }), /not a tool name/);
        assert.match(bad({ v: 1, role: "r", writes: false, ask: { git: "push" } }), /ask.git must be a list/);
    });

    test("a policy longer than 32 KiB", () => {
        assert.match(bad(`{"v":1,${" ".repeat(33_000)}}`), /longer than 32 KiB/);
    });

    test("checkRolePolicy gives the policy or the problem as text", () => {
        assert.deepEqual(checkRolePolicy({ v: 1, role: "r", writes: false }), {
            role: "r",
            writes: false,
            actions: {},
            ask: {},
        });
        assert.equal(typeof checkRolePolicy({ v: 3 }), "string");
    });
});
