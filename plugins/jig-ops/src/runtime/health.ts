// `health` by address: one GET on the https address the catalog gives, to see whether the service answers.
//
// The address is the catalog's: the model gives no path, header or body. A redirect is never followed, so a request cannot
// be sent on to another host. The wait is ten seconds, and the answer is its status and the first part of its body, with
// terminal sequences and control characters taken out. A status that is not 2xx is a result, not an error: that is what
// the check is for. A request that gets no answer is an error that says why, in words of this plugin and never Node's,
// which can quote the address.
import { healthProblem } from "../catalog.ts";
import { clean, isObject } from "../values.ts";
import type { Outcome } from "../values.ts";

/** How long the service has to answer. */
export const HEALTH_TIMEOUT_MS = 10_000;
/** How much of the body is read and shown. The rest is not read at all. */
export const BODY_BYTES = 4096;
const SNIFF_BYTES = 512;

/** The parts of the check a test replaces. */
export interface HealthDeps {
    fetch: typeof fetch;
    timeoutMs: number;
}

/** The address as a message may show it: a query string can hold a token, so it is left out. */
export function shownAddress(address: string): string {
    const url = new URL(address);
    return `${url.origin}${url.pathname}${url.search === "" ? "" : "?…"}`;
}

/** Rejects when `signal` aborts, whatever `work` is doing: the time limit must hold even if `fetch` ignores its signal. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

/** The error code of a failure, which may sit in its cause (`fetch failed` is only the outer words). */
function codeOf(error: unknown): string {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && isObject(current); depth++) {
        if (typeof current.code === "string") return current.code;
        if (Array.isArray(current.errors)) {
            const inner: unknown = current.errors.find((item) => isObject(item) && typeof item.code === "string");
            if (isObject(inner) && typeof inner.code === "string") return inner.code;
        }
        current = current.cause;
    }
    return "";
}

const CERTIFICATE = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_REVOKED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Why a request got no answer, as one clause. */
function noAnswer(error: unknown, stop: AbortSignal, userStopped: boolean, timeoutMs: number): string {
    if (userStopped) return "the check was cancelled";
    if (stop.aborted) return `no answer within ${timeoutMs / 1000} s`;
    const code = codeOf(error);
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `the name does not resolve (${code})`;
    if (code === "ECONNREFUSED") return "the connection was refused (ECONNREFUSED)";
    if (CERTIFICATE.has(code)) return `the TLS certificate was not accepted (${code}); certificate checks are never turned off`;
    return code === "" ? "the connection failed" : `the connection failed (${code})`;
}

/** The first BODY_BYTES of the body, and whether there was more. */
async function readStart(response: Response): Promise<{ bytes: Uint8Array; more: boolean }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return { bytes: new Uint8Array(0), more: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks), more: false };
        if (value.byteLength > BODY_BYTES - size) {
            chunks.push(value.subarray(0, BODY_BYTES - size));
            await reader.cancel().catch(() => undefined);
            return { bytes: Buffer.concat(chunks), more: true };
        }
        chunks.push(value);
        size += value.byteLength;
    }
}

export async function urlHealth(address: string, cancel: AbortSignal | undefined, deps: HealthDeps): Promise<Outcome> {
    const problem = healthProblem(address);
    if (problem !== undefined) throw new Error(`The health address is refused (it ${problem}). Nothing was sent`);
    const where = `GET ${shownAddress(address)}`;

    const stop = AbortSignal.any([AbortSignal.timeout(deps.timeoutMs), ...(cancel === undefined ? [] : [cancel])]);
    let response: Response;
    let body: { bytes: Uint8Array; more: boolean };
    try {
        response = await untilAborted(
            deps.fetch(address, { method: "GET", redirect: "manual", signal: stop, headers: { accept: "*/*", "user-agent": "jig-ops" } }),
            stop,
        );
        body = await untilAborted(readStart(response), stop);
    } catch (error) {
        throw new Error(`${where}: ${noAnswer(error, stop, cancel?.aborted === true, deps.timeoutMs)}`);
    }

    const status = response.status;
    const location = response.headers.get("location");
    const redirect = location === null ? "" : ` (a redirect, not followed; it points to ${clean(location).slice(0, 200)})`;
    const binary = body.bytes.subarray(0, SNIFF_BYTES).includes(0);
    const shown = binary ? "" : clean(new TextDecoder().decode(body.bytes));
    const lines = [`${where} -> HTTP ${status}${redirect}`];
    if (binary) lines.push(`(not text: ${body.bytes.byteLength} bytes read)`);
    else lines.push(shown === "" ? "(empty body)" : shown);
    if (body.more) lines.push(`[the body goes on; only the first ${BODY_BYTES} bytes are shown]`);
    return {
        text: lines.join("\n"),
        facts: { status, cut: body.more },
        details: { status, bytes: body.bytes.byteLength, cut: body.more, redirect: location !== null },
    };
}
