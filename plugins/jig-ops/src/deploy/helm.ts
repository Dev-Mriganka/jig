// The Helm deploy method: `helm upgrade --install` to deploy a version, `helm rollback` to go back one revision. This
// is also the only module that builds helm arguments and starts helm.
//
// The release, the chart, the values file and the `--set` pairs come from the catalog; the context and the namespace
// from the environment's Kubernetes runtime; the version from a call, after it was checked to be an image tag. Nothing
// else reaches the command line, and helm is started from an argument list, never a shell.
import { jig } from "../../../jig-core/src/client.ts";
import type { RunResult } from "../../../jig-core/src/contract.ts";
import type { Target } from "../runtime/kubernetes/config.ts";
import { explain } from "../runtime/kubernetes/failure.ts";
import { programEnvironment, wasCut } from "../runtime/kubernetes/kubectl.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import { checkPattern, isObject, objects, str } from "../values.ts";
import type { Command, Deployer, Rollback } from "./command.ts";

export interface HelmDeploy {
    method: "helm";
    release: string;
    /** A folder, a chart of a repository such as `acme/orders-api`, or an OCI address. */
    chart: string;
    valuesFile?: string;
    /** `--set` pairs, in the order the catalog gives them. */
    set: ReadonlyArray<readonly [key: string, value: string]>;
}

const FIELDS: ReadonlySet<string> = new Set(["method", "release", "chart", "valuesFile", "set"]);
/** Helm's own rule for a release name: lower case letters, digits and `-`, 53 characters at most. */
const RELEASE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
/** A path or an address: no white space, no control character, and not something helm would read as a flag. */
const LOCATION = /^[^\s-]\S{0,299}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SET_KEY = /^[A-Za-z_][A-Za-z0-9_.[\]\\-]{0,99}$/;
/**
 * Helm splits `--set` on commas and reads braces and backslashes, so a value that holds none of them is what it says.
 */
const SET_VALUE = /^[A-Za-z0-9._:/@+%~=-]{0,200}$/;
const MAX_SET = 20;
/** The key the deploy sets from the version, so that the catalog cannot set it to something else. */
const VERSION_KEY = "image.tag";

