// The only module that builds kubectl arguments and starts kubectl.
// Nothing else in the plugin touches a kubectl command line.
//
// The context and namespace come from the catalog's target, the verb from the lists below, and everything else from a
// value a parseCall or a kubectl answer has already vouched for. kubectl is started by jig-core from an argument list,
// never a shell, so a character in a value cannot mean anything but itself.
import { jig } from "../../../../jig-core/src/client.ts";
import type { RunResult } from "../../../../jig-core/src/contract.ts";
import type { Target } from "./config.ts";
import { explain } from "./failure.ts";

/**
 * The kubectl commands that read: `get` and `logs`, and `exec`, which only the in-pod health check uses, to run curl in
 * a pod. A verb that is not here, or in WRITES, cannot be built: `delete`, `scale`, `apply`, `edit`, `rollout restart`,
 * `port-forward`, `cp` and the rest are not a matter of being refused later, they are not in the code.
 */
export const READS = ["get", "logs", "exec"] as const;

/** The two commands that change the cluster. Only the deploy methods build them, and only the deploy tool runs them. */
export const WRITES = [
    { verb: "set", then: "image" },
    { verb: "rollout", then: "undo" },
] as const;

export type Verb = (typeof READS)[number] | (typeof WRITES)[number]["verb"];

export interface Kube {
    target: Target;
    signal: AbortSignal | undefined;
}

/** How long and how much one kubectl command may take. */
export interface Limits {
    /** The process is stopped after this long. */
    timeoutMs: number;
    /** kubectl's own bound on its requests to the cluster, in seconds. */
    requestSec: number;
    /** Output beyond this many bytes is cut. */
    maxBytes: number;
}

export const READ: Limits = { timeoutMs: 30_000, requestSec: 25, maxBytes: 8 * 1024 * 1024 };
export const LOGS: Limits = { timeoutMs: 60_000, requestSec: 50, maxBytes: 2 * 1024 * 1024 };
/** For `set image` and `rollout undo`, which answer as soon as the cluster has accepted the change. */
export const CHANGE: Limits = { timeoutMs: 60_000, requestSec: 50, maxBytes: 1024 * 1024 };

/** The text jig-core adds to output it cut at `limit` bytes. It is the only sign of a cut, and a cut reply has lost its
 *  end: a JSON document no longer parses, and curl's status line is gone. */
export function cutMark(limit: number): string {
    return `\n[output cut at ${limit} bytes]\n`;
}

export function wasCut(stdout: string, limit: number): boolean {
    return stdout.endsWith(cutMark(limit));
}

/** What every command starts with: kubectl's own time limit, and the context and namespace of the target. The `=` form
 *  keeps a value from ever being read as a flag. */
export function argvOf(target: Target, verb: Verb, args: readonly string[], limits: Limits): string[] {
    return [
        `--request-timeout=${limits.requestSec}s`,
        `--context=${target.context}`,
        `--namespace=${target.namespace}`,
        verb,
        ...args,
    ];
}

/** True for a read, and for the two writes, each with the word that must follow it. */
function allowed(verb: string, args: readonly string[]): boolean {
    if ((READS as readonly string[]).includes(verb)) return true;
    return WRITES.some((write) => write.verb === verb && args[0] === write.then);
}

/** jig-core starts programs with a short list of environment variables. kubectl and helm also need to know where the
 *  user's kubeconfig is when it is not in the default place. That is a path, not a secret. */
export function programEnvironment(): Record<string, string> {
    const kubeconfig = process.env.KUBECONFIG;
    return kubeconfig === undefined ? {} : { KUBECONFIG: kubeconfig };
}

/**
 * Starts kubectl and returns what it did, whether it succeeded or not. A command that ran out of time is a result with
 * `timedOut`, not an error, because for a write that means the outcome is unknown, and only the caller knows what to
 * say about that. Reads go through runKubectl.
 */
export async function startKubectl(
    kube: Kube,
    verb: Verb,
    args: readonly string[],
    limits: Limits,
): Promise<RunResult> {
    if (!allowed(verb, args)) {
        const what = [verb, args[0]].filter((word) => word !== undefined).join(" ");
        throw new Error(
            `kubectl ${what} is not allowed: the tools run only get, logs, exec, set image and rollout undo`,
        );
    }
    return jig().exec.run("kubectl", argvOf(kube.target, verb, args, limits), {
        timeoutMs: limits.timeoutMs,
        signal: kube.signal,
        maxOutputBytes: limits.maxBytes,
        env: programEnvironment(),
    });
}

/** Runs a kubectl command that reads, and returns what it did, failed or not. A command that ran out of time is an
 *  error. */
export async function runKubectl(kube: Kube, verb: Verb, args: readonly string[], limits: Limits): Promise<RunResult> {
    const result = await startKubectl(kube, verb, args, limits);
    if (result.timedOut) {
        throw new Error(
            `kubectl ${verb} timed out after ${limits.timeoutMs / 1000} s: the cluster is slow or unreachable`,
        );
    }
    return result;
}

/** The standard output of a kubectl command that worked; a failure is one line that says what to do. */
export async function readKubectl(kube: Kube, verb: Verb, args: readonly string[], limits: Limits): Promise<string> {
    const result = await runKubectl(kube, verb, args, limits);
    if (result.code !== 0) throw explain(result.stderr, result.code, `kubectl ${verb}`, kube.target);
    return result.stdout;
}

/** `kubectl get <resource> -o json`, parsed. `tooMuch` finishes the sentence about an answer that was cut. */
export async function getJson(
    kube: Kube,
    resource: string,
    flags: readonly string[] = [],
    tooMuch = "the selector matches too much",
): Promise<unknown> {
    const out = await readKubectl(kube, "get", [resource, ...flags, "-o", "json"], READ);
    try {
        return JSON.parse(out);
    } catch {
        const why = wasCut(out, READ.maxBytes)
            ? `kubectl's answer is larger than ${READ.maxBytes / (1024 * 1024)} MiB: ${tooMuch}`
            : "kubectl returned output that is not JSON: report it to the user";
        throw new Error(why);
    }
}
