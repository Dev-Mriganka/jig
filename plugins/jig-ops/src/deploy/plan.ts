// What a deploy or a rollback would do, worked out before anything is done. The same plan serves two callers:
//   - jig-core asks for the preview when a rule says "ask", and shows it to the user;
//   - execute() plans again, and refuses to run if the plan differs from the one the user approved.
// So whatever changed while the user was reading (a new version running, a moved revision) is caught, and the deploy
// does not go over it.
//
// A plan reads the cluster and changes nothing. Its fingerprint covers what the user is shown that can matter: the
// service, the environment, the method, the exact argument list, the versions running now, and where the command goes.
import type { EnvironmentKind, Preview } from "../../../jig-core/src/contract.ts";
import type { Environment } from "../catalog.ts";
import type { Target } from "../runtime/kubernetes/config.ts";
import { argvOf, CHANGE } from "../runtime/kubernetes/kubectl.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import type { Rollout } from "../runtime/kubernetes/rollout.ts";
import { look } from "../runtime/kubernetes/wait.ts";
import { lineOf } from "./command.ts";
import type { Command } from "./command.ts";
import { deployerOf } from "./methods.ts";
import { digest } from "../values.ts";

/**
 * Why a deploy or a rollback may not be run in this environment, or undefined when it may. The floor of jig-core denies
 * a write to production anyway; this says so before anyone is asked, and says why. An environment the catalog gives no
 * deploy method is one the agent does not deploy to.
 */
export function refusal(action: "run" | "rollback", env: Environment, kind: EnvironmentKind): string | undefined {
    const where = `${env.service} in ${env.name}`;
    if (kind === "production") {
        // jig-core counts a name it does not know as production, so a test environment that was never defined looks
        // like this one.
        const hint =
            env.name === "production"
                ? ""
                : `. jig-core counts a name it does not know as production: if ${env.name} is a test environment, ` +
                  'define it under "environments" in jig.json with kind test';
        return `${where} is production: the agent never changes production${hint}`;
    }
    if (env.deploy === undefined) {
        return `the catalog gives ${where} no deploy method: the agent deploys only where the catalog names one`;
    }
    if (action === "rollback" && kind !== "test") {
        return `a rollback works in test environments only, and ${env.name} is ${kind} for jig-core`;
    }
    return undefined;
}

/** `staging (test)`, or just `production` when the name says what it is. */
export function environmentText(name: string, kind: EnvironmentKind): string {
    return name === kind ? name : `${name} (${kind})`;
}

/** The exact argument list that is started for a command. */
export function argvOfCommand(command: Command, target: Target): string[] {
    return command.program === "helm" ? [...command.args] : argvOf(target, command.verb, command.args, CHANGE);
}

/** The command as one line of text, for people. */
export function lineOfCommand(command: Command, target: Target): string {
    return lineOf(command.program, argvOfCommand(command, target));
}

/** The versions running now, as a person reads them. */
export function runningText(rollout: Rollout): string {
    if (rollout.live.length === 0) return "none (no pods are running)";
    if (rollout.tags.length === 0) return "no tag (the images have none)";
    const tags = [...rollout.tags].sort().join(", ");
    return rollout.tags.length > 1 ? `${tags} (a rollout is in progress)` : tags;
}

export interface Plan {
    action: "run" | "rollback";
    env: Environment;
    method: string;
    command: Command;
    /** The command as one line of text. */
    line: string;
    /** The versions running now, as a person reads them. */
    from: string;
    /** The version a deploy puts on, or where a rollback goes back to, as a person reads it. */
    to: string;
    /** The version the pods should run afterwards, when it is known. */
    version: string | undefined;
    /** The rollout as it was read for the plan. */
    rollout: Rollout;
    /** True for a deploy of the version that is the only one running. */
    same: boolean;
    fingerprint: string;
    preview: Preview;
}

interface PlanInputs {
    action: "run" | "rollback";
    env: Environment;
    kube: Kube;
    kind: EnvironmentKind;
    command: Command;
    rollout: Rollout;
    to: string;
    version: string | undefined;
}

function build(inputs: PlanInputs): Plan {
    const { action, env, kube, kind, command, rollout, to, version } = inputs;
    const method = env.deploy?.method ?? "";
    const line = lineOfCommand(command, kube.target);
    const from = runningText(rollout);
    const same = action === "run" && rollout.tags.length === 1 && rollout.tags[0] === version;
    const row = (label: string, value: string): string => `${label}:`.padEnd(15) + value;
    const body = [
        row("Service", env.service),
        row("Environment", environmentText(env.name, kind)),
        row("Method", method),
        row("Running now", from),
        row(action === "run" ? "Deploying" : "Going back to", to),
        row("Command", line),
        "",
        "The command runs once, without a shell. If it is cut short, whether it took effect is unknown, " +
            "and it is not run again.",
        ...(same ? ["", `Note: ${version} is already running, so this changes the release and not the version.`] : []),
    ].join("\n");
    const summary =
        action === "run"
            ? `deploy ${to} to ${env.service} in ${env.name} with ${method} (now ${from})`
            : `roll ${env.service} in ${env.name} back to ${to} with ${method} (now ${from})`;
    const fingerprint = digest(
        "deploy",
        action,
        env.service,
        env.name,
        method,
        argvOfCommand(command, kube.target),
        [...rollout.tags].sort(),
        rollout.live.length === 0,
        to,
    );
    return {
        action,
        env,
        method,
        command,
        line,
        from,
        to,
        version,
        rollout,
        same,
        fingerprint,
        preview: { summary, body, format: "text", fingerprint },
    };
}

/** What deploying `version` would do: the rollout now, and the command. */
export async function planRun(env: Environment, version: string, kube: Kube, kind: EnvironmentKind): Promise<Plan> {
    const deploy = env.deploy;
    if (deploy === undefined) throw new Error(`${env.service} in ${env.name} has no deploy method`);
    const { rollout } = await look(kube, undefined);
    const command = await deployerOf(deploy).deploy(kube, version);
    return build({ action: "run", env, kube, kind, command, rollout, to: version, version });
}

/** What going back one revision would do: the rollout now, the command, and the revision it goes back to. */
export async function planRollback(env: Environment, kube: Kube, kind: EnvironmentKind): Promise<Plan> {
    const deploy = env.deploy;
    if (deploy === undefined) throw new Error(`${env.service} in ${env.name} has no deploy method`);
    const { rollout } = await look(kube, undefined);
    const back = await deployerOf(deploy).rollback(kube);
    const to =
        back.version === undefined
            ? `${back.revision} (its version could not be read)`
            : `${back.revision}, which ran ${back.version}`;
    return build({ action: "rollback", env, kube, kind, command: back.command, rollout, to, version: back.version });
}
