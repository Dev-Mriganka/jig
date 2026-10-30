// What the model reads: a status line, the request and its environment, a few headers and the body. A non-2xx answer is a normal result, not an
// error: the status and the body are what the model reasons from. JSON is re-indented with its numbers untouched and is not
// cut here, because jig-core cuts a very long result and keeps the whole text in a file. Other text is cut at 200 lines.
import { STATUS_CODES } from "node:http";
import { prettyJson } from "./json.ts";
import { READ_METHODS } from "./plan.ts";
import type { Plan } from "./plan.ts";
import type { Sent } from "./http.ts";
import { SHOWN_LINES } from "./values.ts";
import { MAX_ANSWER_BYTES } from "./wire.ts";
import type { Answer } from "./wire.ts";

const SHOWN_HEADERS = 6;
/** What a follow-up needs: the id of the request, to find it in the other side's logs. */
const TRACE = /trace|request-?id|correlation-?id/i;

/** A header value on one line, cut: it is text from outside. */
const headerValue = (text: string): string => text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 200);

/** `content-type`, `location` and trace or request ids: what a follow-up needs, and not the rest. */
export function shownHeaders(headers: Readonly<Record<string, string>>): string[] {
    return Object.entries(headers)
        .filter(([name]) => name === "content-type" || name === "location" || TRACE.test(name))
        .slice(0, SHOWN_HEADERS)
        .map(([name, value]) => `${name}: ${headerValue(value)}`);
}

function bodyLines(answer: Answer): string[] {
    if (answer.binary) return [`(binary body, ${answer.bytes} bytes${answer.cut ? ", cut" : ""})`];
    if (answer.text.trim() === "") return ["(empty body)"];
    const pretty = prettyJson(answer.text);
    if (pretty !== undefined) return pretty.split("\n");
    const lines = answer.text.split(/\r?\n/);
    if (lines.length <= SHOWN_LINES) return lines;
    return [...lines.slice(0, SHOWN_LINES), `[${lines.length - SHOWN_LINES} more lines not shown]`];
}

/** Sentences for the cases where the status alone would mislead the model. */
function notesFor(plan: Plan, sent: Sent): string[] {
    const { status, headers } = sent.answer;
    const notes = [...sent.notes];
    if (status >= 300 && status < 400 && headers.location !== undefined) {
        notes.push("Redirects are not followed: the location header says where the server points.");
    }
    if (!READ_METHODS.has(plan.method) && (status >= 500 || status === 408)) {
        notes.push(
            "The server reported an error, but a write may still have been carried out: " +
                "check with a GET before sending it again.",
        );
    }
    return notes;
}

/** `Get order (orders) in Staging (staging)`: which request ran, and where. */
export function whereOf(plan: Plan): string {
    const from = plan.collection === undefined ? "" : ` (${plan.collection})`;
    return `${plan.request}${from} in ${plan.environment} (${plan.jigEnvironment})`;
}

export function statusLine(plan: Plan, answer: Answer): string {
    const statusText = STATUS_CODES[answer.status];
    return `${plan.method} ${plan.url} -> HTTP ${answer.status}${statusText === undefined ? "" : ` ${statusText}`}`;
}

export function renderResult(plan: Plan, sent: Sent): string {
    const { answer } = sent;
    const lines = [
        statusLine(plan, answer),
        `Request: ${whereOf(plan)}`,
        ...notesFor(plan, sent),
        ...shownHeaders(answer.headers),
        "",
        ...bodyLines(answer),
    ];
    if (answer.cut) lines.push(`[the answer was cut at ${MAX_ANSWER_BYTES} bytes]`);
    return lines.join("\n");
}
