// kubectl's complaint (its stderr) as the one line a person or the model can act on. A raw message is only ever shown
// as its first lines, with any credential in an address removed.
import type { Target } from "./config.ts";
import { oneLine } from "./values.ts";

// Checked in this order: "Unable to connect ... getting credentials ... token expired" is a sign-in problem, not a
// network one, although it starts like one.
const NOT_SIGNED_IN = new RegExp(
    [
        "Token has expired",
        "SSO session",
        "ExpiredToken",
        "token (?:is )?expired",
        "\\(Unauthorized\\)",
        "getting credentials",
        "exec plugin",
        "Unable to locate credentials",
    ].join("|"),
    "i",
);
const UNREACHABLE = new RegExp(
    [
        "Unable to connect",
        "no such host",
        "dial tcp",
        "i/o timeout",
        "TLS handshake timeout",
        "Client\\.Timeout",
        "context deadline exceeded",
        "connection refused",
        "was refused",
        "network is unreachable",
        "no route to host",
    ].join("|"),
    "i",
);
const NO_CONTEXT = /context "[^"]*" does not exist|no context exists/i;
const FORBIDDEN = /Error from server \(Forbidden\)/i;
const NO_NAMESPACE = /Error from server \(NotFound\): namespaces? "[^"]*" not found/i;
const NO_POD = /Error from server \(NotFound\): pods? "[^"]*" not found/i;
const NOT_STARTED = /is waiting to start|ContainerCreating|PodInitializing/i;
const NO_PREVIOUS = /previous terminated container .* not found/i;

/** Removes the user name and password from any address in `text`. */
function scrub(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
}

/**
 * The first few non-empty lines of kubectl's complaint, on one line. The lines are taken before anything is scrubbed,
 * and each is cut: kubectl's complaint can be megabytes long, and nothing here may take longer for it.
 */
export function firstLines(text: string, count = 3): string {
    const lines: string[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed !== "") lines.push(trimmed.slice(0, 500));
        if (lines.length === count) break;
    }
    return oneLine(scrub(lines.join("; ")), 400);
}

/** `orders-api in staging`. */
function where(target: Target): string {
    return `${target.service} in ${target.environment}`;
}

/** `what` names the command that failed, such as "kubectl get". */
export function explain(stderr: string, code: number, what: string, target: Target): Error {
    const reason = firstLines(stderr, 1);
    if (NOT_SIGNED_IN.test(stderr)) {
        return new Error(
            `kubectl is not signed in to context ${target.context} (${reason}): ` +
                "the user signs in again for that context outside Pi, then retry",
        );
    }
    if (UNREACHABLE.test(stderr)) {
        return new Error(
            `Cannot reach the cluster of context ${target.context} for ${where(target)}: ` +
                "check the network or VPN, and retry once it is back",
        );
    }
    if (NO_CONTEXT.test(stderr)) {
        return new Error(
            `kubectl has no context ${target.context} (${where(target)}): ` +
                'fix "context" in the k8s section of jig.json, or add the context to the kubeconfig',
        );
    }
    if (FORBIDDEN.test(stderr)) {
        return new Error(`The kubeconfig user is not allowed to read ${where(target)} (${reason}): tell the user`);
    }
    if (NO_NAMESPACE.test(stderr)) {
        return new Error(
            `Namespace ${target.namespace} does not exist in context ${target.context}: ` +
                'fix "namespace" in the k8s section of jig.json',
        );
    }
    if (NO_POD.test(stderr)) {
        return new Error("The pod is gone: it was replaced after it was listed. Run pods again");
    }
    if (NO_PREVIOUS.test(stderr)) {
        return new Error("The pod has no previous container log: its container has not restarted");
    }
    if (NOT_STARTED.test(stderr)) {
        return new Error(
            `The container is not running yet (${reason}): ` +
                "try again shortly, or read the log of its last run with previous: true",
        );
    }
    return new Error(`${what} failed (exit ${code}): ${firstLines(stderr) || "no error text"}`);
}
