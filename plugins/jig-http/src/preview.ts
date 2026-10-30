// What the person reads before a call that asks: the target, the method, the full address, the headers the model gave
// and the body. The sign-in is named but never shown: the tool adds it, and a header or a token is not in the plan.
import type { Preview } from "../../jig-core/src/contract.ts";
import { prettyJson } from "./json.ts";
import { describeAuth } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { SHOWN_LINES } from "./values.ts";

/** The summary is one line, and the whole address is in the body. */
const MAX_SUMMARY_CHARS = 300;

/** The body as indented JSON, cut to SHOWN_LINES. The fingerprint covers all of it, so what is sent is what was approved. */
function bodyLines(body: string): string[] {
    const lines = (prettyJson(body) ?? body).split("\n");
    if (lines.length <= SHOWN_LINES) return lines;
    return [...lines.slice(0, SHOWN_LINES), `[${lines.length - SHOWN_LINES} more lines not shown; the whole body is sent]`];
}

export function previewOf(plan: Plan): Preview {
    const { call } = plan;
    const { target } = call;
    const about = target.description === undefined ? "" : `: ${target.description}`;
    const signIn = target.auth.kind === "none" ? "none" : `${describeAuth(target.auth)}, added by the tool`;
    const lines = [
        `Target: ${target.name} (${target.environment})${about}`,
        `Sign-in: ${signIn}`,
        `Method: ${call.method}`,
        `URL: ${plan.url}`,
    ];
    if (call.headers.length > 0) lines.push("Headers:", ...call.headers.map(([name, value]) => `  ${name}: ${value}`));
    if (call.body !== undefined) lines.push(`Body (JSON, ${Buffer.byteLength(call.body)} bytes):`, ...bodyLines(call.body));

    const summary = `${call.method} ${plan.url}`;
    return {
        summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary,
        body: lines.join("\n"),
        format: "text",
        fingerprint: plan.fingerprint,
    };
}
