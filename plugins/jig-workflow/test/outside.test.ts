// A test command set to run outside the sandbox (`outside: true`), through the real jig-core: it runs only by the `bash` tool's own
// way to do that, a nested call that jig-core asks about (or lets a rule that names the command allow, or refuses when there is no
// screen) and records, and what it proves counts at HEAD like a sandboxed run. The `bash` tool itself is a stand-in that runs only
// when jig-core lets the call through; its declaration is jig-sandbox's own, so the question the user reads is the real one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fingerprintOf } from "../src/plan.ts";
import { outsideCommand } from "../src/outside.ts";
import { commit, headOf, ok } from "./support.ts";
import { PLAN, useWorlds, world } from "./world.ts";
import type { World } from "./world.ts";

useWorlds();

const REASON = "the configured test command needs credentials the sandbox hides";

const ENTRY = { command: "./gradlew test", outside: true, env: { JAVA_HOME: "/opt/jdk-17" } };

async function started(t: Parameters<typeof world>[0], options: Parameters<typeof world>[1] = {}): Promise<World> {
    const w = await world(t, { config: { tests: { "orders-api": ENTRY } }, ...options });
    w.activate("PROJ-1");
    w.bind(w.orders);
    assert.equal((await w.call({ action: "start" })).isError, false);
    return w;
}

/** The command line the user is shown and a rule names, for the orders repository. */
const lineOf = (w: World): string => `cd ${w.orders} && export JAVA_HOME=/opt/jdk-17 && ./gradlew test`;

describe("the command line", () => {
    test("goes to the repository first, then sets the variables, then runs the command", () => {
        assert.equal(
            outsideCommand({ root: "/work/orders-api", command: "./gradlew test", env: { JAVA_HOME: "/opt/jdk" } }),
            "cd /work/orders-api && export JAVA_HOME=/opt/jdk && ./gradlew test",
        );
        assert.equal(
            outsideCommand({ root: "/work/orders-api", command: "npm test" }),
            "cd /work/orders-api && npm test",
        );
        assert.equal(
            outsideCommand({ root: "/work/my repo's", command: "make" }),
            "cd '/work/my repo'\\''s' && make",
            "a folder with a space or a quote is quoted",
        );
    });
});

