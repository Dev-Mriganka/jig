// The eight conditions: each held, not held, and made to stop holding by a new commit, an edited plan or a changed scenario.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import { evaluate, evaluateAll, Evidence } from "../src/conditions.ts";
import type { Condition } from "../src/definition.ts";
import { hash } from "../src/host.ts";
import { fingerprintOf, parsePlan } from "../src/plan.ts";
import { newState } from "../src/store.ts";
import type { Observation, TestResult, WorkflowState } from "../src/store.ts";
import { ticketPaths } from "../src/ticket.ts";
import { commit, fakeHost, git, headOf, makeRepo, NOW, ok, PASSED, prJson, tempFolder } from "./support.ts";
import type { FakeHost, RunScript } from "./support.ts";

const PLAN = `## Approach
Cache the price list.

## Repositories
- orders-api

## Scenarios
1. Two reads, one query.
2. A price change shows at once.
`;

interface World {
    host: FakeHost;
    folder: string;
    ticketDir: string;
    orders: string;
    billing: string;
    state: WorkflowState;
    writePlan(text: string): void;
    writeNotes(text: string): void;
    evidence(over?: { live?: boolean; roots?: string[]; approvedNow?: boolean }): Evidence;
}

function world(t: TestContext, over: { run?: RunScript } = {}): World {
    const folder = tempFolder(t);
    const orders = makeRepo(folder, "orders-api-PROJ-1", "git@github.example.com:acme/orders-api.git");
    const billing = makeRepo(folder, "billing-api", "git@github.example.com:acme/billing-api.git");
    const paths = ticketPaths(path.join(folder, "tickets"), "PROJ-1");
    mkdirSync(paths.dir, { recursive: true });
    const host = fakeHost(over.run === undefined ? {} : { run: over.run });
    const state = newState({ workflow: "feature", ticket: "PROJ-1", stage: "build", notesHash: hash(""), now: NOW });
    return {
        host,
        folder,
        ticketDir: paths.dir,
        orders,
        billing,
        state,
        writePlan: (text) => writeFileSync(paths.plan, text),
        writeNotes: (text) => writeFileSync(paths.notes, text),
        evidence: (options = {}) =>
            new Evidence({
                host,
                ticket: "PROJ-1",
                paths,
                cwd: folder,
                state,
                bound: options.roots ?? [orders],
                live: options.live ?? false,
                ...(options.approvedNow === undefined ? {} : { approvedNow: options.approvedNow }),
            }),
    };
}

const run = (head: string, over: Partial<TestResult> = {}): TestResult => ({
    head,
    clean: true,
    passed: true,
    command: "npm test",
    exitCode: 0,
    timedOut: false,
    sandboxed: true,
    at: NOW.toISOString(),
    durationMs: 100,
    ...over,
});

const check = async (w: World, condition: Condition, options: Parameters<World["evidence"]>[0] = {}, only?: string) =>
    evaluate(condition, w.evidence(options), only);

describe("notes-updated", () => {
    test("not while there are no notes, nor while they are as they were when the stage began", async (t) => {
        const w = world(t);
        const none = await check(w, "notes-updated");
        assert.equal(none.ok, false);
        assert.match(none.lines[0] ?? "", /notes.md does not exist yet: make the ticket active with \/ticket/);
        w.writeNotes("# notes\n");
        w.state.notesAtStage = hash("# notes\n");
        const same = await check(w, "notes-updated");
        assert.equal(same.ok, false);
        assert.match(same.lines[0] ?? "", /has not changed since the stage build began/);
    });

    test("when they differ from the hash saved at the start of the stage", async (t) => {
        const w = world(t);
        w.writeNotes("# notes\n");
        w.state.notesAtStage = hash("# notes\n");
        w.writeNotes("# notes\nlearned: the cache is per tenant\n");
        assert.equal((await check(w, "notes-updated")).ok, true);
    });
});

