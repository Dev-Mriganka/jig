// The actions of the `workflow` tool, through the real jig-core: listing, status, starting, binding, scenarios, advancing and
// going back. The ones that ask are in asks.test.ts, and the holds in gate.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { hash } from "../src/host.ts";
import { fingerprintOf, parsePlan } from "../src/plan.ts";
import { headOf, ok, PASSED, prJson } from "./support.ts";
import { PLAN, useWorlds, world } from "./world.ts";
import type { World } from "./world.ts";

useWorlds();

async function started(t: Parameters<typeof world>[0], options: Parameters<typeof world>[1] = {}): Promise<World> {
    const w = await world(t, options);
    w.activate("PROJ-1");
    w.bind(w.orders);
    const result = await w.call({ action: "start" });
    assert.equal(result.isError, false, result.text);
    return w;
}

function approvePlan(w: World): void {
    w.writePlan(PLAN);
    w.writeState((state) => {
        state.plan = { fingerprint: fingerprintOf(PLAN), at: "t", scenarios: 2 };
    });
}

describe("input that is not valid is refused before anyone is asked", () => {
    test("an unknown action, a parameter the action does not use, and a missing one", async (t) => {
        const w = await world(t);
        assert.match(
            (await w.call({ action: "deploy" })).text,
            /workflow: unknown action "deploy"; use one of list, status, start/,
        );
        assert.match((await w.call({ action: "list", ticket: "PROJ-1" })).text, /workflow list does not use ticket/);
        assert.match((await w.call({ action: "scenario", number: 1 })).text, /workflow scenario needs result/);
        assert.match((await w.call({ action: "bind" })).text, /workflow bind needs repo/);
        assert.equal(w.asked.length, 0);
    });

    test("a pass without evidence, and evidence of two kinds", async (t) => {
        const w = await world(t);
        assert.match((await w.call({ action: "scenario", number: 1, result: "pass" })).text, /a pass needs evidence/);
        assert.match(
            (await w.call({ action: "scenario", number: 1, result: "pass", evidence: { path: "a", text: "b" } })).text,
            /evidence needs exactly one of path, toolResult or text/,
        );
    });

    test("reads are reads and everything else is a local write", async (t) => {
        const w = await world(t);
        await w.call({ action: "list" });
        await w.call({ action: "status" });
        const records = w.core.records().filter((record) => record.tool === "workflow");
        assert.deepEqual(
            records.map((r) => [r.action, r.effect, r.environment]),
            [
                ["list", "read", "local"],
                ["status", "read", "local"],
            ],
        );
    });
});

