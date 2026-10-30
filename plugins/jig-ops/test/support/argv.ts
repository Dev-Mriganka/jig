// What a kubectl command line of this plugin can look like. There are only a few shapes, and `problems` says why an
// argument list is none of them. A test that records the arguments of every call can then show that no call is outside the
// few: not a verb that writes, not a flag that points kubectl somewhere else, not an argument the model made up.

export interface Expected {
    /** The context and namespace the configuration gives the service. */
    context: string;
    namespace: string;
}

const POD = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const LABEL_SELECTOR = /^--selector=[A-Za-z0-9._/=,-]+$/;
/** The command curl runs in the pod, as it is written to kubectl. */
const CURL = ["curl", "-sS", "-m", "20", "-X", "GET", "-w", "\\n__status:%{http_code}"];

/** Why `argv` is not a command this plugin builds. An empty list means it is one. */
export function problems(argv: readonly string[], expected: Expected): string[] {
    const found: string[] = [];
    const [timeout, context, namespace, verb, ...rest] = argv;
    if (timeout === undefined || !/^--request-timeout=\d+s$/.test(timeout)) found.push(`no time limit first: ${timeout}`);
    if (context !== `--context=${expected.context}`) found.push(`the context is not the configured one: ${context}`);
    if (namespace !== `--namespace=${expected.namespace}`) found.push(`the namespace is not the configured one: ${namespace}`);

    switch (verb) {
        case "get": {
            const [resource, ...more] = rest;
            const asJson = ["-o", "json"];
            if (resource === "pods") {
                const [selector, ...tail] = more;
                if (selector === undefined || !LABEL_SELECTOR.test(selector)) found.push(`get pods without the target's selector: ${selector}`);
                if (JSON.stringify(tail) !== JSON.stringify(asJson)) found.push(`get pods ends with ${JSON.stringify(tail)}`);
            } else if (resource === "deployments,statefulsets") {
                if (JSON.stringify(more) !== JSON.stringify(asJson)) found.push(`get workloads ends with ${JSON.stringify(more)}`);
            } else {
                found.push(`get reads something other than pods and workloads: ${resource}`);
            }
            break;
        }
        case "logs": {
            const [pod, ...more] = rest;
            if (pod === undefined || !POD.test(pod)) found.push(`logs of something that is not a pod name: ${pod}`);
            const flags = more[0] === "-c" ? more.slice(2) : more;
            if (more[0] === "-c" && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(more[1] ?? "")) found.push(`logs -c ${more[1]}`);
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
            if (c !== "-c" || container === undefined || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(container)) found.push("exec without a container");
            if (dashes !== "--") found.push("exec without the -- that ends kubectl's own flags");
            const url = command[command.length - 1];
            if (JSON.stringify(command.slice(0, -1)) !== JSON.stringify(CURL)) found.push(`exec runs ${JSON.stringify(command.slice(0, -1))}`);
            if (url === undefined || !/^http:\/\/localhost:\d+\//.test(url)) found.push(`exec calls ${url}`);
            break;
        }
        default:
            found.push(`the verb is ${verb}, not get, logs or exec`);
    }
    return found;
}