describe("plan-approved", () => {
    test("not without a plan, nor before it is submitted", async (t) => {
        const w = world(t);
        assert.match((await check(w, "plan-approved")).lines[0] ?? "", /plan.md does not exist/);
        w.writePlan(PLAN);
        const result = await check(w, "plan-approved");
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", /has not been submitted: run workflow submit-plan/);
    });

    test("when the fingerprint you approved is the plan's now; an edit ends it", async (t) => {
        const w = world(t);
        w.writePlan(PLAN);
        w.state.plan = { fingerprint: fingerprintOf(PLAN), at: NOW.toISOString(), scenarios: 2 };
        const held = await check(w, "plan-approved");
        assert.equal(held.ok, true);
        assert.equal(held.lines[0], "you approved this plan (2 scenarios)");
        w.writePlan(PLAN.replace("Cache the price list.", "Cache the price list per tenant."));
        const edited = await check(w, "plan-approved");
        assert.equal(edited.ok, false);
        assert.match(edited.lines[0] ?? "", /changed since you approved it: run workflow submit-plan again/);
    });
});

describe("tests-pass-at-head", () => {
    test("not while no repository is bound", async (t) => {
        const w = world(t);
        const result = await check(w, "tests-pass-at-head", { roots: [] });
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", /no repository is bound to PROJ-1/);
    });

    test("not before a run, and a run at HEAD that passed on a clean tree holds", async (t) => {
        const w = world(t);
        const before = await check(w, "tests-pass-at-head");
        assert.equal(before.ok, false);
        assert.match(before.lines[0] ?? "", /^orders-api-PROJ-1: no test run at [0-9a-f]{7}: run workflow test$/);
        w.state.tests[w.orders] = run(headOf(w.orders));
        const after = await check(w, "tests-pass-at-head");
        assert.equal(after.ok, true);
        assert.match(after.lines[0] ?? "", /^orders-api-PROJ-1: passed at [0-9a-f]{7}$/);
    });

    test("a new commit ends it", async (t) => {
        const w = world(t);
        const was = headOf(w.orders);
        w.state.tests[w.orders] = run(was);
        assert.equal((await check(w, "tests-pass-at-head")).ok, true);
        commit(w.orders);
        const after = await check(w, "tests-pass-at-head");
        assert.equal(after.ok, false);
        assert.match(
            after.lines[0] ?? "",
            new RegExp(`the last test run was at ${was.slice(0, 7)} and HEAD is [0-9a-f]{7}: run workflow test`),
        );
    });

    test("a pass on a dirty tree never counts, however long ago", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders), { clean: false });
        const result = await check(w, "tests-pass-at-head");
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", /ran with uncommitted changes.*commit, then run workflow test/);
    });

    test("uncommitted changes after a clean run do not undo it: a push sends commits", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders));
        writeFileSync(path.join(w.orders, "scratch.txt"), "x");
        assert.equal((await check(w, "tests-pass-at-head")).ok, true);
    });

    test("a failed run, and a run that timed out, say which", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders), { passed: false, exitCode: 1 });
        assert.match(
            (await check(w, "tests-pass-at-head")).lines[0] ?? "",
            /the tests failed at [0-9a-f]{7} \(exit 1\)/,
        );
        w.state.tests[w.orders] = run(headOf(w.orders), { passed: false, exitCode: null, timedOut: true });
        assert.match((await check(w, "tests-pass-at-head")).lines[0] ?? "", /\(timed out\)/);
    });

    test("a run outside the sandbox is said to be", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders), { sandboxed: false });
        assert.match(
            (await check(w, "tests-pass-at-head")).lines[0] ?? "",
            /run outside the sandbox, with your approval/,
        );
    });

    test("every bound repository must hold, and a hold on a call in one looks at that one alone", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders));
        const both = await check(w, "tests-pass-at-head", { roots: [w.orders, w.billing] });
        assert.equal(both.ok, false);
        assert.equal(both.lines.length, 2);
        assert.equal((await check(w, "tests-pass-at-head", { roots: [w.orders, w.billing] }, w.orders)).ok, true);
        assert.equal((await check(w, "tests-pass-at-head", { roots: [w.orders, w.billing] }, w.billing)).ok, false);
    });

    test("a repository with no commit has no HEAD to test", async (t) => {
        const w = world(t);
        const empty = path.join(w.folder, "empty");
        mkdirSync(empty);
        git(empty, "init", "-q", "-b", "main");
        const result = await check(w, "tests-pass-at-head", { roots: [empty] });
        assert.match(result.lines[0] ?? "", /empty: there is no commit yet/);
    });
});