describe("list", () => {
    test("each workflow with its stages, its pattern and the file it came from", async (t) => {
        const w = await world(t);
        const result = await w.call({ action: "list" });
        assert.match(result.text, /^feature: A change to a service, from plan to acceptance on staging/);
        assert.match(result.text, /stages: understand → plan → build → review → deliver → accept → done/);
        assert.match(result.text, /matches tickets: \^PROJ-\\d\+\$/);
        assert.match(
            result.text,
            new RegExp(`from the configured: ${w.workflows.replace(/[.\\/]/g, "\\$&")}/feature.json`),
        );
    });

    test("a file that failed is listed with its path and reason, and the rest still load", async (t) => {
        const w = await world(t, { workflows: { broken: { name: "broken", stages: [] } } });
        const result = await w.call({ action: "list" });
        assert.match(result.text, /Files that could not be used:/);
        assert.match(result.text, /broken.json: stages: must be a list with at least one stage/);
        assert.match(result.text, /^feature:/);
    });

    test("with no workflow it says where to put one", async (t) => {
        const w = await world(t);
        writeFileSync(path.join(w.workflows, "feature.json"), "{}");
        await w.command("reload");
        const result = await w.call({ action: "list" });
        assert.match(result.text, /No workflow is defined\. Put a JSON file in ~\/\.pi\/agent\/workflows\//);
    });
});

describe("start", () => {
    test("by the pattern the ticket matches, with the stage, its goal and what leaves it", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        const result = await w.call({ action: "start" });
        assert.match(result.text, /^Started feature on PROJ-1\./);
        assert.match(result.text, /Stage 1 of 7: understand\./);
        assert.match(result.text, /Goal: Read the ticket and the code, and write what you learn in the notes/);
        assert.match(result.text, /To leave it: notes-updated\./);
        assert.match(
            result.text,
            /Held until their condition holds: git commit, git push, write, edit until plan-approved; git push until tests-pass-at-head\./,
        );
        const state = w.state();
        assert.equal(state?.workflow, "feature");
        assert.equal(state?.stage, "understand");
        assert.equal(state?.notesAtStage, hash(""));
        assert.equal(state?.history[0].event, "start");
    });

    test("a ticket that is not the session's active one is started, with a note that its holds do not apply here", async (t) => {
        const w = await world(t);
        w.activate("PROJ-2");
        const result = await w.call({ action: "start", ticket: "PROJ-1" });
        assert.match(
            result.text,
            /PROJ-1 is not this session's active ticket, so its holds do not apply here: \/ticket PROJ-1 makes it active/,
        );
    });

    test("it says when notes.md is not there yet, and the notes hash is taken when they are", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        assert.match((await w.call({ action: "start" })).text, /notes.md does not exist yet: \/ticket PROJ-1 creates/);
        const second = await world(t);
        second.activate("PROJ-1");
        second.writeNotes("# notes\n");
        const result = await second.call({ action: "start" });
        assert.doesNotMatch(result.text, /notes.md does not exist/);
        assert.equal(second.state()?.notesAtStage, hash("# notes\n"));
    });

    test("naming the workflow, and the ways it goes wrong", async (t) => {
        const w = await world(t, {
            workflows: {
                bugfix: { name: "bugfix", match: { ticket: "^PROJ-\\d+$" }, stages: [{ id: "fix" }] },
                other: { name: "other", stages: [{ id: "one" }] },
            },
        });
        w.activate("PROJ-1");
        const both = await w.call({ action: "start" });
        assert.match(both.text, /bugfix and feature both match PROJ-1: name one/);
        const unknown = await w.call({ action: "start", name: "nope" });
        assert.match(unknown.text, /no workflow is called "nope" \(bugfix, feature, other\)/);
        const none = await w.call({ action: "start", ticket: "ABC-9" });
        assert.match(none.text, /no workflow matches ABC-9: name one\. bugfix, feature, other/);
        assert.equal((await w.call({ action: "start", name: "other" })).isError, false);
        assert.equal(w.state()?.workflow, "other");
    });

    test("without a ticket, or with a name that is no ticket", async (t) => {
        const w = await world(t);
        assert.match(
            (await w.call({ action: "start", name: "feature" })).text,
            /there is no active ticket: make one active with \/ticket KEY/,
        );
        assert.match((await w.call({ action: "start", ticket: "../x" })).text, /is not a ticket key/);
    });

    test("the state file is guarded: Pi's file tools refuse to write it", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        await w.call({ action: "start" });
        const state = path.join(w.ticketDir(), "workflow.json");
        const refused = await w.other_("write", { path: state, content: "{}" });
        assert.equal(refused.blocked, true);
        assert.match(refused.reason ?? "", /is guarded: the file tools can read it but not write it/);
        assert.ok(w.core.api.protectedPaths.list().some((entry) => entry.path === state && entry.kind === "guarded"));
    });
});

