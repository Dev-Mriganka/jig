// The child's half of "a role only narrows". The verdicts are tried as data, and then in a real Pi session with the real jig-core whose
// environment holds a policy, which is what a child is: the gate reads it at start and every tool call goes through it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { GateCall } from "../../jig-core/src/contract.ts";
import { ROLE_POLICY_VARIABLE, writeRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import type { RolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { GATE_NAME, roleGate, roleVerdict } from "../src/role-gate.ts";
import { readRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { bashTool, gitTool, plainTools, sandboxOn } from "./support/tools.ts";
import { startWorld } from "./world.ts";
import type { World } from "./world.ts";

const call = (over: Partial<GateCall>): GateCall =>
    ({
        toolCallId: "c1",
        tool: "git",
        environment: "local",
        environmentKind: "local",
        effect: "read",
        decision: "allow",
        input: {},
        cwd: "/work",
        paths: [],
        ...over,
    }) as GateCall;

const policy = (over: Partial<RolePolicy> = {}): RolePolicy => ({
    role: "scout",
    writes: true,
    actions: {},
    ask: {},
    ...over,
});

describe("what the role says about a call", () => {
    test("a role that may not write refuses every write, with the role and the call in the words", () => {
        const verdict = roleVerdict(
            policy({ writes: false }),
            call({ tool: "git", action: "commit", effect: "write" }),
            true,
        );
        assert.deepEqual(verdict, {
            decision: "deny",
            reason: 'the role "scout" may not write, and git commit writes',
        });
        assert.deepEqual(
            roleVerdict(policy({ writes: false }), call({ tool: "write", effect: "write" }), true)?.decision,
            "deny",
        );
        assert.equal(roleVerdict(policy({ writes: false }), call({ tool: "git", action: "log" }), true), undefined);
    });

    test("a role that may write is not refused for writing", () => {
        assert.equal(roleVerdict(policy(), call({ tool: "git", action: "commit", effect: "write" }), false), undefined);
    });

    test("bash is the one write a read-only role may make, and only while the sandbox is active", () => {
        const readOnly = policy({ writes: false });
        const bash = call({ tool: "bash", effect: "write" });
        assert.equal(roleVerdict(readOnly, bash, true), undefined);
        assert.match(
            roleVerdict(readOnly, bash, false)?.reason ?? "",
            /bash is read-only only inside jig-sandbox, which is not active/,
        );
        // Running a command outside the sandbox is the action `outside`, and no sandbox makes that read-only.
        const outside = call({ tool: "bash", action: "outside", effect: "write" });
        assert.match(roleVerdict(readOnly, outside, true)?.reason ?? "", /may not write, and bash outside writes/);
    });

    test("a tool named in actions runs only those actions", () => {
        const only = policy({ actions: { git: ["status", "log"] } });
        assert.equal(roleVerdict(only, call({ action: "status" }), true), undefined);
        assert.equal(roleVerdict(only, call({ action: "log" }), true), undefined);
        assert.deepEqual(roleVerdict(only, call({ action: "push", effect: "write" }), true), {
            decision: "deny",
            reason: 'the role "scout" may run only git status, log; git push is not one of them',
        });
    });

    test("a tool with no action cannot satisfy a list of actions, and an empty list refuses them all", () => {
        assert.match(
            roleVerdict(policy({ actions: { git: ["status"] } }), call({}), true)?.reason ?? "",
            /git with no action is not one of them/,
        );
        assert.match(
            roleVerdict(policy({ actions: { git: [] } }), call({ action: "status" }), true)?.reason ?? "",
            /may run no action of it/,
        );
    });

    test("a tool not named in actions keeps every action", () => {
        const only = policy({ actions: { git: ["status"] } });
        assert.equal(roleVerdict(only, call({ tool: "jira", action: "transition", effect: "write" }), true), undefined);
    });

    test("tool names that are properties of every object are not found in a list", () => {
        const only = policy({ actions: { git: ["status"] } });
        for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
            assert.equal(roleVerdict(only, call({ tool, action: "x" }), true), undefined, tool);
        }
    });

    test("an action named in ask asks, and the reason names the role", () => {
        const asks = policy({ ask: { git: ["push"] } });
        assert.deepEqual(roleVerdict(asks, call({ action: "push", effect: "write" }), true), {
            decision: "ask",
            reason: 'the role "scout" asks before git push',
        });
        assert.equal(roleVerdict(asks, call({ action: "status" }), true), undefined);
        assert.equal(roleVerdict(asks, call({}), true), undefined);
    });

    test("a refusal comes before a question: an action the role may not run is refused, not asked about", () => {
        const both = policy({ writes: false, actions: { git: ["status"] }, ask: { git: ["status"] } });
        assert.equal(roleVerdict(both, call({ action: "status" }), true)?.decision, "ask");
        assert.equal(roleVerdict(both, call({ action: "push", effect: "write" }), true)?.decision, "deny");
    });
});

describe("the gate", () => {
    test("there is none without a policy, one for a policy, and one that refuses everything for a policy that cannot be read", () => {
        assert.equal(
            roleGate(readRolePolicy({}), () => true),
            undefined,
        );
        const good = roleGate(readRolePolicy({ [ROLE_POLICY_VARIABLE]: writeRolePolicy(policy()) }), () => true);
        assert.equal(good?.name, GATE_NAME);
        assert.equal(good?.plugin, "jig-agents");
        const bad = roleGate(readRolePolicy({ [ROLE_POLICY_VARIABLE]: "{no" }), () => true);
        const verdict = bad?.check(call({ tool: "read" }), new AbortController().signal);
        assert.deepEqual(verdict, {
            decision: "deny",
            reason: "this agent's role policy cannot be read (the policy is not JSON), so it may not do anything. The agent that started it must be started again",
        });
    });
});

describe("in a session that holds a policy, which is what a child is", () => {
    let w: World | undefined;
    afterEach(async () => {
        await w?.close();
        w = undefined;
    });
    const env = (value: RolePolicy | string): Record<string, string> => ({
        [ROLE_POLICY_VARIABLE]: typeof value === "string" ? value : writeRolePolicy(value),
    });

    test("a read-only role: reads run, writes are refused with the role in the words, and the record says a gate held it", async () => {
        w = await startWorld({
            repo: false,
            extensions: [gitTool, plainTools],
            env: env({ role: "scout", writes: false, actions: { git: ["status", "log"] }, ask: {} }),
        });
        const [look, poke, status, commit, push] = await w.calls([
            { name: "look", args: {} },
            { name: "poke", args: {} },
            { name: "git", args: { action: "status" } },
            { name: "git", args: { action: "commit" } },
            { name: "git", args: { action: "push" } },
        ]);
        assert.deepEqual([look?.isError, look?.text], [false, "look ran"]);
        assert.equal(status?.isError, false);
        assert.equal(poke?.isError, true);
        assert.match(poke?.text ?? "", /Blocked by jig-core: the role "scout" may not write, and poke writes/);
        assert.match(commit?.text ?? "", /Blocked by jig-core: the role "scout" may not write, and git commit writes/);
        assert.match(push?.text ?? "", /the role "scout" may not write, and git push writes/);

        const records = readdirSync(path.join(w.stateDir, "records")).flatMap((name) =>
            readFileSync(path.join(w?.stateDir ?? "", "records", name), "utf8")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as Record<string, any>),
        );
        const held = records.filter((record) => record.kind === "call" && record.tool === "poke");
        assert.equal(held.length, 1);
        assert.equal(held[0]?.decisionSource, "gate");
        assert.equal(held[0]?.decision, "deny");
        assert.match(JSON.stringify(held[0]), /held by gate role-policy/);
    });

    test("actions: an action the role may not run is refused, and the tool's other actions in the list run", async () => {
        w = await startWorld({
            repo: false,
            extensions: [gitTool],
            env: env({ role: "worker", writes: true, actions: { git: ["status", "commit"] }, ask: {} }),
        });
        const [status, log, commit, push] = await w.calls([
            { name: "git", args: { action: "status" } },
            { name: "git", args: { action: "log" } },
            { name: "git", args: { action: "commit" } },
            { name: "git", args: { action: "push" } },
        ]);
        assert.equal(status?.isError, false);
        assert.equal(commit?.isError, false);
        assert.match(log?.text ?? "", /the role "worker" may run only git status, commit; git log is not one of them/);
        assert.match(push?.text ?? "", /git push is not one of them/);
    });

    test("ask: an action that the rules allow asks, with the role in the question, and a no stops it", async () => {
        w = await startWorld({
            repo: false,
            extensions: [gitTool],
            env: env({ role: "worker", writes: true, actions: {}, ask: { git: ["commit"] } }),
            ui: { select: () => "Decline", input: () => "no" },
        });
        const [status, commit] = await w.calls([
            { name: "git", args: { action: "status" } },
            { name: "git", args: { action: "commit" } },
        ]);
        assert.equal(status?.isError, false, "an action that is not in ask runs without a question");
        assert.equal(commit?.isError, true);
        assert.equal(w.ui.selects.length, 1);
        assert.match(w.ui.selects[0]?.title ?? "", /git/);
        assert.match(
            JSON.stringify(w.ui.selects[0]),
            /Asked by role-policy: the role \\"worker\\" asks before git commit/,
        );
    });

    test('ask: a yes lets the call run, and "allow for this session" does not stop the next call asking', async () => {
        w = await startWorld({
            repo: false,
            extensions: [gitTool],
            env: env({ role: "worker", writes: true, actions: {}, ask: { git: ["commit"] } }),
            ui: { select: () => "Allow for this session" },
        });
        const first = await w.calls([{ name: "git", args: { action: "commit" } }]);
        const second = await w.calls([{ name: "git", args: { action: "commit" } }]);
        assert.equal(first[0]?.isError, false);
        assert.equal(second[0]?.isError, false);
        assert.equal(w.ui.selects.length, 2, "a gate that asks is asked again");
    });

    test("a read-only role's bash runs where there is a sandbox and is refused where there is none, and `outside` never runs", async () => {
        const read = { role: "scout", writes: false, actions: {}, ask: {} };
        w = await startWorld({ repo: false, extensions: [bashTool], env: env(read) });
        const [plain] = await w.calls([{ name: "bash", args: { command: "ls" } }]);
        assert.match(plain?.text ?? "", /bash is read-only only inside jig-sandbox, which is not active in this agent/);
        await w.close();

        w = await startWorld({ repo: false, extensions: [bashTool, sandboxOn], env: env(read) });
        const [ok, outside] = await w.calls([
            { name: "bash", args: { command: "ls" } },
            { name: "bash", args: { command: "docker ps", outside: true, reason: "the sandbox has no docker" } },
        ]);
        assert.deepEqual([ok?.isError, ok?.text], [false, "bash ran: ls"]);
        assert.equal(outside?.isError, true);
        assert.match(outside?.text ?? "", /may not write, and bash outside writes/);
        assert.equal(w.ui.selects.length, 0, "the role refused it before anyone was asked");
    });

    test("a policy that cannot be read refuses every call, even a read", async () => {
        w = await startWorld({ repo: false, extensions: [plainTools], env: env("{this is not a policy") });
        const [look, poke] = await w.calls([
            { name: "look", args: {} },
            { name: "poke", args: {} },
        ]);
        for (const result of [look, poke]) {
            assert.equal(result?.isError, true);
            assert.match(
                result?.text ?? "",
                /this agent's role policy cannot be read \(the policy is not JSON\), so it may not do anything/,
            );
        }
    });

    test("a session with no policy is not narrowed", async () => {
        w = await startWorld({ repo: false, extensions: [gitTool, plainTools] });
        const [poke, push] = await w.calls([
            { name: "poke", args: {} },
            { name: "git", args: { action: "push" } },
        ]);
        assert.equal(poke?.isError, false);
        assert.equal(push?.isError, false);
    });

    test("the gate cannot loosen: a call the rules deny stays denied under a role that allows it", async () => {
        w = await startWorld({
            repo: false,
            extensions: [plainTools],
            config: { rules: [{ tool: "poke", decision: "deny" }] },
            env: env({ role: "worker", writes: true, actions: {}, ask: {} }),
        });
        const [poke] = await w.calls([{ name: "poke", args: {} }]);
        assert.equal(poke?.isError, true);
        assert.doesNotMatch(poke?.text ?? "", /role "worker"/);
    });
});