describe("review-done", () => {
    test("not before a review, and an approved review of HEAD holds", async (t) => {
        const w = world(t);
        const none = await check(w, "review-done");
        assert.equal(none.ok, false);
        assert.match(
            none.lines[0] ?? "",
            /no approved review covers [0-9a-f]{7}: review the branch \(\/code-review --branch\)/,
        );
        w.state.reviews.push({
            reviewId: "r1",
            at: NOW.toISOString(),
            repos: [{ root: w.orders, head: headOf(w.orders) }],
        });
        assert.equal((await check(w, "review-done")).ok, true);
    });

    test("a new commit ends it, and the message names the commit the review covered", async (t) => {
        const w = world(t);
        const reviewed = headOf(w.orders);
        w.state.reviews.push({ reviewId: "r1", at: NOW.toISOString(), repos: [{ root: w.orders, head: reviewed }] });
        commit(w.orders);
        const result = await check(w, "review-done");
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", new RegExp(`\\(the last one covered ${reviewed.slice(0, 7)}\\)`));
    });

    test("a review of another repository does not cover this one", async (t) => {
        const w = world(t);
        w.state.reviews.push({
            reviewId: "r1",
            at: NOW.toISOString(),
            repos: [{ root: w.billing, head: headOf(w.orders) }],
        });
        assert.equal((await check(w, "review-done")).ok, false);
    });
});

describe("pull-request-open", () => {
    const gh =
        (stdout: string, code = 0, stderr = ""): RunScript =>
        () =>
            ok(stdout, code, stderr);

    test("read now, from gh pr view, when live", async (t) => {
        const w = world(t, { run: gh(prJson()) });
        const result = await check(w, "pull-request-open", { live: true });
        assert.equal(result.ok, true);
        assert.match(result.lines[0] ?? "", /pull request #7 is open$/);
        assert.equal(w.host.ran[0]?.file, "gh");
        assert.equal(w.host.ran[0]?.cwd, w.orders);
    });

    test("a draft is open, and is said to be a draft", async (t) => {
        const w = world(t, { run: gh(prJson({ isDraft: true })) });
        assert.match((await check(w, "pull-request-open", { live: true })).lines[0] ?? "", /is open \(a draft\)/);
    });

    test("no pull request, a closed one, a merged one, and gh failing", async (t) => {
        const none = world(t, { run: gh("", 1, 'no pull requests found for branch "main"') });
        const result = await check(none, "pull-request-open", { live: true });
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", /no pull request for main: push the branch and open one with pr create/);
        for (const state of ["CLOSED", "MERGED"]) {
            const w = world(t, { run: gh(prJson({ state })) });
            assert.match(
                (await check(w, "pull-request-open", { live: true })).lines[0] ?? "",
                new RegExp(`is ${state.toLowerCase()}, not open`),
            );
        }
        const broken = world(t, { run: gh("", 4, "gh auth login") });
        assert.match(
            (await check(broken, "pull-request-open", { live: true })).lines[0] ?? "",
            /cannot read the pull request \(gh auth login\)/,
        );
    });

    test("a detached HEAD has no branch to look up", async (t) => {
        const w = world(t, { run: gh(prJson()) });
        git(w.orders, "checkout", "-q", "--detach");
        const result = await check(w, "pull-request-open", { live: true });
        assert.match(result.lines[0] ?? "", /HEAD is detached/);
        assert.equal(w.host.ran.length, 0, "gh is not asked");
    });

    test("when not live, the last reading is used, and no program is run", async (t) => {
        const w = world(t);
        const head = headOf(w.orders);
        const reading: Observation = {
            at: NOW.toISOString(),
            branch: "main",
            head,
            pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, url: "u" },
        };
        w.state.observed[w.orders] = reading;
        assert.equal((await check(w, "pull-request-open")).ok, true);
        assert.equal(w.host.ran.length, 0);
        git(w.orders, "checkout", "-q", "-b", "other");
        const stale = await check(w, "pull-request-open");
        assert.equal(stale.ok, false);
        assert.match(stale.lines[0] ?? "", /has not been looked up yet: run workflow status/);
    });

    test("a live reading is kept for the caller to save", async (t) => {
        const w = world(t, { run: gh(prJson()) });
        const evidence = w.evidence({ live: true });
        await evaluate("pull-request-open", evidence);
        assert.deepEqual([...evidence.freshlyRead], [w.orders]);
        assert.equal(evidence.observed[w.orders]?.pr?.number, 7);
    });
});

