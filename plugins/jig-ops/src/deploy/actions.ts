// The five actions of the deploy tool. `plan` and `status` read; `run` and `rollback` change a cluster, once, after the user
// approved a preview of exactly that; `watch` starts a background watch on jig-core's engine and changes nothing.
import { jig } from "../../../jig-core/src/client.ts";
import { explain } from "../runtime/kubernetes/failure.ts";
import { age } from "../runtime/kubernetes/pods.ts";
import { verdictLine } from "../runtime/kubernetes/rollout.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import { look, render } from "../runtime/kubernetes/wait.ts";
import type { Outcome } from "../values.ts";
import { KIND, titleOf } from "../watch.ts";
import type { RolloutSpec } from "../watch.ts";
import { checkUnchanged, lookOnce, outputOf, startCommand } from "./execute.ts";
import type { Call } from "./params.ts";
import { planRollback, planRun, refusal, runningText } from "./plan.ts";
import type { Plan } from "./plan.ts";
import type { DeployRecord, RecordedOutcome, Records } from "./records.ts";

/** What the actions need from outside: the clock, how long a command may run, and what was run from here. */
export interface Context {
    now(): number;
    /** For tests: how long a command that changes the cluster may run. Default: helm six minutes, kubectl one. */
    writeTimeoutMs: number | undefined;
    records: Records;
}

const kindOf = (name: string) => jig().environments.kindOf(name);

// ---- plan -----------------------------------------------------------------------------------------------------------------

/** `plan`: the versions running now and the one requested, and the command that would deploy it. */
export async function planAction(call: Extract<Call, { action: "plan" }>, kube: Kube): Promise<Outcome> {
    const { env, version } = call;
    const kind = kindOf(env.name);
    const head = `Deploy plan for ${env.service} in ${env.name} (${kind}):`;
    const why = refusal("run", env, kind);
    if (why !== undefined) {
        // There is no command to show, but what runs now is still worth knowing.
        const { rollout } = await look(kube, undefined);
        return {
            text: [head, `A deploy run would be refused: ${why}.`, `Running now: ${runningText(rollout)}`].join("\n"),
            facts: { refused: true },
            details: { refused: true, running: rollout.tags },
        };
    }
    const plan = await planRun(env, version, kube, kind);
    return {
        text: [
            `${head} method ${plan.method}.`,
            `Running now: ${plan.from}`,
            `Requested:   ${version}${plan.same ? " (already running: a deploy would change the release and not the version)" : ""}`,
            `Rollout now: ${verdictLine(plan.rollout, kube.target, undefined)}`,
            `Command:     ${plan.line}`,
            "deploy run asks the user first and does not wait for the rollout; deploy watch does.",
        ].join("\n"),
        facts: { method: plan.method, same: plan.same },
        details: { method: plan.method, running: plan.rollout.tags, requested: version },
    };
}

// ---- run and rollback -----------------------------------------------------------------------------------------------------

/** The name of the program and its first word, for a message: `helm upgrade`, `kubectl set`. */
function nameOf(plan: Plan): string {
    return plan.command.program === "helm" ? `helm ${plan.command.args[0]}` : `kubectl ${plan.command.verb}`;
}

/**
 * Runs the command of a plan, once, after checking that it is still what the user approved. A command that fails is an error
 * that says why. One whose outcome is unknown is an error too, with one read of the rollout, and it is never run again.
 */
async function change(plan: Plan, kube: Kube, toolCallId: string, ctx: Context): Promise<Outcome> {
    checkUnchanged(toolCallId, plan);
    const { env } = plan;
    const where = `${env.service} in ${env.name}`;
    const remember = (outcome: RecordedOutcome): void => {
        const record: DeployRecord = {
            action: plan.action,
            method: plan.method,
            from: plan.from,
            to: plan.to,
            version: plan.version,
            at: ctx.now(),
            outcome,
        };
        ctx.records.remember(env.service, env.name, record);
        // A call that ends in an error cannot hand its facts back, so they are added here. A call that started the command
        // hands them back in its outcome.
        if (outcome !== "started") jig().addFacts(toolCallId, { method: plan.method, outcome });
    };

    const ended = await startCommand(kube, plan.command, ctx.writeTimeoutMs);
    if (ended.kind === "unknown") {
        remember("unknown");
        const seen = await lookOnce(kube, plan.version, ctx.now());
        const what = plan.action === "run" ? `the deploy of ${plan.to}` : "the rollback";
        throw new Error(
            `deploy ${plan.action}: ${ended.why}, so it is unknown whether ${what} took effect in ${where}. It was not run again. ` +
                `One look at the rollout now:\n${seen}\n` +
                "Check with deploy status before doing anything else, and tell the user. Do not run it again unless the user says so",
        );
    }
    if (ended.result.code !== 0) {
        remember("failed");
        throw explain(ended.result.stderr, ended.result.code, nameOf(plan), kube.target, "change");
    }

    remember("started");
    const what =
        plan.action === "run"
            ? `the deploy of ${plan.to} to ${where} with ${plan.method}`
            : `the rollback of ${where} with ${plan.method} to ${plan.to}`;
    const next =
        plan.version === undefined
            ? "Nothing waits for the rollout: runtime rollout shows how it goes."
            : `Nothing waits for the rollout: deploy watch with version ${plan.version} reports when it ends, or runtime rollout with waitFor.`;
    const printed = outputOf(ended.result.stdout);
    return {
        text: [`Started ${what} (it was running ${plan.from}). ${next}`, ...(printed === "" ? [] : [printed])].join("\n"),
        facts: { method: plan.method, outcome: "started" },
        details: { method: plan.method, action: plan.action, from: plan.from, to: plan.to },
    };
}

