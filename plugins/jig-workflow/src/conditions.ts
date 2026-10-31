// The eight conditions, decided. A condition is never taken from what the agent says: each is read from a result the plugin
// made (a test run, a plan approval, an event) and compared with the repository or the plan as it is now. A new commit or an
// edited plan therefore ends the result without anyone noticing it has to.
//
// `status` and `advance` read the pull request fresh (`live`); a hold on a call uses the last reading, so it never waits on the
// network.
import type { Condition } from "./definition.ts";
import { REPOSITORY_CONDITIONS } from "./definition.ts";
import { hash } from "./host.ts";
import type { Host } from "./host.ts";
import { fingerprintOf, parsePlan } from "./plan.ts";
import { inspect, short } from "./repos.ts";
import type { RepoView } from "./repos.ts";
import { readPullRequest } from "./sources.ts";
import { readText } from "./files.ts";
import type { Observation, WorkflowState } from "./store.ts";
import type { TicketPaths } from "./ticket.ts";

export interface EvidenceInit {
    host: Host;
    ticket: string;
    paths: TicketPaths;
    cwd: string;
    state: WorkflowState;
    /** The real paths of the bound repositories. */
    bound: readonly string[];
    /** Read the pull request now, rather than use the last reading. */
    live: boolean;
    /** The user answered yes to the question `advance` asked. */
    approvedNow?: boolean;
    signal?: AbortSignal;
}

export interface ConditionResult {
    condition: Condition;
    ok: boolean;
    /** What holds, when it does, and what is missing and what fixes it, when it does not. One line each. */
    lines: string[];
}

/** What the conditions are checked against, read once per evaluation: the repositories, the plan and the notes as they are now. */
export class Evidence {
    readonly init: EvidenceInit;
    /** The readings of pull requests: the saved ones, with any that were read now laid over them. */
    readonly observed: Record<string, Observation>;
    /** The repositories whose reading was made now, so the caller can save it. */
    readonly freshlyRead = new Set<string>();
    private readonly views = new Map<string, Promise<RepoView>>();
    private readonly readings = new Map<string, Promise<Observation | undefined>>();

    constructor(init: EvidenceInit) {
        this.init = init;
        this.observed = { ...init.state.observed };
    }

    get state(): WorkflowState {
        return this.init.state;
    }

    get roots(): readonly string[] {
        return this.init.bound;
    }

    view(root: string): Promise<RepoView> {
        let view = this.views.get(root);
        if (view === undefined) {
            view = inspect(this.init.host, root, this.init.signal);
            this.views.set(root, view);
        }
        return view;
    }

    planText(): string {
        return readText(this.init.paths.plan);
    }

    notesText(): string {
        return readText(this.init.paths.notes);
    }

    /** The reading of a repository's pull request: read now when `live`, else the last one saved. */
    observation(root: string): Promise<Observation | undefined> {
        let reading = this.readings.get(root);
        if (reading === undefined) {
            reading = (async () => {
                if (!this.init.live) return this.observed[root];
                const view = await this.view(root);
                if (view.head === undefined || view.branch === undefined) {
                    return {
                        at: this.init.host.now().toISOString(),
                        branch: view.branch ?? "",
                        head: view.head ?? "",
                        error:
                            view.head === undefined
                                ? (view.problem ?? "there is no commit yet")
                                : "HEAD is detached, so there is no branch to look up",
                    };
                }
                const read = await readPullRequest(this.init.host, root, view.branch, view.head, this.init.signal);
                this.observed[root] = read;
                this.freshlyRead.add(root);
                return read;
            })();
            this.readings.set(root, reading);
        }
        return reading;
    }
}

/** The repositories a condition looks at: the one named, or every bound one. */
function targets(ev: Evidence, only: string | undefined): readonly string[] {
    return only === undefined ? ev.roots : [only];
}

function result(condition: Condition, ok: boolean, lines: string[]): ConditionResult {
    return { condition, ok, lines };
}

/** A per-repository condition: each repository gives its lines, and the condition holds when every one does. */
async function eachRepository(
    condition: Condition,
    ev: Evidence,
    only: string | undefined,
    check: (view: RepoView) => Promise<{ ok: boolean; line: string }>,
): Promise<ConditionResult> {
    const roots = targets(ev, only);
    if (roots.length === 0) {
        return result(condition, false, [
            `no repository is bound to ${ev.init.ticket}: bind one with workflow bind (or list it in ticket.json)`,
        ]);
    }
    const checked = await Promise.all(roots.map(async (root) => check(await ev.view(root))));
    return result(
        condition,
        checked.every((one) => one.ok),
        checked.map((one) => one.line),
    );
}

// ---- the conditions -----------------------------------------------------------------------------------------------------

