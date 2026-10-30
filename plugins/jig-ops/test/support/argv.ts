// What a kubectl or helm command line of this plugin can look like. There are only a few shapes, and `problems` and
// `helmProblems` say why an argument list is none of them. A test that records the arguments of every call can then show that
// no call is outside the few: not a verb that writes beyond the two there are, not a flag that points a program somewhere
// else, not an argument the model made up.

export interface Expected {
    /** The context and namespace the catalog gives the service. */
    context: string;
    namespace: string;
}

const POD = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const CONTAINER = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_SELECTOR = /^--selector=[A-Za-z0-9._/=,-]+$/;
const WORKLOAD = /^(deployment|statefulset)\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const AS_JSON = JSON.stringify(["-o", "json"]);
/** The command curl runs in the pod, as it is written to kubectl. */
const CURL = ["curl", "-sS", "-m", "20", "-X", "GET", "-w", "\\n__status:%{http_code}"];
/** An image the deploy may set: a repository and a tag, nothing else. */
const IMAGE_ASSIGNMENT = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?=[A-Za-z0-9][A-Za-z0-9._:/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Why `argv` is not a kubectl command this plugin builds. An empty list means it is one. */
export function problems(argv: readonly string[], expected: Expected): string[] {
    const found: string[] = [];
    const [timeout, context, namespace, verb, ...rest] = argv;
    if (timeout === undefined || !/^--request-timeout=\d+s$/.test(timeout)) found.push(`no time limit first: ${timeout}`);
    if (context !== `--context=${expected.context}`) found.push(`the context is not the configured one: ${context}`);
    if (namespace !== `--namespace=${expected.namespace}`) found.push(`the namespace is not the configured one: ${namespace}`);

    switch (verb) {
        case "get": {
            const [resource, ...more] = rest;
            if (resource === "pods") {
                const [selector, ...tail] = more;
                if (selector === undefined || !LABEL_SELECTOR.test(selector)) found.push(`get pods without the target's selector: ${selector}`);
                if (JSON.stringify(tail) !== AS_JSON) found.push(`get pods ends with ${JSON.stringify(tail)}`);
            } else if (["deployments,statefulsets", "replicasets", "controllerrevisions", "events"].includes(resource ?? "")) {
                if (JSON.stringify(more) !== AS_JSON) found.push(`get ${resource} ends with ${JSON.stringify(more)}`);
            } else if (WORKLOAD.test(resource ?? "")) {
                if (JSON.stringify(more) !== AS_JSON) found.push(`get ${resource} ends with ${JSON.stringify(more)}`);
            } else {
                found.push(`get reads something other than pods, workloads, replica sets, controller revisions and events: ${resource}`);
            }
            break;
        }
        case "logs": {
            const [pod, ...more] = rest;
            if (pod === undefined || !POD.test(pod)) found.push(`logs of something that is not a pod name: ${pod}`);
            const flags = more[0] === "-c" ? more.slice(2) : more;
            if (more[0] === "-c" && !CONTAINER.test(more[1] ?? "")) found.push(`logs -c ${more[1]}`);
            const [tail, ...optional] = flags;
            if (tail === undefined || !/^--tail=\d{1,4}$/.test(tail)) found.push(`logs without a tail: ${tail}`);
            for (const flag of optional) {
                if (!/^--since=\d+s$/.test(flag) && flag !== "--previous") found.push(`logs with ${flag}`);
            }
            break;
        }
        case "exec": {
            const [pod, c, container, dashes, ...command] = rest;
            if (pod === undefined || !POD.test(pod)) found.push(`exec in something that is not a pod name: ${pod}`);
            if (c !== "-c" || container === undefined || !CONTAINER.test(container)) found.push("exec without a container");
            if (dashes !== "--") found.push("exec without the -- that ends kubectl's own flags");
            const url = command[command.length - 1];
            if (JSON.stringify(command.slice(0, -1)) !== JSON.stringify(CURL)) found.push(`exec runs ${JSON.stringify(command.slice(0, -1))}`);
            if (url === undefined || !/^http:\/\/localhost:\d+\//.test(url)) found.push(`exec calls ${url}`);
            break;
        }
        case "set": {
            const [image, workload, assignment, ...more] = rest;
            if (image !== "image") found.push(`set ${image}: only set image can be built`);
            if (!WORKLOAD.test(workload ?? "")) found.push(`set image on something that is not a workload: ${workload}`);
            if (!IMAGE_ASSIGNMENT.test(assignment ?? "")) found.push(`set image with ${assignment}`);
            if (more.length > 0) found.push(`set image with more: ${JSON.stringify(more)}`);
            break;
        }
        case "rollout": {
            const [undo, workload, ...more] = rest;
            if (undo !== "undo") found.push(`rollout ${undo}: only rollout undo can be built`);
            if (!WORKLOAD.test(workload ?? "")) found.push(`rollout undo on something that is not a workload: ${workload}`);
            if (more.length > 0) found.push(`rollout undo with more: ${JSON.stringify(more)}`);
            break;
        }
        default:
            found.push(`the verb is ${verb}, not get, logs, exec, set image or rollout undo`);
    }
    return found;
}

export interface ExpectedHelm extends Expected {
    release: string;
}

/** Why `argv` is not a helm command this plugin builds. An empty list means it is one. */
export function helmProblems(argv: readonly string[], expected: ExpectedHelm): string[] {
    const found: string[] = [];
    const where = ["--kube-context", expected.context, "--namespace", expected.namespace];
    const has = (list: readonly string[], run: readonly string[]): boolean =>
        list.some((_, at) => run.every((word, offset) => list[at + offset] === word));
    if (!has(argv, where)) found.push(`the context and the namespace are not the configured ones, together: ${argv.join(" ")}`);

    const [command, ...rest] = argv;
    switch (command) {
        case "upgrade": {
            const [install, release, chart] = rest;
            if (install !== "--install") found.push(`upgrade without --install: ${install}`);
            if (release !== expected.release) found.push(`upgrade of a release that is not the configured one: ${release}`);
            if (chart === undefined || chart.startsWith("-")) found.push(`upgrade of a chart that could be a flag: ${chart}`);
            if (argv[argv.length - 1] !== "--wait=false") found.push("upgrade that waits");
            const after = argv.slice(argv.indexOf("--namespace") + 2, -1);
            // What follows the namespace: at most one values file, then --set pairs, the last of which is the version.
            const words = [...after];
            if (words[0] === "--values") words.splice(0, 2);
            if (words.length % 2 !== 0 || words.length === 0) found.push(`upgrade with odd words after the namespace: ${JSON.stringify(after)}`);
            for (let at = 0; at < words.length; at += 2) {
                if (words[at] !== "--set" || !/^[A-Za-z_][A-Za-z0-9_.[\]\\-]*=[A-Za-z0-9._:/@+%~=-]*$/.test(words[at + 1] ?? "")) {
                    found.push(`upgrade with ${words[at]} ${words[at + 1]}`);
                }
            }
            if (!/^image\.tag=[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(words[words.length - 1] ?? "")) found.push(`upgrade whose last --set is not the version: ${words[words.length - 1]}`);
            if (words.slice(0, -1).some((word) => word.startsWith("image.tag="))) found.push("upgrade that sets the image tag twice");
            break;
        }
        case "rollback": {
            const [release, ...more] = rest;
            if (release !== expected.release) found.push(`rollback of a release that is not the configured one: ${release}`);
            if (JSON.stringify(more) !== JSON.stringify(where)) found.push(`rollback with ${JSON.stringify(more)}`);
            break;
        }
        case "history": {
            const [release, ...more] = rest;
            if (release !== expected.release) found.push(`history of a release that is not the configured one: ${release}`);
            if (JSON.stringify(more) !== JSON.stringify([...where, "--max", "2", "-o", "json"])) found.push(`history with ${JSON.stringify(more)}`);
            break;
        }
        case "get": {
            const [values, release, revision, number, all, ...more] = rest;
            if (values !== "values") found.push(`get ${values}: only get values can be built`);
            if (release !== expected.release) found.push(`get values of a release that is not the configured one: ${release}`);
            if (revision !== "--revision" || !/^[1-9]\d*$/.test(number ?? "")) found.push(`get values without a revision: ${revision} ${number}`);
            if (JSON.stringify([all, ...more]) !== JSON.stringify(["--all", "-o", "json", ...where])) found.push(`get values with ${JSON.stringify([all, ...more])}`);
            break;
        }
        default:
            found.push(`the command is ${command}, not upgrade --install, rollback, history or get values`);
    }
    return found;
}
