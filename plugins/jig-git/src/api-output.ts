// The answer of `gh api -i` and `glab api -i`: a status line, the headers, a blank line, then the body. Both programs print it
// the same way, and both exit with 1 and say `HTTP 304` on standard error for a status from 300 up, so one reader serves both.
import type { RunResult } from "../../jig-core/src/contract.ts";

export interface ApiResponse {
    /** The HTTP status, or 0 when no response came (the network failed, or the program could not start the request). */
    status: number;
    /** Header names in lower case. */
    headers: Record<string, string>;
    body: string;
}

/**
 * Reads the output of `gh api -i` or `glab api -i`. A `304` has no body, and the program then exits with 1 and says
 * `HTTP 304`; any other status from 300 up is the same. So the status is taken from the status line, not from the exit code.
 */
export function parseApiOutput(result: RunResult): ApiResponse {
    const head = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(result.stdout);
    if (!head) {
        const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
        return { status: status ? Number(status) : result.code === 0 ? 200 : 0, headers: {}, body: result.stdout };
    }
    const rest = result.stdout.slice(head[0].length);
    const split = rest.search(/\r?\n\r?\n/);
    const headerText = split < 0 ? rest : rest.slice(0, split);
    const body = split < 0 ? "" : rest.slice(split).replace(/^\r?\n\r?\n/, "");
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status: Number(head[1]), headers, body };
}
