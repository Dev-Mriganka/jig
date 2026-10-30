// The kubectl-image deploy method: `kubectl set image` to deploy a version, `kubectl rollout undo` to go back one revision.
//
// Only the tag changes. The image is read from the workload as it is now, its tag and digest are taken off, and the
// version is put on instead, so a deploy cannot move a service to another registry or repository. kubectl's own commands
// are built and started in kubectl.ts; this module only chooses their arguments.
import { DNS_LABEL } from "../runtime/kubernetes/config.ts";
import { getJson } from "../runtime/kubernetes/kubectl.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import { containersOf, withoutTag } from "../runtime/kubernetes/pods.ts";
import { checkPattern, isObject, objects, shortList } from "../values.ts";
import type { Command, Deployer, Rollback } from "./command.ts";

export interface KubectlImageDeploy {
    method: "kubectl-image";
    /** `deployment/orders-api` or `statefulset/orders-api`. */
    workload: string;
    /** The container of the workload whose image is changed. */
    container: string;
}

const FIELDS: ReadonlySet<string> = new Set(["method", "workload", "container"]);
/** The two kinds of workload the rollout code reads too. */
const WORKLOAD = /^(deployment|statefulset)\/[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/** An image without its tag: what a registry path can hold. No white space, and not something kubectl reads as a flag. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,250}$/;

/** Checks the `deploy` object of a kubectl-image environment. The catalog has seen that its `method` is `kubectl-image`. */
export function checkKubectlImage(raw: Record<string, unknown>, at: string, errors: string[]): KubectlImageDeploy | undefined {
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    const workload = checkPattern(raw.workload, WORKLOAD, `${at}.workload`, "deployment/<name> or statefulset/<name>, such as deployment/orders-api", errors);
    const container = checkPattern(raw.container, DNS_LABEL, `${at}.container`, "a container name of that workload", errors);

    if (errors.length > before || workload === undefined || container === undefined) return undefined;
    return { method: "kubectl-image", workload, container };
}

/** The containers a workload's pod template runs. */
function templateContainers(workload: unknown): unknown {
    const spec = isObject(workload) && isObject(workload.spec) ? workload.spec : {};
    const template = isObject(spec.template) && isObject(spec.template.spec) ? spec.template.spec : {};
    return template.containers;
}

/** One earlier state of the workload, and the version its container ran. */
interface Revision {
    revision: number;
    version: string | undefined;
}

function ownedBy(item: Record<string, unknown>, kind: string, name: string): boolean {
    const metadata = isObject(item.metadata) ? item.metadata : {};
    return objects(metadata.ownerReferences).some((owner) => owner.kind === kind && owner.name === name);
}

function versionIn(containers: unknown, name: string): string | undefined {
    return containersOf(containers).find((container) => container.name === name)?.tag;
}

/** A deployment keeps one replica set per revision, numbered in an annotation. */
function deploymentRevisions(replicaSets: unknown, name: string, container: string): Revision[] {
    return objects(isObject(replicaSets) ? replicaSets.items : undefined)
        .filter((item) => ownedBy(item, "Deployment", name))
        .map((item) => {
            const metadata = isObject(item.metadata) ? item.metadata : {};
            const annotations = isObject(metadata.annotations) ? metadata.annotations : {};
            return {
                revision: Number(annotations["deployment.kubernetes.io/revision"]),
                version: versionIn(templateContainers(item), container),
            };
        })
        .filter((entry) => Number.isInteger(entry.revision));
}

/** A statefulset keeps one controller revision per revision, with the pod template in its data. */
function statefulSetRevisions(controllerRevisions: unknown, name: string, container: string): Revision[] {
    return objects(isObject(controllerRevisions) ? controllerRevisions.items : undefined)
        .filter((item) => ownedBy(item, "StatefulSet", name))
        .map((item) => ({
            revision: typeof item.revision === "number" ? item.revision : Number.NaN,
            version: versionIn(templateContainers(item.data), container),
        }))
        .filter((entry) => Number.isInteger(entry.revision));
}

export function kubectlImageDeployer(config: KubectlImageDeploy): Deployer {
    const [kind, name] = config.workload.split("/") as [string, string];

    return {
        method: "kubectl-image",

        async deploy(kube: Kube, version): Promise<Command> {
            const containers = containersOf(templateContainers(await getJson(kube, config.workload)));
            const current = containers.find((container) => container.name === config.container);
            if (current === undefined) {
                throw new Error(
                    `${config.workload} has no container ${config.container} (it has ${shortList(containers.map((container) => container.name), 120)}): ` +
                        'fix "container" in the ops catalog of jig.json (deploy)',
                );
            }
            const repository = withoutTag(current.image);
            if (!REPOSITORY.test(repository)) {
                throw new Error(`The image of ${config.container} in ${config.workload} is not one a deploy can put a tag on`);
            }
            return { program: "kubectl", verb: "set", args: ["image", config.workload, `${config.container}=${repository}:${version}`] };
        },

        async rollback(kube: Kube): Promise<Rollback> {
            const revisions =
                kind === "deployment"
                    ? deploymentRevisions(await getJson(kube, "replicasets"), name, config.container)
                    : statefulSetRevisions(await getJson(kube, "controllerrevisions"), name, config.container);
            // kubectl goes back to the second newest revision.
            const previous = revisions.sort((a, b) => b.revision - a.revision)[1];
            if (previous === undefined) {
                throw new Error(`${config.workload} has no earlier revision to go back to (or it does not exist)`);
            }
            return {
                command: { program: "kubectl", verb: "rollout", args: ["undo", config.workload] },
                revision: `revision ${previous.revision}`,
                version: previous.version,
            };
        },
    };
}