describe("status", () => {
    test("a ticket without a workflow says which one matches it", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        const result = await w.call({ action: "status" });
        assert.match(result.text, /^PROJ-1: no workflow has been started\. feature matches it: workflow start feature/);
    });

    test("the stage, its goal, each exit condition with what is missing, the holds, and the repositories", async (t) => {
        const w = await started(t);
        const result = await w.call({ action: "status" });
        assert.match(result.text, /^PROJ-1 · feature · stage 1 of 7: understand\nGoal: Read the ticket/);
        assert.match(result.text, /To leave this stage:\n {2}notes-updated: NOT MET\n {4}notes.md does not exist yet/);
        assert.match(
            result.text,
            /Held until their condition holds:\n {2}git commit, git push, write, edit until plan-approved/,
        );
        assert.match(
            result.text,
            new RegExp(
                `Repositories:\\n {2}orders-api-PROJ-1 \\(${w.orders.replace(/[.\\/]/g, "\\$&")}\\) on main at [0-9a-f]{7}, tree clean`,
            ),
        );
    });

    test("a condition that is met says so, and leaves the holds list as the plan allows", async (t) => {
        const w = await started(t);
        w.writeNotes("# notes\nlearned something\n");
        approvePlan(w);
        const result = await w.call({ action: "status" });
        assert.match(result.text, /notes-updated: met\n {4}notes.md changed since the stage began/);
        assert.match(result.text, /Held until their condition holds:\n {2}git push until tests-pass-at-head/);
        assert.doesNotMatch(result.text, /until plan-approved/);
    });

    test("an uncommitted change is mentioned, and a ticket that is not active gets a note", async (t) => {
        const w = await started(t);
        writeFileSync(path.join(w.orders, "scratch.txt"), "x");
        assert.match((await w.call({ action: "status" })).text, /tree has uncommitted changes/);
        w.activate("PROJ-2");
        const other = await w.call({ action: "status", ticket: "PROJ-1" });
        assert.match(other.text, /Note: PROJ-1 is not this session's active ticket, so its holds do not apply here/);
    });

    test("without a ticket: the session's own work in full, and other active work in a line each", async (t) => {
        const w = await started(t);
        w.activate("PROJ-2");
        mkdirSync(w.ticketDir("PROJ-2"), { recursive: true });
        const other = await w.call({ action: "start", ticket: "PROJ-2" });
        assert.equal(other.isError, false);
        w.activate("PROJ-3");
        const result = await w.call({ action: "status" });
        assert.match(result.text, /^PROJ-3: no workflow has been started\./);
        assert.match(
            result.text,
            /Other active work:\n {2}PROJ-1: feature, stage understand\n {2}PROJ-2: feature, stage understand/,
        );
    });

    test("no ticket, no work", async (t) => {
        const w = await world(t);
        assert.match((await w.call({ action: "status" })).text, /No active ticket, and no workflow is running/);
    });

    test("work that is done is not 'active'", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "done";
        });
        w.activate(undefined);
        assert.match((await w.call({ action: "status" })).text, /No active ticket, and no workflow is running/);
    });

    test("a stage the workflow no longer has says how to get out", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "retired";
        });
        const result = await w.call({ action: "status" });
        assert.match(result.text, /has no stage retired any more.*workflow back, to=<stage>.*understand, plan, build/);
        assert.match((await w.call({ action: "advance" })).text, /no longer has/);
        assert.equal(
            (await w.call({ action: "back", to: "plan" })).isError,
            true,
            "plan is not before a stage that is not there",
        );
    });

    test("the pull request is read now, and a failing gh is a reason, not a failure of status", async (t) => {
        const custom = {
            prs: {
                name: "prs",
                stages: [{ id: "deliver", exit: ["pull-request-open", "checks-pass"] }, { id: "done" }],
            },
        };
        const w = await world(t, { workflows: custom, run: () => ok("", 4, "gh auth login") });
        w.activate("PROJ-1");
        w.bind(w.orders);
        await w.call({ action: "start", name: "prs" });
        const result = await w.call({ action: "status" });
        assert.equal(result.isError, false);
        assert.match(
            result.text,
            /pull-request-open: NOT MET\n {4}orders-api-PROJ-1: cannot read the pull request \(gh auth login\)/,
        );
        assert.match(result.text, /checks-pass: NOT MET/);
    });
});

