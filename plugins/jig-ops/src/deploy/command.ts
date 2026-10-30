// What a deploy method hands the deploy tool: the command to run, as data, and what a rollback goes back to. A method
// builds commands and reads the revision history; the tool decides whether to run one (see plan.ts and tool.ts).
import type { Kube } from "../runtime/kubernetes/kubectl.ts";

/**
 * One program to start and its arguments. kubectl's are the verb and what follows it, because kubectl.ts alone puts the
 * context and the namespace in front; helm's are all of them, in the order the deploy method writes them.
 */
export type Command =
    | { program: "kubectl"; verb: "set" | "rollout"; args: readonly string[] }
    | { program: "helm"; args: readonly string[] };

/** Where a rollback goes back to. */
export interface Rollback {
    command: Command;
    /** The revision, as a person reads it: `revision 4`. */
    revision: string;
    /** The version that revision ran, when it can be read. */
    version: string | undefined;
}

/** A way to deploy a version of a service, and to go back one revision. Both only read the cluster until the tool runs
 *  the command they return. */
export interface Deployer {
    /** The name the catalog gives it: `helm` or `kubectl-image`. */
    method: string;
    deploy(kube: Kube, version: string): Promise<Command>;
    rollback(kube: Kube): Promise<Rollback>;
}

/** Characters that need no quotes on a command line. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A command line as one line of text, quoted where a shell would need it. It is for reading: nothing here is ever run
 *  through a shell. */
export function lineOf(program: string, argv: readonly string[]): string {
    return [program, ...argv].map((arg) => (PLAIN.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}