describe("checks-pass", () => {
    function prAt(head: string, over: Record<string, unknown> = {}): RunScript {
        return () => ok(prJson({ headRefOid: head, statusCheckRollup: PASSED, ...over }));
    }

    test("needs an open pull request first", async (t) => {
        const w = world(t, { run: () => ok("", 1, "no pull requests found") });
        const result = await check(w, "checks-pass", { live: true });
        assert.equal(result.ok, false);
        assert.match(result.lines[0] ?? "", /checks are read from an open pull request, and there is none yet/);
    });

    test("holds when every check of the pull request at HEAD passed", async (t) => {
        const w = world(t);
        w.host = fakeHost({ run: prAt(headOf(w.orders)) });
        const result = await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host: w.host, live: true }));
        assert.equal(result.ok, true);
        assert.match(result.lines[0] ?? "", /all 2 checks of the pull request passed/);
    });

    test("not while the pull request is at an older commit: push first", async (t) => {
        const w = world(t);
        const pushed = headOf(w.orders);
        commit(w.orders);
        const host = fakeHost({ run: prAt(pushed) });
        const result = await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host, live: true }));
        assert.equal(result.ok, false);
        assert.match(
            result.lines[0] ?? "",
            new RegExp(`the pull request is at ${pushed.slice(0, 7)} and HEAD is [0-9a-f]{7}: push first`),
        );
    });

    test("a failed check, a running check and no checks each say so", async (t) => {
        const w = world(t);
        const head = headOf(w.orders);
        const cases: Array<[unknown[], RegExp]> = [
            [
                [{ status: "COMPLETED", conclusion: "FAILURE" }, ...PASSED],
                /1 check failed at [0-9a-f]{7}: look with ci status and ci log/,
            ],
            [
                [{ status: "IN_PROGRESS" }, ...PASSED],
                /1 of 3 checks are still running: ci watch waits for the required ones/,
            ],
            [[], /the pull request has no checks yet/],
        ];
        for (const [rollup, message] of cases) {
            const host = fakeHost({ run: prAt(head, { statusCheckRollup: rollup }) });
            const result = await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host, live: true }));
            assert.equal(result.ok, false);
            assert.match(result.lines[0] ?? "", message);
        }
    });

    test("a CI watch that passed the required checks at HEAD holds, whatever optional checks are still running", async (t) => {
        const w = world(t);
        const head = headOf(w.orders);
        w.state.ci.push({
            repo: "acme/orders-api",
            sha: head,
            outcome: "passed",
            finish: "required",
            at: NOW.toISOString(),
        });
        const host = fakeHost({ run: prAt(head, { statusCheckRollup: [{ status: "IN_PROGRESS" }] }) });
        const result = await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host, live: true }));
        assert.equal(result.ok, true);
        assert.match(result.lines[0] ?? "", /a CI watch passed the required checks at/);
    });

    test("a CI watch for another commit or another repository counts for nothing, and a failed one says so", async (t) => {
        const w = world(t);
        const head = headOf(w.orders);
        w.state.ci.push(
            { repo: "acme/orders-api", sha: "b".repeat(40), outcome: "passed", finish: "required", at: "t" },
            { repo: "acme/billing-api", sha: head, outcome: "passed", finish: "required", at: "t" },
        );
        const pending = fakeHost({ run: prAt(head, { statusCheckRollup: [{ status: "IN_PROGRESS" }] }) });
        assert.equal(
            (await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host: pending, live: true }))).ok,
            false,
        );
        w.state.ci.push({ repo: "acme/orders-api", sha: head, outcome: "failed", finish: "required", at: "t" });
        const result = await evaluate("checks-pass", new Evidence({ ...w.evidence().init, host: pending, live: true }));
        assert.match(result.lines[0] ?? "", /the CI watch failed at [0-9a-f]{7}/);
    });

    test("when not live, the saved reading is trusted only at the commit it was made at", async (t) => {
        const w = world(t);
        const head = headOf(w.orders);
        w.state.observed[w.orders] = {
            at: NOW.toISOString(),
            branch: "main",
            head,
            pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, url: "u" },
            checks: { pass: 3, fail: 0, pending: 0, total: 3 },
        };
        assert.equal((await check(w, "checks-pass")).ok, true);
        w.state.observed[w.orders] = { ...w.state.observed[w.orders], head: "c".repeat(40) } as Observation;
        assert.equal((await check(w, "checks-pass")).ok, false);
    });
});