describe("bind", () => {
    test("asks the git tool for a worktree on the work's branch, and binds it", async (t) => {
        const w = await started(t);
        const result = await w.call({ action: "bind", repo: "unbound" });
        assert.equal(result.isError, false, result.text);
        assert.deepEqual(w.executed, [
            {
                name: "git",
                args: {
                    action: "worktree",
                    operation: "add",
                    repo: "unbound",
                    dir: "unbound-PROJ-1",
                    branch: "feature/PROJ-1",
                },
            },
        ]);
        const bound = path.join(w.workspace, "unbound-PROJ-1");
        assert.match(
            result.text,
            new RegExp(`Bound ${bound.replace(/[.\\/]/g, "\\$&")} to PROJ-1, on the branch feature/PROJ-1`),
        );
        const saved = JSON.parse(
            (await import("node:fs")).readFileSync(path.join(w.ticketDir(), "ticket.json"), "utf8"),
        ) as { repositories: string[] };
        assert.deepEqual(saved.repositories, [w.orders, bound]);
        // The new repository is in the work: a hold applies there.
        assert.equal((await w.other_("write", { path: path.join(bound, "A.java"), content: "x" })).blocked, true);
    });

    test("the folder name and the base can be given", async (t) => {
        const w = await started(t);
        await w.call({ action: "bind", repo: w.other, dir: "scratch", base: "develop" });
        assert.deepEqual(w.executed[0]?.args, {
            action: "worktree",
            operation: "add",
            repo: w.other,
            dir: "scratch",
            branch: "feature/PROJ-1",
            base: "develop",
        });
    });

    test("a workflow's branch template, and a folder name git would refuse", async (t) => {
        const w = await world(t, {
            workflows: {
                fixes: {
                    name: "fixes",
                    match: { ticket: "^FIX" },
                    branch: "fix/{ticket}-work",
                    stages: [{ id: "one" }],
                },
            },
        });
        w.activate("PROJ-1");
        await w.call({ action: "start", name: "fixes" });
        await w.call({ action: "bind", repo: "unbound" });
        assert.equal(w.executed[0]?.args.branch, "fix/PROJ-1-work");
        assert.match(
            (await w.call({ action: "bind", repo: "unbound", dir: "../escape" })).text,
            /dir "..\/escape" must be one folder name/,
        );
    });

    test("a repository the git tool cannot branch is an error with git's words, and nothing is bound", async (t) => {
        const w = await started(t);
        (w.ctx as unknown as { executeTool: unknown }).executeTool = async () => ({
            toolCall: { id: "x", name: "git", arguments: {} },
            result: { content: [{ type: "text", text: 'repo "nope" not found in /workspace' }] },
            isError: true,
        });
        const result = await w.call({ action: "bind", repo: "nope" });
        assert.equal(result.isError, true);
        assert.match(result.text, /git could not add the work tree: repo "nope" not found/);
        assert.match(
            (await import("node:fs")).readFileSync(path.join(w.ticketDir(), "ticket.json"), "utf8"),
            /orders-api-PROJ-1/,
        );
    });

    test("needs a started workflow, and a context that can run the git tool", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        assert.match((await w.call({ action: "bind", repo: "unbound" })).text, /PROJ-1 has no workflow/);
        await w.call({ action: "start" });
        (w.ctx as unknown as { executeTool: unknown }).executeTool = undefined;
        assert.match((await w.call({ action: "bind", repo: "unbound" })).text, /bind needs to run the git tool/);
    });
});

