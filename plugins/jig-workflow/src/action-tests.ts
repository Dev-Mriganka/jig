// The `test` action: running each bound repository's tests, in the sandbox when there is one, and recording the result against the
// commit. Also the plan of what would run, and the question that asks the user to run tests outside the sandbox.
import path from "node:path";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { digest } from "./host.ts";
import { inspect, short } from "./repos.ts";
import type { RepoView } from "./repos.ts";
import type { Runtime } from "./runtime.ts";
import { updateState } from "./store.ts";
import { planTests, runTests } from "./tests.ts";
import type { TestPlan } from "./tests.ts";
import { started, ticketOf } from "./action-support.ts";
import type { ActionResult, Call, Params } from "./action-support.ts";

/** The bound repositories a test run covers: all of them, or the one `repo` names (by folder, name or path). */
async function testViews(rt: Runtime, ticket: string, repo: string | undefined): Promise<RepoView[]> {
    const roots = rt.bound(ticket).roots;
    if (roots.length === 0)
        throw new InputError(
            `no repository is bound to ${ticket}: bind one with workflow bind (or list it in ticket.json)`,
        );
    const views = await Promise.all(roots.map((root) => inspect(rt.host, root)));
    if (repo === undefined) return views;
    const cwd = rt.cwd;
    const chosen = views.filter(
        (view) =>
            view.name === repo ||
            view.remoteName === repo ||
            view.root === repo ||
            view.root === path.resolve(cwd, repo),
    );
    if (chosen.length === 0) {
        throw new InputError(
            `${JSON.stringify(repo.slice(0, 80))} is not bound to ${ticket}; bound: ${views.map((view) => view.name).join(", ")}`,
        );
    }
    return chosen;
}

export interface TestsToRun {
    views: RepoView[];
    plans: TestPlan[];
}

/** The commands a test call would run, one per bound repository; an `InputError` when one has no command. */
export async function plannedTests(rt: Runtime, params: Params): Promise<TestsToRun & { ticket: string }> {
    const ticket = ticketOf(rt, params);
    started(rt, ticket);
    const views = await testViews(rt, ticket, params.repo);
    const plans = views.map((view) => planTests(rt.settings, view, rt.cwd));
    const problems = plans.flatMap((plan) => (plan.problem === undefined ? [] : [plan.problem]));
    if (problems.length > 0) throw new InputError(problems.join("; "));
    return { ticket, views, plans };
}

/** The fingerprint of what a test call would run, which the user's yes has to carry when there is no sandbox. */
export function testFingerprint(ticket: string, plans: readonly TestPlan[], views: readonly RepoView[]): string {
    return digest(
        "test",
        ticket,
        ...plans.flatMap((plan, index) => [plan.root, plan.command, plan.timeoutSeconds, views[index]?.head]),
    );
}

export async function runTestsAction(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const { ticket, views, plans } = await plannedTests(rt, params);
    const { work } = started(rt, ticket);
    // Where it runs is decided now, not when the call was classified: a sandbox that has gone away must not become an unasked run.
    const sandboxed = rt.host.sandbox.canRun();
    if (!sandboxed) {
        const approved = rt.host.approvedPreview(call.toolCallId);
        if (approved === undefined) {
            throw new Error(
                "there is no sandbox that can run commands, and the user was not asked to run these tests outside it. Nothing was run. Call test again.",
            );
        }
        if (approved.fingerprint !== testFingerprint(ticket, plans, views)) {
            throw new Error(
                "the commands or the commits changed since the user approved running them outside the sandbox. Nothing was run. Call test again.",
            );
        }
    }
    const lines: string[] = [];
    let passed = 0;
    for (const [index, plan] of plans.entries()) {
        const view = views[index] as RepoView;
        try {
            const run = await runTests(rt.host, plan, view, {
                sandboxed,
                ...(call.signal === undefined ? {} : { signal: call.signal }),
            });
            updateState(work.paths.dir, (state) => {
                state.tests[view.root] = run.result;
            });
            const verdict = run.result.passed
                ? "PASSED"
                : run.result.timedOut
                  ? `TIMED OUT after ${plan.timeoutSeconds} s`
                  : `FAILED (exit ${run.result.exitCode})`;
            const note = run.result.clean
                ? ""
                : " on a tree with uncommitted changes, which does not count: commit, then run again";
            if (run.result.passed && run.result.clean) passed++;
            lines.push(
                `${view.name}: ${verdict} at ${short(view.head)}${note} · ${plan.command} · ${sandboxed ? "in the sandbox" : "outside the sandbox, as you approved"} · ${(run.result.durationMs / 1000).toFixed(1)} s`,
                ...(run.result.passed && run.result.clean ? [] : [indent(run.tail)]),
            );
        } catch (error) {
            // A cancelled call stops here; a repository that cannot be run does not stop the others.
            if (call.signal?.aborted === true) throw error;
            lines.push(`${view.name}: could not run: ${(error as Error).message.split("\n")[0]}`);
        }
    }
    lines.push(
        `${passed} of ${plans.length} repositor${plans.length === 1 ? "y" : "ies"} passed at HEAD on a clean tree.`,
    );
    return { text: lines.join("\n"), details: { ticket, passed, total: plans.length, sandboxed } };
}

function indent(text: string): string {
    return text === ""
        ? ""
        : text
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n");
}

/** The question about running tests outside the sandbox: each command, where, and for how long. */
export function testQuestion(ticket: string, plans: readonly TestPlan[]): { summary: string; body: string } {
    return {
        summary: `Run the tests of ${ticket} OUTSIDE the sandbox, as you, with your credentials and the network? (${plans.length} repositor${plans.length === 1 ? "y" : "ies"})`,
        body: [
            "No sandbox is running that can run commands, so these would run as a shell, as you:",
            "",
            ...plans.flatMap((plan) => [
                `- ${plan.name}: ${plan.command}`,
                `    in ${plan.root}, at most ${plan.timeoutSeconds} s (${plan.source ?? "set in jig.json"})`,
            ]),
            "",
            "A test can run anything. With jig-sandbox active, these would run inside it without asking.",
        ].join("\n"),
    };
}
