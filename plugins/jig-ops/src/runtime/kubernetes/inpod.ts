// The health check inside a pod: a GET on the path the catalog gives, made from one of the service's Ready pods with
// curl, on the port the catalog names. The pod must have curl; the tool adds nothing to the pod.
//
// The request is fixed. The container, the port and the path are the catalog's, checked when the catalog was read, and
// the address is one argument of curl's command line, which no shell reads. The model gives no path, method, header or
// body, so there is nothing to put on curl's standard input and nothing to hide from kubectl's.
//
// This runs a command in a pod, so it never runs in production: the runtime tool refuses it there (see ../tool.ts).
import { clean, shortList } from "../../values.ts";
import type { Outcome } from "../../values.ts";
import { explain, firstLines } from "./failure.ts";
import { cutMark, runKubectl, wasCut } from "./kubectl.ts";
import type { Kube, Limits } from "./kubectl.ts";
import { firstReady, listPods } from "./pods.ts";

/** How long curl waits for the answer, inside the pod. */
const CURL_TIMEOUT_SEC = 20;

/** The reply is capped at 2 MiB. kubectl gets a little longer than curl, so that curl's own timeout is the one that
 *  speaks. */
export const API: Limits = {
    timeoutMs: (CURL_TIMEOUT_SEC + 15) * 1000,
    requestSec: CURL_TIMEOUT_SEC + 10,
    maxBytes: 2 * 1024 * 1024,
};

/** curl prints this after the body (`-w`), so the status can be told from a body that happens to end like a status. */
const STATUS_MARK = "\n__status:";

/** The command that runs in the pod. `\n` is curl's own escape, not a shell's: nothing here goes through a shell. */
export function curlArgs(url: string): string[] {
    return ["curl", "-sS", "-m", String(CURL_TIMEOUT_SEC), "-X", "GET", "-w", `\\n__status:%{http_code}`, url];
}

// What kubectl says when the container has no curl, or curl itself failed (kubectl then ends with curl's exit code).
const NO_CURL = /executable file not found|curl: (?:command )?not found|exec: "curl"/i;
const CURL_FAILED = /curl: \((\d+)\)|command terminated with exit code (\d+)/;

/** What a curl exit code means, as one clause. */
function curlProblem(stderr: string, code: number, pod: string, port: number): string {
    const match = CURL_FAILED.exec(stderr);
    const exit = match === null ? code : Number(match[1] ?? match[2]);
    switch (exit) {
        case 7:
            return (
                `nothing accepted the connection on localhost:${port} inside ${pod}: ` +
                "the service may be starting, or listen on another port"
            );
        case 28:
            return `the request timed out after ${CURL_TIMEOUT_SEC} s inside ${pod}`;
        case 18:
        case 52:
        case 55:
        case 56:
            return `the connection inside ${pod} closed before the answer was complete`;
        default:
            return `curl failed inside ${pod} (exit ${exit}): ${firstLines(stderr, 2) || "no error text"}`;
    }
}

/** The status curl printed after the body, and the body. Undefined when the end of the reply is not there. */
function split(stdout: string): { status: number; body: string } | undefined {
    const at = stdout.lastIndexOf(STATUS_MARK);
    const tail = at < 0 ? "" : stdout.slice(at + STATUS_MARK.length).trim();
    if (!/^[1-5]\d\d$/.test(tail)) return undefined;
    return { status: Number(tail), body: stdout.slice(0, at) };
}

export async function inPodHealth(kube: Kube): Promise<Outcome> {
    const { target } = kube;
    const { container, port, healthPath } = target;
    if (container === undefined || port === undefined || healthPath === undefined) {
        throw new Error(`${target.service} in ${target.environment} has no health check inside a pod in the catalog`);
    }
    const pod = firstReady(await listPods(kube));
    if (pod === undefined) {
        throw new Error(
            `${target.service} has no ready pod in ${target.environment} to call: ` +
                "run pods, and try again when one is ready",
        );
    }
    if (!pod.containers.some((one) => one.name === container)) {
        const have = shortList(
            pod.containers.map((one) => one.name),
            120,
        );
        throw new Error(
            `${pod.name} has no container ${container} (it has ${have}): ` +
                'fix "container" in the ops catalog of jig.json (runtime.kubernetes)',
        );
    }

    const url = `http://localhost:${port}${healthPath}`;
    const result = await runKubectl(kube, "exec", [pod.name, "-c", container, "--", ...curlArgs(url)], API);
    if (result.code !== 0) {
        if (NO_CURL.test(result.stderr)) {
            throw new Error(
                `${pod.name} has no curl in container ${container}: the health check inside a pod needs curl`,
            );
        }
        // curl's own failure comes back through kubectl; anything else is kubectl's (sign-in, network) and reads as
        // such.
        if (CURL_FAILED.test(result.stderr)) throw new Error(curlProblem(result.stderr, result.code, pod.name, port));
        throw explain(result.stderr, result.code, `curl inside ${pod.name}`, target);
    }

    const where = `GET ${healthPath} on ${pod.name}:${port}`;
    // A reply longer than the limit was cut, and a cut reply has lost the end where the status is. A status found
    // inside it could be part of the body, so none is looked for.
    if (wasCut(result.stdout, API.maxBytes)) {
        const body = clean(result.stdout.slice(0, result.stdout.length - cutMark(API.maxBytes).length));
        return {
            text:
                `${where} -> the reply is larger than ${API.maxBytes / (1024 * 1024)} MiB and was cut; ` +
                `its HTTP status was not read\n${body}`,
            facts: { cut: true },
            details: { pod: pod.name, cut: true },
        };
    }
    const reply = split(result.stdout);
    if (reply === undefined) throw new Error(`The reply from ${pod.name} had no HTTP status: report it to the user`);
    const body = clean(reply.body);
    return {
        text: `${where} -> HTTP ${reply.status}\n${body === "" ? "(empty body)" : body}`,
        facts: { status: reply.status },
        details: { pod: pod.name, status: reply.status, bytes: Buffer.byteLength(reply.body) },
    };
}
