// The calls that always ask: a plan to approve, a stage that needs you, a switch of workflow, and tests outside the sandbox.
// Each is asked inside the waiting call, whatever a rule or an earlier "allow for this session" says, and each is refused when
// what was approved is not what would happen.
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { hash } from "../src/host.ts";
import { commit, headOf, ok } from "./support.ts";
import { PLAN, useWorlds, world } from "./world.ts";
import type { World } from "./world.ts";

useWorlds();

async function started(t: Parameters<typeof world>[0], options: Parameters<typeof world>[1] = {}): Promise<World> {
    const w = await world(t, options);
    w.activate("PROJ-1");
    w.bind(w.orders);
    assert.equal(
        (
            await w.call({
                action: "start",
                ...(options.workflows === undefined ? {} : { name: Object.keys(options.workflows)[0] }),
            })
        ).isError,
        false,
    );
    return w;
}

describe("submit-plan", () => {
    test("asks, shows the plan with its fingerprint, and records the approval of that exact text", async (t) => {
        const w = await started(t);
        w.writePlan(PLAN);
        const result = await w.call({ action: "submit-plan" });
        assert.equal(result.isError, false, result.text);
        assert.match(result.text, /The user approved the plan for PROJ-1: 2 scenarios, fingerprint [0-9a-f]{12}/);
        assert.equal(w.asked.length, 1);
        assert.match(
            w.asked[0]?.title ?? "",
            /Approve the plan for PROJ-1: 2 scenarios, repositories orders-api \(fingerprint [0-9a-f]{12}\)/,
        );
        assert.match(w.asked[0]?.title ?? "", /Asked by workflow: workflow submit-plan always asks/);
        assert.deepEqual(w.asked[0]?.options, ["Approve this plan", "Allow for this session", "Not yet"]);
        assert.equal(w.state()?.plan.scenarios, 2);
        // Then the hold on writing is released.
        assert.equal((await w.other_("write", { path: path.join(w.orders, "A.java"), content: "x" })).blocked, false);
    });

    test("a rule that allows it, and 'allow for this session', cannot stand in for the question", async (t) => {
        const w = await started(t, { config: {} });
        w.core.api.config.addRules([{ tool: "workflow", decision: "allow" }]);
        w.writePlan(PLAN);
        w.answers.push(1, 0, 0);
        for (let n = 0; n < 3; n++) assert.equal((await w.call({ action: "submit-plan" })).isError, false);
        assert.equal(w.asked.length, 3, "asked every time");
    });

    test("declining records nothing, and the agent is told", async (t) => {
        const w = await started(t);
        w.writePlan(PLAN);
        w.answers.push("decline");
        const result = await w.call({ action: "submit-plan" });
        assert.equal(result.blocked, true);
        assert.match(result.reason ?? "", /the user declined this call/);
        assert.equal(w.state()?.plan, undefined);
    });

    test("a plan edited while the question is open is not approved: changed since the preview", async (t) => {
        const w = await started(t);
        w.writePlan(PLAN);
        w.beforeAnswer = () => writeFileSync(path.join(w.ticketDir(), "plan.md"), `${PLAN}\n3. A late scenario.\n`);
        const result = await w.call({ action: "submit-plan" });
        assert.equal(result.isError, true);
        assert.match(result.text, /plan.md changed since the preview the user approved: nothing was recorded/);
        assert.equal(w.state()?.plan, undefined);
    });

    test("a plan that fails the check is refused with the problems, and nobody is asked", async (t) => {
        const w = await started(t);
        w.writePlan("## Approach\nx\n");
        const result = await w.call({ action: "submit-plan" });
        assert.equal(result.blocked, true);
        assert.match(result.reason ?? "", /plan.md cannot be submitted yet:/);
        assert.match(result.reason ?? "", /## Repositories: add the heading/);
        assert.match(result.reason ?? "", /## Scenarios: add the heading/);
        assert.equal(w.asked.length, 0);
    });

    test("a missing plan, and a ticket with no workflow, are refused without asking", async (t) => {
        const w = await started(t);
        assert.match((await w.call({ action: "submit-plan" })).reason ?? "", /plan.md is empty or missing/);
        w.activate("PROJ-2");
        assert.match((await w.call({ action: "submit-plan" })).reason ?? "", /PROJ-2 has no workflow/);
        assert.equal(w.asked.length, 0);
    });

    test("with no screen to ask on, it is denied, never approved", async (t) => {
        const w = await started(t, { ui: false });
        w.writePlan(PLAN);
        const result = await w.call({ action: "submit-plan" });
        assert.equal(result.blocked, true);
        assert.match(result.reason ?? "", /there is no screen to ask on/);
        assert.equal(w.state()?.plan, undefined);
    });

    test("a repository the plan does not name is noticed in the question", async (t) => {
        const w = await started(t);
        w.writePlan(PLAN.replace("orders-api", "billing-api"));
        await w.call({ action: "submit-plan" });
        assert.equal(w.asked.length, 1);
        // The review screen shows the body; the selector shows its first lines, with the notice at the top.
        assert.match(w.asked[0]?.title ?? "", /Noticed: the plan does not name orders-api/);
        assert.match(
            w.asked[0]?.title ?? "",
            /Noticed: the plan names billing-api, and no bound repository has that name/,
        );
    });
});

describe("advance, from a stage that needs you", () => {
    const gated = {
        gated: {
            name: "gated",
            match: { ticket: "^NOPE$" },
            stages: [{ id: "accept", goal: "Look", exit: ["notes-updated", "you-approve"] }, { id: "done" }],
        },
    };

    async function ready(t: Parameters<typeof world>[0]): Promise<World> {
        const w = await started(t, { workflows: gated });
        w.writeNotes("# notes\n");
        w.writeState((state) => {
            state.notesAtStage = "an-older-hash";
        });
        return w;
    }

    test("asks with the evidence, and moves only on yes", async (t) => {
        const w = await ready(t);
        w.answers.push(0);
        const result = await w.call({ action: "advance" });
        assert.equal(result.isError, false, result.text);
        assert.match(result.text, /Moved PROJ-1 from accept to done/);
        assert.match(w.asked[0]?.title ?? "", /Move PROJ-1 from accept to done\?/);
        assert.match(w.asked[0]?.title ?? "", /moving on from accept needs your yes/);
        assert.equal(w.state()?.stage, "done");
        assert.equal(w.state()?.history.at(-1).event, "advance");
    });

    test("no moves the work nowhere, and a rule or a session answer cannot say yes for you", async (t) => {
        const w = await ready(t);
        w.answers.push("decline");
        assert.equal((await w.call({ action: "advance" })).blocked, true);
        assert.equal(w.state()?.stage, "accept");
        w.core.api.config.addRules([{ tool: "workflow", decision: "allow" }]);
        w.answers.push(1);
        await w.call({ action: "advance" });
        w.writeState((state) => {
            state.stage = "accept";
        });
        w.answers.push("decline");
        assert.equal((await w.call({ action: "advance" })).blocked, true, "asked again after a session answer");
    });

    test("nobody is asked while something else is missing: the call is refused with what is missing", async (t) => {
        const w = await started(t, { workflows: gated });
        w.writeNotes("# notes\n");
        w.writeState((state) => {
            state.notesAtStage = hash("# notes\n");
        });
        const result = await w.call({ action: "advance" });
        assert.equal(result.blocked, true);
        assert.match(
            result.reason ?? "",
            /cannot move on from accept yet:[\s\S]*notes-updated[\s\S]*has not changed since the stage accept began/,
        );
        assert.equal(w.asked.length, 0);
    });

    test("a condition that stops holding between the question and the answer: not moved", async (t) => {
        const w = await ready(t);
        // The question was about notes that differed; before the answer they are back to what they were at the stage's start.
        w.beforeAnswer = () => {
            w.writeState((state) => {
                state.notesAtStage = hash("# notes\n");
            });
        };
        const result = await w.call({ action: "advance" });
        assert.equal(result.isError, false, result.text);
        assert.match(result.text, /Not moved: PROJ-1 stays at accept\. Missing:[\s\S]*notes-updated/);
        assert.equal(w.state()?.stage, "accept");
    });

    test("evidence that changes but still holds does not ride on the yes: the question was about other lines", async (t) => {
        const tested = {
            tested: {
                name: "tested",
                match: { ticket: "^NOPE$" },
                stages: [{ id: "ship", exit: ["tests-pass-at-head", "you-approve"] }, { id: "done" }],
            },
        };
        const w = await started(t, { workflows: tested });
        const pass = () =>
            w.writeState((state) => {
                state.tests[w.orders] = {
                    head: headOf(w.orders),
                    clean: true,
                    passed: true,
                    command: "npm test",
                    exitCode: 0,
                    timedOut: false,
                    sandboxed: true,
                    at: "t",
                    durationMs: 1,
                };
            });
        pass();
        w.beforeAnswer = () => {
            commit(w.orders);
            pass();
        };
        const result = await w.call({ action: "advance" });
        assert.equal(result.isError, true, result.text);
        assert.match(
            result.text,
            /the evidence changed since the user was asked, so their yes does not cover this move\. Nothing was changed/,
        );
        assert.equal(w.state()?.stage, "ship");
    });
});

describe("start, over a workflow that has state", () => {
    test("refuses without replace, listing what would be lost", async (t) => {
        const w = await started(t);
        const result = await w.call({ action: "start" });
        assert.equal(result.isError, true);
        assert.match(
            result.text,
            /PROJ-1 already runs feature at stage understand\. Starting feature loses the stage \(understand\)/,
        );
        assert.match(result.text, /To switch, call start again with replace: true; it asks the user/);
    });

    test("with replace it asks, keeps the old state in the history folder, and starts again", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.plan = { fingerprint: "f", at: "t", scenarios: 2 };
        });
        const result = await w.call({ action: "start", replace: true });
        assert.equal(result.isError, false, result.text);
        assert.match(w.asked[0]?.title ?? "", /loses the stage \(understand\), the plan approval/);
        assert.deepEqual(w.asked[0]?.options, ["Replace it", "Allow for this session", "Keep it"]);
        const archived = readdirSync(path.join(w.ticketDir(), "workflow-history"));
        assert.equal(archived.length, 1);
        assert.match(archived[0] ?? "", /-feature\.json$/);
        assert.equal(w.state()?.plan, undefined, "the new state starts empty");
    });

    test("declining keeps everything", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "plan";
        });
        w.answers.push("decline");
        const result = await w.call({ action: "start", replace: true });
        assert.equal(result.blocked, true);
        assert.equal(w.state()?.stage, "plan");
        assert.equal(existsSync(path.join(w.ticketDir(), "workflow-history")), false);
    });

    test("replace on a ticket with nothing to replace asks nothing more than the dialog, and just starts", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        const result = await w.call({ action: "start", replace: true });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.state()?.stage, "understand");
    });
});