function notesUpdated(ev: Evidence): ConditionResult {
    const notes = ev.notesText();
    if (notes === "") {
        return result("notes-updated", false, [
            "notes.md does not exist yet: make the ticket active with /ticket, then write what you learn in the notes",
        ]);
    }
    return hash(notes) === ev.state.notesAtStage
        ? result("notes-updated", false, [
              `notes.md has not changed since the stage ${ev.state.stage} began: write what you learned in it`,
          ])
        : result("notes-updated", true, ["notes.md changed since the stage began"]);
}

function planApproved(ev: Evidence): ConditionResult {
    const text = ev.planText();
    const approved = ev.state.plan;
    if (text === "")
        return result("plan-approved", false, ["plan.md does not exist: write it, then run workflow submit-plan"]);
    if (approved === undefined)
        return result("plan-approved", false, ["the plan has not been submitted: run workflow submit-plan"]);
    return approved.fingerprint === fingerprintOf(text)
        ? result("plan-approved", true, [
              `you approved this plan (${approved.scenarios} scenario${approved.scenarios === 1 ? "" : "s"})`,
          ])
        : result("plan-approved", false, ["plan.md changed since you approved it: run workflow submit-plan again"]);
}

function testsPassAtHead(ev: Evidence, only: string | undefined): Promise<ConditionResult> {
    return eachRepository("tests-pass-at-head", ev, only, async (view) => {
        const name = view.name;
        if (view.head === undefined) return { ok: false, line: `${name}: ${view.problem ?? "there is no commit yet"}` };
        const run = ev.state.tests[view.root];
        if (run === undefined)
            return { ok: false, line: `${name}: no test run at ${short(view.head)}: run workflow test` };
        if (run.head !== view.head) {
            return {
                ok: false,
                line: `${name}: the last test run was at ${short(run.head)} and HEAD is ${short(view.head)}: run workflow test`,
            };
        }
        if (!run.clean) {
            return {
                ok: false,
                line: `${name}: the tests ran with uncommitted changes, which says nothing about ${short(view.head)}: commit, then run workflow test`,
            };
        }
        if (!run.passed) {
            return {
                ok: false,
                line: `${name}: the tests failed at ${short(view.head)} (${run.timedOut ? "timed out" : `exit ${run.exitCode}`}): fix them, commit, and run workflow test`,
            };
        }
        return {
            ok: true,
            line: `${name}: passed at ${short(view.head)}${run.sandboxed ? "" : " (run outside the sandbox, with your approval)"}`,
        };
    });
}

function reviewDone(ev: Evidence, only: string | undefined): Promise<ConditionResult> {
    return eachRepository("review-done", ev, only, async (view) => {
        const name = view.name;
        if (view.head === undefined) return { ok: false, line: `${name}: ${view.problem ?? "there is no commit yet"}` };
        const covers = (head: string) =>
            ev.state.reviews.find((review) => review.repos.some((r) => r.root === view.root && r.head === head));
        if (covers(view.head) !== undefined)
            return { ok: true, line: `${name}: an approved review covers ${short(view.head)}` };
        const earlier = [...ev.state.reviews]
            .reverse()
            .find((review) => review.repos.some((r) => r.root === view.root));
        const was = earlier?.repos.find((r) => r.root === view.root)?.head;
        return {
            ok: false,
            line:
                `${name}: no approved review covers ${short(view.head)}` +
                (was === undefined ? "" : ` (the last one covered ${short(was)})`) +
                ": review the branch (/code-review --branch) and approve it",
        };
    });
}

function pullRequestOpen(ev: Evidence, only: string | undefined): Promise<ConditionResult> {
    return eachRepository("pull-request-open", ev, only, async (view) => {
        const name = view.name;
        const seen = await ev.observation(view.root);
        if (seen === undefined || (!ev.init.live && seen.branch !== view.branch)) {
            return { ok: false, line: `${name}: the pull request has not been looked up yet: run workflow status` };
        }
        if (seen.error !== undefined)
            return { ok: false, line: `${name}: cannot read the pull request (${seen.error})` };
        if (seen.pr === undefined) {
            return {
                ok: false,
                line: `${name}: no pull request for ${seen.branch}: push the branch and open one with pr create`,
            };
        }
        if (seen.pr.state !== "OPEN") {
            return {
                ok: false,
                line: `${name}: pull request #${seen.pr.number} is ${seen.pr.state.toLowerCase()}, not open`,
            };
        }
        return {
            ok: true,
            line: `${name}: pull request #${seen.pr.number} is open${seen.pr.isDraft ? " (a draft)" : ""}`,
        };
    });
}