describe("asked by default", () => {
    test("with a sandbox, the user is asked about this command in the bash tool's own question, and not about the workflow call", async (t) => {
        const w = await started(t);
        const result = await w.call({ action: "test" }, "wf-test");
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 1, "one question: the bash tool's");
        const question = w.asked[0];
        assert.match(question?.title ?? "", /Run outside the sandbox\? It gets your credentials and full network\./);
        assert.ok((question?.title ?? "").includes(`Command:  ${lineOf(w)}`), question?.title ?? "");
        assert.match(question?.title ?? "", /Folder: {3}/);
        assert.ok((question?.title ?? "").includes(`Why:      ${REASON}`), question?.title ?? "");
        assert.deepEqual(question?.options, ["Run once", "This exact command, this session", "No"]);
        // It ran once, as the nested call the question was about, with the plugin's reason and the repository's time limit.
        assert.deepEqual(
            w.bash.ran.map(({ id, command, reason, timeout }) => ({ id, command, reason, timeout })),
            [{ id: "wf-test/1", command: lineOf(w), reason: REASON, timeout: 900 }],
        );
        assert.deepEqual(w.host.sandboxed, [], "not in the sandbox");
        assert.deepEqual(w.host.ran, [], "and not by the plugin's own shell");
    });

    test("a no runs nothing and records nothing, and the agent is told why", async (t) => {
        const w = await started(t);
        w.answers.push("decline");
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, "the call reports a repository that could not be run, as it does for any");
        assert.match(
            result.text,
            /orders-api-PROJ-1: could not run: outside the sandbox was refused: the user declined this call/,
        );
        assert.match(result.text, /0 of 1 repository passed/);
        assert.deepEqual(w.bash.ran, []);
        assert.deepEqual(w.state()?.tests, {});
    });

    test("the answer for this session covers this exact command and no other", async (t) => {
        const w = await started(t);
        w.answers.push(1);
        await w.call({ action: "test" });
        await w.call({ action: "test" });
        assert.equal(w.asked.length, 1, "asked once for the same command");
        assert.equal(w.bash.ran.length, 2);
        // Another repository is another command line, so it asks again.
        w.bind(w.orders, w.other);
        const second = await started(t, {
            config: { tests: { "orders-api": ENTRY, unbound: { ...ENTRY, command: "make" } } },
        });
        second.bind(second.orders, second.other);
        await second.call({ action: "test" });
        assert.equal(second.asked.length, 2, "one question for each command line");
    });

    test("the model cannot choose it: the tool has no such parameter", async (t) => {
        const w = await started(t, { config: { tests: { "orders-api": "npm test" } } });
        const blocked = await w.call({ action: "test", outside: true });
        assert.equal(blocked.blocked, true);
        assert.match(blocked.reason ?? "", /workflow test does not use outside/);
        assert.deepEqual(w.bash.ran, []);
        assert.equal(w.asked.length, 0);
    });

    test("an entry without it runs in the sandbox as before, with no question", async (t) => {
        const w = await started(t, { config: { tests: { "orders-api": { command: "npm test", env: { A: "b" } } } } });
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 0);
        assert.deepEqual(w.bash.ran, []);
        assert.deepEqual(
            w.host.sandboxed.map((run) => run.command),
            ["export A=b && npm test"],
        );
        assert.equal(w.state()?.tests[w.orders].sandboxed, true);
    });

    test("another repository's entry stays in the sandbox when only one is set to run outside", async (t) => {
        const w = await started(t, {
            config: { tests: { "orders-api": ENTRY, unbound: "npm test" } },
        });
        w.bind(w.orders, w.other);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 1);
        assert.deepEqual(
            w.bash.ran.map((run) => run.command),
            [lineOf(w)],
        );
        assert.deepEqual(
            w.host.sandboxed.map((run) => [run.command, run.cwd]),
            [["npm test", w.other]],
        );
        assert.equal(w.state()?.tests[w.orders].sandboxed, false);
        assert.equal(w.state()?.tests[w.other].sandboxed, true);
        assert.match(result.text, /2 of 2 repositories passed/);
    });
});

describe("allowed by a rule that names the command", () => {
    test("no question: the rule is the user's answer in advance, and it is still the bash tool's call", async (t) => {
        const w = await started(t);
        w.core.api.config.addRules([
            {
                tool: "bash",
                action: "outside",
                command: "cd * && export JAVA_HOME=/opt/jdk-17 && ./gradlew test",
                decision: "allow",
            },
        ]);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 0);
        assert.deepEqual(
            w.bash.ran.map((run) => run.command),
            [lineOf(w)],
        );
        assert.equal(w.state()?.tests[w.orders].passed, true);
    });

    test("a rule for another command, a wildcard and a rule that does not name the action all leave the question", async (t) => {
        const w = await started(t);
        w.core.api.config.addRules([
            { tool: "bash", action: "outside", command: "docker compose *", decision: "allow" },
            { tool: "bash", decision: "allow" },
            { tool: "workflow", action: "test", decision: "allow" },
        ]);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 1, "asked: only a rule that names this command takes the question away");
    });

    test("a rule that denies it is final", async (t) => {
        const w = await started(t);
        w.core.api.config.addRules([
            {
                tool: "bash",
                action: "outside",
                command: "cd * && export JAVA_HOME=* && ./gradlew test",
                decision: "deny",
            },
        ]);
        const result = await w.call({ action: "test" });
        assert.match(result.text, /orders-api-PROJ-1: could not run: outside the sandbox was refused: /);
        assert.deepEqual(w.bash.ran, []);
        assert.equal(w.asked.length, 0);
        assert.deepEqual(w.state()?.tests, {});
    });
});