describe("test, where there is no sandbox", () => {
    const script = () => ok();

    async function bare(t: Parameters<typeof world>[0]): Promise<World> {
        const w = await started(t, { run: script, config: { tests: { "orders-api": "npm test" } } });
        w.host.sandboxOn = false;
        return w;
    }

    test("asks, naming each command and where it runs, and runs it as a shell on yes", async (t) => {
        const w = await bare(t);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 1);
        assert.match(w.asked[0]?.title ?? "", /Run the tests of PROJ-1 OUTSIDE the sandbox, as you/);
        assert.match(w.asked[0]?.title ?? "", /- orders-api-PROJ-1: npm test/);
        assert.deepEqual(w.asked[0]?.options, ["Run them once", "Allow for this session", "No"]);
        assert.deepEqual(
            w.host.ran.map((run) => [run.file, ...run.args]),
            [["/bin/sh", "-c", "npm test"]],
        );
        assert.match(result.text, /outside the sandbox, as you approved/);
        assert.equal(w.state()?.tests[w.orders].sandboxed, false);
        assert.equal(w.state()?.tests[w.orders].head, headOf(w.orders));
    });

    test("the question names the variables the commands run with, and the shell gets them", async (t) => {
        const w = await started(t, {
            run: script,
            config: { tests: { "orders-api": { command: "npm test", env: { JAVA_HOME: "/opt/jdk-17" } } } },
        });
        w.host.sandboxOn = false;
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.match(
            w.asked[0]?.title ?? "",
            /- orders-api-PROJ-1: npm test\n {4}in .*\n {4}with JAVA_HOME=\/opt\/jdk-17/,
        );
        assert.deepEqual(w.host.ran[0]?.env, { JAVA_HOME: "/opt/jdk-17" });
    });

    test("an allow rule and a session answer do not remove the question", async (t) => {
        const w = await bare(t);
        w.core.api.config.addRules([{ tool: "workflow", action: "test", decision: "allow" }]);
        w.answers.push(1, 0);
        await w.call({ action: "test" });
        await w.call({ action: "test" });
        assert.equal(w.asked.length, 2);
    });

    test("no: nothing runs", async (t) => {
        const w = await bare(t);
        w.answers.push("decline");
        assert.equal((await w.call({ action: "test" })).blocked, true);
        assert.deepEqual(w.host.ran, []);
        assert.deepEqual(w.state()?.tests, {});
    });

    test("with no screen it is denied: tests never run outside the sandbox unseen", async (t) => {
        const w = await started(t, { run: script, ui: false, config: { tests: { "orders-api": "npm test" } } });
        w.host.sandboxOn = false;
        const result = await w.call({ action: "test" });
        assert.equal(result.blocked, true);
        assert.match(result.reason ?? "", /no screen/);
        assert.deepEqual(w.host.ran, []);
    });

    test("a commit between the question and the answer is not approved: the tests are of another commit", async (t) => {
        const w = await bare(t);
        w.answers.push(0);
        const answer = w.answers.shift.bind(w.answers);
        w.answers.shift = () => {
            commit(w.orders);
            return answer();
        };
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, true);
        assert.match(
            result.text,
            /the commands or the commits changed since the user approved running them outside the sandbox\. Nothing was run/,
        );
        assert.deepEqual(w.host.ran, []);
    });

    test("a repository with no test command is refused before anyone is asked, naming what to set", async (t) => {
        const w = await started(t, { run: script });
        w.host.sandboxOn = false;
        const result = await w.call({ action: "test" });
        assert.equal(result.blocked, true);
        assert.match(
            result.reason ?? "",
            /no test command is known for orders-api-PROJ-1: set workflow.tests in jig.json/,
        );
        assert.equal(w.asked.length, 0);
    });
});