describe("scenario", () => {
    test("needs the plan to be approved as it stands", async (t) => {
        const w = await started(t);
        w.writePlan(PLAN);
        const result = await w.call({ action: "scenario", number: 1, result: "fail" });
        assert.match(result.text, /the plan is not approved as it stands: run workflow submit-plan first/);
    });

    test("a pass with what was observed", async (t) => {
        const w = await started(t);
        approvePlan(w);
        const result = await w.call({
            action: "scenario",
            number: 1,
            result: "pass",
            evidence: { text: "Two GETs, one query in the log." },
        });
        assert.equal(result.isError, false, result.text);
        assert.match(
            result.text,
            /Recorded scenario 1 of PROJ-1 as pass \(evidence: text Two GETs, one query in the log\.\)\. 1 of 2 scenarios pass\./,
        );
        const saved = w.state()?.scenarios["1"];
        assert.equal(saved.result, "pass");
        assert.equal(saved.hash, parsePlan(PLAN).scenarios[0]?.hash);
        assert.deepEqual(saved.evidence, { kind: "text", ref: "Two GETs, one query in the log." });
    });

    test("a fail needs no evidence, and a later pass replaces it", async (t) => {
        const w = await started(t);
        approvePlan(w);
        await w.call({ action: "scenario", number: 2, result: "fail" });
        assert.equal(w.state()?.scenarios["2"].result, "fail");
        await w.call({ action: "scenario", number: 2, result: "pass", evidence: { text: "now it shows at once" } });
        assert.equal(w.state()?.scenarios["2"].result, "pass");
    });

    test("evidence that is a file in the ticket folder: it must exist, have content and stay inside", async (t) => {
        const w = await started(t);
        approvePlan(w);
        mkdirSync(path.join(w.ticketDir(), "evidence"), { recursive: true });
        writeFileSync(path.join(w.ticketDir(), "evidence", "accept-1.png"), "png bytes");
        writeFileSync(path.join(w.ticketDir(), "evidence", "empty.png"), "");
        writeFileSync(path.join(w.workspace, "outside.txt"), "x");
        symlinkSync(path.join(w.workspace, "outside.txt"), path.join(w.ticketDir(), "evidence", "link.txt"));
        const record = (file: string) =>
            w.call({ action: "scenario", number: 1, result: "pass", evidence: { path: file } });
        const good = await record("evidence/accept-1.png");
        assert.equal(good.isError, false, good.text);
        assert.deepEqual(w.state()?.scenarios["1"].evidence, { kind: "path", ref: "evidence/accept-1.png" });
        assert.match((await record("evidence/missing.png")).text, /does not exist in the ticket folder/);
        assert.match((await record("evidence/empty.png")).text, /is not a file with content/);
        assert.match((await record("../../outside.txt")).text, /is not inside the ticket folder/);
        assert.match((await record("evidence/link.txt")).text, /is not inside the ticket folder/, "a link out is out");
        assert.match((await record("evidence")).text, /is not a file with content/);
    });

    test("evidence that is a tool call of this session: it must have been seen, and have worked", async (t) => {
        const w = await started(t);
        approvePlan(w);
        await w.pi.fire("tool_result", { toolCallId: "call-ok", toolName: "runtime", isError: false }, w.ctx);
        await w.pi.fire("tool_result", { toolCallId: "call-bad", toolName: "runtime", isError: true }, w.ctx);
        const record = (id: string) =>
            w.call({ action: "scenario", number: 1, result: "pass", evidence: { toolResult: id } });
        assert.equal((await record("call-ok")).isError, false);
        assert.deepEqual(w.state()?.scenarios["1"].evidence, { kind: "toolResult", ref: "call-ok" });
        assert.match((await record("call-bad")).text, /failed, so it shows nothing passed/);
        assert.match((await record("never-seen")).text, /this session saw no tool call "never-seen"/);
    });

    test("observed text must say something, and not too much", async (t) => {
        const w = await started(t);
        approvePlan(w);
        const record = (text: string) => w.call({ action: "scenario", number: 1, result: "pass", evidence: { text } });
        assert.match((await record("ok")).text, /evidence text must be 10 to 2000 characters/);
        assert.match((await record("x".repeat(2001))).text, /10 to 2000/);
    });

    test("a scenario the plan does not have", async (t) => {
        const w = await started(t);
        approvePlan(w);
        assert.match(
            (await w.call({ action: "scenario", number: 3, result: "fail" })).text,
            /the plan has no scenario 3; it has 1 to 2/,
        );
    });

    test("all of them passing meets scenarios-pass", async (t) => {
        const custom = {
            acceptance: { name: "acceptance", stages: [{ id: "accept", exit: ["scenarios-pass"] }, { id: "done" }] },
        };
        const w = await started(t, { workflows: custom });
        await w.call({ action: "start", name: "acceptance", replace: true });
        approvePlan(w);
        assert.match((await w.call({ action: "advance" })).text, /Not moved:[\s\S]*scenario 1: no result yet/);
        await w.call({ action: "scenario", number: 1, result: "pass", evidence: { text: "saw it work for one" } });
        await w.call({ action: "scenario", number: 2, result: "pass", evidence: { text: "saw it work for two" } });
        assert.match((await w.call({ action: "advance" })).text, /Moved PROJ-1 from accept to done/);
    });
});