describe("with no screen to ask on", () => {
    test("it is refused: nothing runs outside, and nothing is recorded", async (t) => {
        const w = await started(t, { ui: false });
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.match(
            result.text,
            /orders-api-PROJ-1: could not run: outside the sandbox was refused: this call needs approval and there is no screen to ask on/,
        );
        assert.deepEqual(w.bash.ran, []);
        assert.deepEqual(w.state()?.tests, {});
    });

    test("a rule that names the command still allows it, as it does for bash", async (t) => {
        const w = await started(t, { ui: false });
        w.core.api.config.addRules([
            {
                tool: "bash",
                action: "outside",
                command: "cd * && export JAVA_HOME=* && ./gradlew test",
                decision: "allow",
            },
        ]);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.bash.ran.length, 1);
    });
});

describe("recorded", () => {
    test("jig-core keeps a line for the nested call: the action outside, the decision and the answer, under the workflow call", async (t) => {
        const w = await started(t);
        await w.call({ action: "test" }, "wf-test");
        const lines = w.core.records().filter((line) => line.tool === "bash");
        assert.equal(lines.length, 1);
        assert.deepEqual(
            [lines[0]?.action, lines[0]?.decision, lines[0]?.answer, lines[0]?.parentToolCallId, lines[0]?.outcome],
            ["outside", "ask", "allow", "wf-test", "ok"],
        );
    });

    test("a run a rule allowed is recorded as the rule's", async (t) => {
        const w = await started(t);
        w.core.api.config.addRules([
            {
                tool: "bash",
                action: "outside",
                command: "cd * && export JAVA_HOME=* && ./gradlew test",
                decision: "allow",
            },
        ]);
        await w.call({ action: "test" }, "wf-test");
        const lines = w.core.records().filter((line) => line.tool === "bash");
        assert.deepEqual(
            [lines[0]?.action, lines[0]?.decision, lines[0]?.decisionSource],
            ["outside", "allow", "rule"],
        );
    });

    test("the result is kept in workflow.json as run outside, against the commit", async (t) => {
        const w = await started(t);
        const result = await w.call({ action: "test" });
        assert.match(
            result.text,
            /orders-api-PROJ-1: PASSED at [0-9a-f]{7} · \.\/gradlew test · outside the sandbox, as you approved/,
        );
        const saved = w.state()?.tests[w.orders];
        assert.deepEqual(
            [saved.passed, saved.sandboxed, saved.head, saved.clean, saved.command],
            [true, false, headOf(w.orders), true, "./gradlew test"],
        );
    });
});

describe("what happens in the run", () => {
    test("a failing command is a failed result with the end of its output, and does not count", async (t) => {
        const w = await started(t);
        w.bash.script = () => ({ code: 1, output: "1 failing\n  expected 2 to be 3" });
        const result = await w.call({ action: "test" });
        assert.match(result.text, /orders-api-PROJ-1: FAILED \(exit 1\) at [0-9a-f]{7}/);
        assert.match(result.text, /expected 2 to be 3/);
        assert.equal(w.state()?.tests[w.orders].passed, false);
        assert.equal(w.state()?.tests[w.orders].sandboxed, false);
    });

    test("a command that runs out of time is a timeout, not a pass", async (t) => {
        const w = await started(t, {
            config: { tests: { "orders-api": { ...ENTRY, timeoutSeconds: 30 } } },
        });
        w.bash.script = () => ({ code: 0, output: "partial", timedOut: true });
        const result = await w.call({ action: "test" });
        assert.match(result.text, /orders-api-PROJ-1: TIMED OUT after 30 s/);
        const saved = w.state()?.tests[w.orders];
        assert.deepEqual([saved.passed, saved.timedOut, saved.exitCode], [false, true, null]);
        assert.equal(w.bash.ran[0]?.timeout, 30);
    });

    test("a tree with uncommitted changes is recorded, and never counts", async (t) => {
        const w = await started(t);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(`${w.orders}/README.md`, "edited\n");
        const result = await w.call({ action: "test" });
        assert.match(result.text, /on a tree with uncommitted changes, which does not count/);
        assert.equal(w.state()?.tests[w.orders].clean, false);
    });

    test("a command line too long to show is refused by the bash tool, and the repository is reported", async (t) => {
        const w = await started(t, {
            config: { tests: { "orders-api": { command: `echo ${"x".repeat(990)}`, outside: true } } },
        });
        const result = await w.call({ action: "test" });
        assert.match(result.text, /could not run: outside the sandbox was refused: .*too long to show in full/);
        assert.deepEqual(w.bash.ran, []);
        assert.equal(w.asked.length, 0);
    });

    test("a call that cannot run other tools says so and runs nothing", async (t) => {
        const w = await started(t);
        (w.ctx as unknown as { executeTool: unknown }).executeTool = undefined;
        const result = await w.call({ action: "test" });
        assert.match(
            result.text,
            /could not run: this test command is set to run outside the sandbox, and this call cannot run the bash tool that asks you/,
        );
        assert.deepEqual(w.bash.ran, []);
        assert.deepEqual(w.state()?.tests, {});
    });
});