function checkLocation(value: unknown, key: string, what: string, errors: string[]): string | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, ${what}`);
        return undefined;
    }
    if (typeof value === "string" && LOCATION.test(value) && !CONTROL.test(value)) return value;
    errors.push(`${key}: must be ${what}, up to 300 characters with no white space and not starting with -`);
    return undefined;
}

/** A value of the catalog as the text helm gets, or undefined when it is not a number, a boolean or text. */
function scalarText(value: unknown): string | undefined {
    if (typeof value === "string" || typeof value === "boolean") return String(value);
    return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function checkSet(raw: unknown, key: string, errors: string[]): Array<[string, string]> | undefined {
    if (!isObject(raw)) {
        errors.push(`${key}: must be an object of Helm values, such as { "replicaCount": 2 }`);
        return undefined;
    }
    const entries = Object.entries(raw);
    if (entries.length > MAX_SET) {
        errors.push(`${key}: at most ${MAX_SET} values`);
        return undefined;
    }
    const before = errors.length;
    const pairs: Array<[string, string]> = [];
    for (const [name, value] of entries) {
        const text = scalarText(value);
        if (name === VERSION_KEY) {
            errors.push(`${key}.${name}: the deploy sets this from the version it is given, so it cannot be set here`);
        } else if (!SET_KEY.test(name)) {
            errors.push(`${key}: ${JSON.stringify(name.slice(0, 30))} is not a usable Helm value name`);
        } else if (text === undefined || !SET_VALUE.test(text)) {
            errors.push(
                `${key}.${name}: must be a number, a boolean or text of letters, digits and . _ : / @ + % ~ = - ` +
                    "(up to 200)",
            );
        } else {
            pairs.push([name, text]);
        }
    }
    return errors.length > before ? undefined : pairs;
}

/** Checks the `deploy` object of a Helm environment. The catalog has seen that its `method` is `helm`. */
export function checkHelm(raw: Record<string, unknown>, at: string, errors: string[]): HelmDeploy | undefined {
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    const release = checkPattern(
        raw.release,
        RELEASE,
        `${at}.release`,
        "a Helm release name: lower case letters, digits and -, up to 53 characters, such as orders-api",
        errors,
    );
    const chart = checkLocation(raw.chart, `${at}.chart`, "the chart, such as deploy/chart or acme/orders-api", errors);
    const valuesFile =
        raw.valuesFile === undefined
            ? undefined
            : checkLocation(raw.valuesFile, `${at}.valuesFile`, "a values file", errors);
    const set = raw.set === undefined ? [] : checkSet(raw.set, `${at}.set`, errors);

    if (errors.length > before || release === undefined || chart === undefined || set === undefined) return undefined;
    return { method: "helm", release, chart, ...(valuesFile === undefined ? {} : { valuesFile }), set };
}

// ---- the commands ---------------------------------------------------------------------------------------------------

/** `helm upgrade --install`, with the version last among the `--set` pairs so that nothing before it can win. */
export function upgradeArgs(config: HelmDeploy, target: Target, version: string): string[] {
    return [
        "upgrade",
        "--install",
        config.release,
        config.chart,
        "--kube-context",
        target.context,
        "--namespace",
        target.namespace,
        ...(config.valuesFile === undefined ? [] : ["--values", config.valuesFile]),
        ...config.set.flatMap(([key, value]) => ["--set", `${key}=${value}`]),
        "--set",
        `${VERSION_KEY}=${version}`,
        "--wait=false",
    ];
}

export function rollbackArgs(config: HelmDeploy, target: Target): string[] {
    return ["rollback", config.release, "--kube-context", target.context, "--namespace", target.namespace];
}

/** The last two revisions, oldest first. */
function historyArgs(config: HelmDeploy, target: Target): string[] {
    return [
        "history",
        config.release,
        "--kube-context",
        target.context,
        "--namespace",
        target.namespace,
        "--max",
        "2",
        "-o",
        "json",
    ];
}

/** The values a revision ran with, the chart's defaults included. */
function valuesArgs(config: HelmDeploy, target: Target, revision: number): string[] {
    return [
        "get",
        "values",
        config.release,
        "--revision",
        String(revision),
        "--all",
        "-o",
        "json",
        "--kube-context",
        target.context,
        "--namespace",
        target.namespace,
    ];
}

// ---- starting helm --------------------------------------------------------------------------------------------------

/** How long and how much one helm command may take. */
export interface HelmLimits {
    timeoutMs: number;
    maxBytes: number;
}

export const HELM_READ: HelmLimits = { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 };
/**
 * Long enough for helm's own five minutes for hooks, so that
 * it is helm that gives up and not this plugin that kills it.
 */
export const HELM_CHANGE: HelmLimits = { timeoutMs: 6 * 60_000, maxBytes: 1024 * 1024 };

/** The helm commands that can be started: the two that change a release, and the two that read its history. */
function allowed(args: readonly string[]): boolean {
    const [command, next] = args;
    return (
        (command === "upgrade" && next === "--install") ||
        command === "rollback" ||
        command === "history" ||
        (command === "get" && next === "values")
    );
}

/** Starts helm and returns what it did, a timeout included: for a change that means the outcome is unknown. */
export async function startHelm(kube: Kube, args: readonly string[], limits: HelmLimits): Promise<RunResult> {
    if (!allowed(args)) {
        throw new Error(
            `helm ${args.slice(0, 2).join(" ")} is not allowed: ` +
                "the tools run only upgrade --install, rollback, history and get values",
        );
    }
    return jig().exec.run("helm", args, {
        timeoutMs: limits.timeoutMs,
        signal: kube.signal,
        maxOutputBytes: limits.maxBytes,
        env: programEnvironment(),
    });
}

/** The JSON a helm read prints, parsed. A failure is one line that says what to do. */
async function readHelmJson(kube: Kube, args: readonly string[]): Promise<unknown> {
    const what = `helm ${args[0]}`;
    const result = await startHelm(kube, args, HELM_READ);
    if (result.timedOut) {
        throw new Error(`${what} timed out after ${HELM_READ.timeoutMs / 1000} s: the cluster is slow or unreachable`);
    }
    if (result.code !== 0) throw explain(result.stderr, result.code, what, kube.target);
    try {
        return JSON.parse(result.stdout);
    } catch {
        const why = wasCut(result.stdout, HELM_READ.maxBytes)
            ? `its answer is longer than ${HELM_READ.maxBytes / (1024 * 1024)} MiB`
            : "it printed no JSON";
        throw new Error(`${what} could not be read: ${why}`);
    }
}

// ---- the method -----------------------------------------------------------------------------------------------------

/** The image tag a revision ran with, from its values: `image.tag`. */
function versionOf(values: unknown): string | undefined {
    const image = isObject(values) ? values.image : undefined;
    const tag = isObject(image) ? image.tag : undefined;
    return typeof tag === "number" ? String(tag) : str(tag);
}

export function helmDeployer(config: HelmDeploy): Deployer {
    return {
        method: "helm",

        async deploy(kube, version): Promise<Command> {
            return { program: "helm", args: upgradeArgs(config, kube.target, version) };
        },

        async rollback(kube): Promise<Rollback> {
            const history = objects(await readHelmJson(kube, historyArgs(config, kube.target)))
                .map((entry) => ({ revision: typeof entry.revision === "number" ? entry.revision : 0 }))
                .sort((a, b) => a.revision - b.revision);
            const previous = history.length < 2 ? undefined : history[history.length - 2];
            if (previous === undefined || previous.revision < 1) {
                throw new Error(
                    `The Helm release ${config.release} has one revision, so there is nothing to go back to`,
                );
            }
            // The values say what the revision ran. A chart that does not take the version as image.tag shows none.
            const values = await readHelmJson(kube, valuesArgs(config, kube.target, previous.revision));
            return {
                command: { program: "helm", args: rollbackArgs(config, kube.target) },
                revision: `revision ${previous.revision}`,
                version: versionOf(values),
            };
        },
    };
}