describe("scenarios-pass", () => {
    function approved(w: World): void {
        w.writePlan(PLAN);
        w.state.plan = { fingerprint: fingerprintOf(PLAN), at: NOW.toISOString(), scenarios: 2 };
    }
    const scenarios = parsePlan(PLAN).scenarios;
    const pass = (n: number, text = "x") => ({
        result: "pass" as const,
        hash: scenarios[n - 1]?.hash ?? "",
        evidence: { kind: "text" as const, ref: text },
        at: NOW.toISOString(),
    });

    test("not before the plan is approved: the scenarios must be the ones you read", async (t) => {
        const w = world(t);
        w.writePlan(PLAN);
        assert.match((await check(w, "scenarios-pass")).lines[0] ?? "", /plan must be approved first/);
    });

    test("every scenario needs a pass with evidence", async (t) => {
        const w = world(t);
        approved(w);
        const none = await check(w, "scenarios-pass");
        assert.deepEqual(none.lines, [
            "scenario 1: no result yet: run it, then record it with workflow scenario",
            "scenario 2: no result yet: run it, then record it with workflow scenario",
        ]);
        w.state.scenarios["1"] = pass(1);
        w.state.scenarios["2"] = { ...pass(2), result: "fail" };
        const one = await check(w, "scenarios-pass");
        assert.equal(one.ok, false);
        assert.deepEqual(one.lines, ["scenario 2: failed: fix the cause and record a pass with evidence"]);
        w.state.scenarios["2"] = pass(2);
        const all = await check(w, "scenarios-pass");
        assert.equal(all.ok, true);
        assert.equal(all.lines[0], "all 2 scenarios passed, each with evidence");
    });

    test("a pass with no evidence does not count", async (t) => {
        const w = world(t);
        approved(w);
        w.state.scenarios["1"] = { result: "pass", hash: scenarios[0]?.hash ?? "", at: "t" };
        w.state.scenarios["2"] = pass(2);
        assert.match((await check(w, "scenarios-pass")).lines[0] ?? "", /scenario 1: passed without evidence/);
    });

    test("a changed scenario ends its pass, and an edit that needs a new approval ends them all", async (t) => {
        const w = world(t);
        approved(w);
        w.state.scenarios["1"] = pass(1);
        w.state.scenarios["2"] = { ...pass(2), hash: "stale" };
        assert.deepEqual((await check(w, "scenarios-pass")).lines, [
            "scenario 2: it changed since its result was recorded: run it again",
        ]);
        w.state.scenarios["2"] = pass(2);
        assert.equal((await check(w, "scenarios-pass")).ok, true);
        w.writePlan(PLAN.replace("Two reads, one query.", "Two reads, one query, per tenant."));
        const edited = await check(w, "scenarios-pass");
        assert.equal(edited.ok, false);
        assert.match(edited.lines[0] ?? "", /plan must be approved first/);
    });
});

describe("you-approve", () => {
    test("holds only for the move you said yes to", async (t) => {
        const w = world(t);
        assert.equal((await check(w, "you-approve")).ok, false);
        assert.deepEqual((await check(w, "you-approve")).lines, ["you are asked when the work moves on"]);
        assert.equal((await check(w, "you-approve", { approvedNow: true })).ok, true);
    });
});

describe("several at once", () => {
    test("in the order asked, with a per-repository condition limited to one repository and the others untouched", async (t) => {
        const w = world(t);
        w.state.tests[w.orders] = run(headOf(w.orders));
        const results = await evaluateAll(
            ["tests-pass-at-head", "plan-approved"],
            w.evidence({ roots: [w.orders, w.billing] }),
            w.orders,
        );
        assert.deepEqual(
            results.map((r) => [r.condition, r.ok]),
            [
                ["tests-pass-at-head", true],
                ["plan-approved", false],
            ],
        );
    });
});