describe("advance and back", () => {
    test("the first stage leaves when the notes changed; the next stage starts its own snapshot", async (t) => {
        const w = await started(t);
        const before = await w.call({ action: "advance" });
        assert.match(
            before.text,
            /^Not moved: PROJ-1 stays at understand\. Missing:\n {2}notes-updated\n {4}notes.md does not exist yet/,
        );
        assert.equal(before.isError, false);
        w.writeNotes("# notes\nlearned the cache is per tenant\n");
        const moved = await w.call({ action: "advance" });
        assert.match(moved.text, /^Moved PROJ-1 from understand to plan\.\nStage 2 of 7: plan\.\nGoal: Write plan.md/);
        const state = w.state();
        assert.equal(state?.stage, "plan");
        assert.equal(state?.notesAtStage, hash("# notes\nlearned the cache is per tenant\n"));
        assert.deepEqual(
            state?.history.map((entry: { event: string }) => entry.event),
            ["start", "advance"],
        );
    });

    test("the plan stage waits for the approval", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "plan";
        });
        assert.match((await w.call({ action: "advance" })).text, /plan-approved\n {4}plan.md does not exist/);
        approvePlan(w);
        assert.match((await w.call({ action: "advance" })).text, /Moved PROJ-1 from plan to build/);
    });

    test("the build stage waits for tests at HEAD, and the missing list says which command fixes it", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "build";
        });
        assert.match(
            (await w.call({ action: "advance" })).text,
            /tests-pass-at-head\n {4}orders-api-PROJ-1: no test run at [0-9a-f]{7}: run workflow test/,
        );
    });

    test("delivering reads the pull request now, and moves when it is open at HEAD with its checks passed", async (t) => {
        const w = await started(t);
        w.host = Object.assign(w.host, {});
        w.writeState((state) => {
            state.stage = "deliver";
        });
        const head = headOf(w.orders);
        (w.host as unknown as { run: unknown }).run = async () =>
            ok(prJson({ headRefOid: head, statusCheckRollup: PASSED }));
        const result = await w.call({ action: "advance" });
        assert.match(result.text, /Moved PROJ-1 from deliver to accept/, result.text);
        assert.equal(w.state()?.observed[w.orders].pr.number, 7, "the reading is kept for the holds");
    });

    test("the last stage is the end", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "done";
        });
        const result = await w.call({ action: "advance" });
        assert.match(result.text, /PROJ-1 is at the last stage, done: the work is done\./);
    });

    test("back goes to the stage before, or to one named, erases nothing, and takes the notes again", async (t) => {
        const w = await started(t);
        approvePlan(w);
        w.writeNotes("# notes\nmore\n");
        w.writeState((state) => {
            state.stage = "build";
        });
        const one = await w.call({ action: "back" });
        assert.match(one.text, /^Moved PROJ-1 back from build to plan\. Nothing recorded was erased/);
        assert.equal(w.state()?.stage, "plan");
        assert.ok(w.state()?.plan, "the plan approval is still there");
        assert.equal(w.state()?.notesAtStage, hash("# notes\nmore\n"));
        const named = await w.call({ action: "back", to: "understand" });
        assert.equal(w.state()?.stage, "understand");
        assert.equal(named.isError, false);
        assert.deepEqual(
            w.state()?.history.map((entry: { event: string }) => entry.event),
            ["start", "back", "back"],
        );
    });

    test("back cannot go forward, to a stage that is not there, or before the first", async (t) => {
        const w = await started(t);
        assert.match(
            (await w.call({ action: "back" })).text,
            /understand is the first stage: there is nothing before it/,
        );
        w.writeState((state) => {
            state.stage = "build";
        });
        assert.match(
            (await w.call({ action: "back", to: "review" })).text,
            /review is not before build: back goes to an earlier stage/,
        );
        assert.match((await w.call({ action: "back", to: "nowhere" })).text, /has no stage "nowhere"/);
    });

    test("going back and forth does not lose a held condition: the plan still counts", async (t) => {
        const w = await started(t);
        approvePlan(w);
        w.writeState((state) => {
            state.stage = "build";
        });
        await w.call({ action: "back" });
        assert.match((await w.call({ action: "advance" })).text, /Moved PROJ-1 from plan to build/);
    });
});

describe("nothing escapes the ticket", () => {
    test("no state is written outside the ticket folder, and a different ticket's state is its own", async (t) => {
        const w = await started(t);
        w.activate("PROJ-2");
        await w.call({ action: "start" });
        assert.equal(w.state("PROJ-2")?.ticket, "PROJ-2");
        assert.equal(w.state("PROJ-1")?.ticket, "PROJ-1");
        assert.equal(existsSync(path.join(w.workspace, "workflow.json")), false);
    });
});