function checksPass(ev: Evidence, only: string | undefined): Promise<ConditionResult> {
    return eachRepository("checks-pass", ev, only, async (view) => {
        const name = view.name;
        const seen = await ev.observation(view.root);
        if (view.head === undefined) return { ok: false, line: `${name}: ${view.problem ?? "there is no commit yet"}` };
        if (seen === undefined || seen.pr === undefined || seen.error !== undefined || seen.pr.state !== "OPEN") {
            return {
                ok: false,
                line: `${name}: checks are read from an open pull request, and there is none yet (see pull-request-open)`,
            };
        }
        if (seen.pr.headRefOid !== view.head) {
            return {
                ok: false,
                line: `${name}: the pull request is at ${short(seen.pr.headRefOid)} and HEAD is ${short(view.head)}: push first`,
            };
        }
        const slug = view.slug;
        const watched =
            slug === undefined ? [] : ev.state.ci.filter((entry) => entry.repo === slug && entry.sha === view.head);
        if (watched.some((entry) => entry.outcome === "passed")) {
            return { ok: true, line: `${name}: a CI watch passed the required checks at ${short(view.head)}` };
        }
        const counts = seen.checks;
        if (
            counts !== undefined &&
            counts.total > 0 &&
            counts.fail === 0 &&
            counts.pending === 0 &&
            seen.head === view.head
        ) {
            return { ok: true, line: `${name}: all ${counts.total} checks of the pull request passed` };
        }
        if (watched.length > 0 || (counts !== undefined && counts.fail > 0)) {
            return {
                ok: false,
                line: `${name}: ${watched.length > 0 ? "the CI watch failed" : `${counts?.fail} check${counts?.fail === 1 ? "" : "s"} failed`} at ${short(view.head)}: look with ci status and ci log, fix, and push`,
            };
        }
        if (counts === undefined || counts.total === 0) {
            return { ok: false, line: `${name}: the pull request has no checks yet` };
        }
        return {
            ok: false,
            line: `${name}: ${counts.pending} of ${counts.total} checks are still running: ci watch waits for the required ones and wakes you`,
        };
    });
}

function scenariosPass(ev: Evidence): ConditionResult {
    const approved = planApproved(ev);
    if (!approved.ok)
        return result("scenarios-pass", false, [
            "the plan must be approved first, so that the scenarios are the ones you read",
        ]);
    const scenarios = parsePlan(ev.planText()).scenarios;
    const lines: string[] = [];
    let passed = 0;
    for (const scenario of scenarios) {
        const recorded = ev.state.scenarios[String(scenario.number)];
        if (recorded === undefined)
            lines.push(`scenario ${scenario.number}: no result yet: run it, then record it with workflow scenario`);
        else if (recorded.hash !== scenario.hash)
            lines.push(`scenario ${scenario.number}: it changed since its result was recorded: run it again`);
        else if (recorded.result === "fail")
            lines.push(`scenario ${scenario.number}: failed: fix the cause and record a pass with evidence`);
        else if (recorded.evidence === undefined)
            lines.push(`scenario ${scenario.number}: passed without evidence: record it again with evidence`);
        else passed++;
    }
    if (scenarios.length === 0) return result("scenarios-pass", false, ["the plan has no scenarios"]);
    return lines.length === 0
        ? result("scenarios-pass", true, [`all ${passed} scenarios passed, each with evidence`])
        : result("scenarios-pass", false, lines);
}

function youApprove(ev: Evidence): ConditionResult {
    return ev.init.approvedNow === true
        ? result("you-approve", true, ["you said yes to moving on"])
        : result("you-approve", false, ["you are asked when the work moves on"]);
}

/** Decides one condition. `only` limits a per-repository condition to one bound repository (a hold on a call there). */
export function evaluate(condition: Condition, ev: Evidence, only?: string): Promise<ConditionResult> {
    switch (condition) {
        case "notes-updated":
            return Promise.resolve(notesUpdated(ev));
        case "plan-approved":
            return Promise.resolve(planApproved(ev));
        case "tests-pass-at-head":
            return testsPassAtHead(ev, only);
        case "review-done":
            return reviewDone(ev, only);
        case "pull-request-open":
            return pullRequestOpen(ev, only);
        case "checks-pass":
            return checksPass(ev, only);
        case "scenarios-pass":
            return Promise.resolve(scenariosPass(ev));
        case "you-approve":
            return Promise.resolve(youApprove(ev));
    }
}

/** Decides several conditions, in order. */
export async function evaluateAll(
    conditions: readonly Condition[],
    ev: Evidence,
    only?: string,
): Promise<ConditionResult[]> {
    const results: ConditionResult[] = [];
    for (const condition of conditions)
        results.push(await evaluate(condition, ev, REPOSITORY_CONDITIONS.has(condition) ? only : undefined));
    return results;
}