/** `run`: deploys a version. */
export async function runAction(call: Extract<Call, { action: "run" }>, kube: Kube, toolCallId: string, ctx: Context): Promise<Outcome> {
    return change(await planRun(call.env, call.version, kube, kindOf(call.env.name)), kube, toolCallId, ctx);
}

/** `rollback`: goes back one revision. */
export async function rollbackAction(call: Extract<Call, { action: "rollback" }>, kube: Kube, toolCallId: string, ctx: Context): Promise<Outcome> {
    return change(await planRollback(call.env, kube, kindOf(call.env.name)), kube, toolCallId, ctx);
}

// ---- status ---------------------------------------------------------------------------------------------------------------

/** The last deploy or rollback run from here, as a sentence. */
function recordLine(last: DeployRecord | undefined, now: number): string {
    if (last === undefined) return "No deploy or rollback was run from here in this session. The rollout is as the cluster shows it now.";
    const what = last.action === "run" ? `the deploy of ${last.to} with ${last.method}` : `the rollback with ${last.method} to ${last.to}`;
    const how = {
        started: "started",
        failed: "failed",
        unknown: "cut short, so whether it took effect is unknown, and it was not run again",
    }[last.outcome];
    return `Last run from here: ${what}, ${age(last.at, now)} ago, while ${last.from} was running: ${how}.`;
}

/** `status`: the last deploy run from here, and the rollout. */
export async function statusAction(call: Extract<Call, { action: "status" }>, kube: Kube, ctx: Context): Promise<Outcome> {
    const { env } = call;
    const last = ctx.records.last(env.service, env.name);
    // The rollout is judged against the version the last deploy put on, unless that one failed.
    const version = last !== undefined && last.outcome !== "failed" ? last.version : undefined;
    const snapshot = await look(kube, version);
    return {
        text: [recordLine(last, ctx.now()), render(kube, snapshot, version, ctx.now())].join("\n"),
        facts: { verdict: snapshot.rollout.verdict, last: last?.outcome ?? "none" },
        details: { verdict: snapshot.rollout.verdict, last: last ?? null },
    };
}

// ---- watch ----------------------------------------------------------------------------------------------------------------

/** `watch`: starts the background watch `ops-rollout`, and returns at once. */
export function watchAction(call: Extract<Call, { action: "watch" }>, ctx: Context): Outcome {
    const { env, version, timeoutMinutes } = call;
    const title = titleOf(env.service, env.name, version);
    const open = jig().watches.list().find((watch) => watch.kind === KIND && watch.status === "open" && watch.title === title);
    if (open !== undefined) {
        return {
            text: `Already watching the ${title} as ${open.id}. One message arrives when it ends.`,
            facts: { watch: "existing" },
            details: { id: open.id },
        };
    }
    const startedAt = ctx.now();
    // The watch gives up a few seconds before the engine does, so that the last poll is ours and can say how far it got.
    const spec: RolloutSpec = { service: env.service, environment: env.name, version, startedAt, deadline: startedAt + timeoutMinutes * 60_000 - 5_000 };
    const id = jig().watches.start({ kind: KIND, spec, title, timeoutMinutes, stallMinutes: Math.max(1, Math.ceil(timeoutMinutes / 2)) });
    return {
        text:
            `Watching the ${title} as ${id}. One message arrives when every pod is ready on ${version}, when a pod cannot come up, ` +
            `or after ${timeoutMinutes} minutes. The watch tool lists and stops watches.`,
        facts: { watch: "started" },
        details: { id, spec },
    };
}