describe("test, in the sandbox", () => {
    test("runs without a question, and records the result against HEAD", async (t) => {
        const w = await started(t, {
            config: { tests: { "orders-api": { command: "./gradlew test", timeoutSeconds: 120 } } },
        });
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 0);
        assert.deepEqual(w.host.sandboxed, [{ command: "./gradlew test", cwd: w.orders, timeoutMs: 120_000 }]);
        assert.deepEqual(w.host.ran, []);
        assert.match(result.text, /orders-api-PROJ-1: PASSED at [0-9a-f]{7} · .\/gradlew test · in the sandbox/);
        assert.match(result.text, /1 of 1 repository passed at HEAD on a clean tree\./);
        const saved = w.state()?.tests[w.orders];
        assert.equal(saved.passed, true);
        assert.equal(saved.sandboxed, true);
        assert.equal(saved.head, headOf(w.orders));
    });

    test("variables of the entry go with the command into the sandbox, and the record is of the configured command", async (t) => {
        const w = await started(t, {
            config: {
                tests: { "orders-api": { command: "./gradlew test", env: { JAVA_HOME: "/opt/jdk-17" } } },
            },
        });
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, false, result.text);
        assert.equal(w.asked.length, 0);
        assert.deepEqual(
            w.host.sandboxed.map((run) => run.command),
            ["export JAVA_HOME=/opt/jdk-17 && ./gradlew test"],
        );
        assert.equal(w.state()?.tests[w.orders].command, "./gradlew test");
        assert.equal(w.state()?.tests[w.orders].passed, true);
    });

    test("a sandbox that goes away between the classification and the run is not an unasked run", async (t) => {
        const w = await started(t, { config: { tests: { "orders-api": "npm test" } } });
        // The gate saw a sandbox and let the call through without asking; by the time the tool runs, there is none.
        const real = w.host.sandbox.canRun;
        let calls = 0;
        w.host.sandbox.canRun = () => (++calls === 1 ? real() : false);
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, true);
        assert.match(result.text, /the user was not asked to run these tests outside it\. Nothing was run/);
        assert.deepEqual(w.host.ran, []);
    });

    test("a failing run says so, with the end of the output, and does not satisfy the condition", async (t) => {
        const w = await started(t, {
            config: { tests: { "orders-api": "npm test" } },
            run: undefined,
        });
        w.host.sandbox.run = async (command, options) => {
            w.host.sandboxed.push({ command, cwd: options.cwd });
            return { code: 1, output: "1 failing\n  expected 2 to be 3\n", timedOut: false, truncated: false };
        };
        const result = await w.call({ action: "test" });
        assert.match(result.text, /FAILED \(exit 1\) at [0-9a-f]{7}/);
        assert.match(result.text, /expected 2 to be 3/);
        assert.match(result.text, /0 of 1 repository passed/);
        assert.equal(w.state()?.tests[w.orders].passed, false);
    });

    test("repo limits the run to one bound repository, and an unbound name is refused", async (t) => {
        const w = await started(t, { config: { tests: { "*": "npm test" } } });
        w.bind(w.orders, w.other);
        const one = await w.call({ action: "test", repo: "unbound" });
        assert.deepEqual(
            w.host.sandboxed.map((run) => run.cwd),
            [w.other],
        );
        assert.match(one.text, /^unbound: PASSED/);
        const bad = await w.call({ action: "test", repo: "nope" });
        assert.equal(bad.isError, true);
        assert.match(bad.text, /is not bound to PROJ-1; bound: orders-api-PROJ-1, unbound/);
    });

    test("nothing bound: refused, naming the way to bind", async (t) => {
        const w = await world(t, { config: { tests: { "*": "npm test" } } });
        w.activate("PROJ-1");
        await w.call({ action: "start" });
        const result = await w.call({ action: "test" });
        assert.equal(result.isError, true);
        assert.match(result.text, /no repository is bound to PROJ-1: bind one with workflow bind/);
    });

    test("a cancelled call stops, and a repository that cannot be run does not stop the others", async (t) => {
        const w = await started(t, { config: { tests: { "*": "npm test" } } });
        w.bind(w.orders, w.other);
        let first = true;
        w.host.sandbox.run = async (_command, options) => {
            if (first) {
                first = false;
                throw new Error("the sandbox broker failed");
            }
            w.host.sandboxed.push({ command: "npm test", cwd: options.cwd });
            return { code: 0, output: "", timedOut: false, truncated: false };
        };
        const result = await w.call({ action: "test" });
        assert.match(result.text, /orders-api-PROJ-1: could not run: the sandbox broker failed/);
        assert.match(result.text, /unbound: PASSED/);
        assert.match(result.text, /1 of 2 repositories passed/);
    });
});