describe("counts at HEAD like a sandboxed run", () => {
    function approvePlan(w: World): void {
        w.writePlan(PLAN);
        w.writeState((state) => {
            state.plan = { fingerprint: fingerprintOf(PLAN), at: "t", scenarios: 2 };
        });
    }

    test("a push is held until the run, then lets through, and a new commit holds it again", async (t) => {
        const w = await started(t);
        approvePlan(w);
        const held = await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" });
        assert.equal(held.blocked, true);
        assert.match(held.reason ?? "", /git push waits for tests-pass-at-head, which is not met/);
        assert.equal((await w.call({ action: "test" })).isError, false);
        assert.equal((await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" })).blocked, false);
        commit(w.orders);
        assert.equal((await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" })).blocked, true);
    });

    const LEAN = {
        lean: { name: "lean", stages: [{ id: "build", goal: "build", exit: ["tests-pass-at-head"] }, { id: "done" }] },
    };

    async function lean(t: Parameters<typeof world>[0]): Promise<World> {
        const w = await started(t, { workflows: LEAN });
        assert.equal((await w.call({ action: "start", name: "lean", replace: true })).isError, false);
        return w;
    }

    test("the status says it ran outside the sandbox, with your approval", async (t) => {
        const w = await lean(t);
        await w.call({ action: "test" });
        const status = await w.call({ action: "status" });
        assert.match(
            status.text,
            /orders-api-PROJ-1: passed at [0-9a-f]{7} \(run outside the sandbox, with your approval\)/,
        );
    });

    test("advance counts it, and a new commit ends it", async (t) => {
        const w = await lean(t);
        const before = await w.call({ action: "advance" });
        assert.match(before.text, /tests-pass-at-head/);
        assert.equal(w.state()?.stage, "build");
        await w.call({ action: "test" });
        commit(w.orders);
        assert.match(
            (await w.call({ action: "advance" })).text,
            /the last test run was at [0-9a-f]{7} and HEAD is [0-9a-f]{7}: run workflow test/,
        );
        await w.call({ action: "test" });
        const after = await w.call({ action: "advance" });
        assert.equal(after.isError, false, after.text);
        assert.equal(w.state()?.stage, "done");
    });
});

describe("without a sandbox that can run commands", () => {
    test("as before: the call asks once for every command, and the plugin's shell runs them; the bash tool is not used", async (t) => {
        const w = await started(t, { run: () => ok() });
        w.host.sandboxOn = false;
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 1);
        assert.match(w.asked[0]?.title ?? "", /Run the tests of PROJ-1 OUTSIDE the sandbox, as you/);
        assert.deepEqual(w.bash.ran, []);
        assert.deepEqual(
            w.host.ran.map((run) => [run.file, ...run.args]),
            [["/bin/sh", "-c", "./gradlew test"]],
        );
        assert.deepEqual(w.host.ran[0]?.env, { JAVA_HOME: "/opt/jdk-17" });
        assert.equal(w.state()?.tests[w.orders].sandboxed, false);
    });
});
