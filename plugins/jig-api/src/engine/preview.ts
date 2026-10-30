// What the person reads before a request that asks: the request and its environment, the method, the full address, the
// headers and the body. The sign-in is named but never shown, and secrets are shown by the name of their variable, never
// their value: a plan holds none.
import type { Preview } from "../../../jig-core/src/contract.ts";
import { prettyJson } from "./json.ts";
import { describeSignIn, fingerprintOfAll, secretsOf } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { byteLengthOf, displayOf, generatedIn, isUpload } from "./text.ts";
import type { Text } from "./text.ts";
import { SHOWN_LINES } from "./values.ts";
import { whereOf } from "./render.ts";

/** The summary is one line, and the whole address is in the body. */
const MAX_SUMMARY_CHARS = 300;

/** The body as indented JSON when it is JSON, cut to SHOWN_LINES. The fingerprint covers all of it, so what is sent is what
 *  was approved. */
function bodyLines(body: Text): string[] {
    const text = displayOf(body);
    const lines = (prettyJson(text) ?? text).split("\n");
    if (lines.length <= SHOWN_LINES) return lines;
    return [...lines.slice(0, SHOWN_LINES), `[${lines.length - SHOWN_LINES} more lines not shown; the whole body is sent]`];
}

function truncated(summary: string): string {
    return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

/** The lines that describe one plan. */
export function planLines(plan: Plan): string[] {
    const signIn = plan.signIn.kind === "none" ? "none" : `${describeSignIn(plan.signIn)}, added by the tool`;
    const lines = [
        `Request: ${whereOf(plan)}`,
        `Sign-in: ${signIn}`,
        `Method: ${plan.method}`,
        `URL: ${plan.url}`,
    ];
    if (plan.headers.length > 0) lines.push("Headers:", ...plan.headers.map(([name, value]) => `  ${name}: ${displayOf(value)}`));
    if (plan.body !== undefined) {
        const kind = plan.body.some(isUpload) ? "with a file" : prettyJson(displayOf(plan.body)) === undefined ? "text" : "JSON";
        lines.push(`Body (${kind}, ${byteLengthOf(plan.body)} bytes):`, ...bodyLines(plan.body));
    }
    const secrets = secretsOf(plan).map((secret) => secret.name);
    if (secrets.length > 0) lines.push(`Secrets, read when it is sent and never shown: ${secrets.join(", ")}`);
    const generated = [...plan.headers.map(([, value]) => value), ...(plan.body === undefined ? [] : [plan.body])].flatMap(generatedIn);
    if (generated.length > 0) lines.push(`Made when it is sent: ${[...new Set(generated)].join(", ")}`);
    return lines;
}

export function previewOf(plan: Plan): Preview {
    return {
        summary: truncated(`${plan.method} ${plan.url}`),
        body: planLines(plan).join("\n"),
        format: "text",
        fingerprint: plan.fingerprint,
    };
}

/** One preview for several requests that are approved together, such as a folder: each request in order. */
export function previewOfAll(title: string, plans: readonly Plan[]): Preview {
    const blocks = plans.map((plan, index) => [`${index + 1}. ${plan.request}`, ...planLines(plan).map((line) => `   ${line}`)].join("\n"));
    return {
        summary: truncated(`${title}: ${plans.length} request${plans.length === 1 ? "" : "s"}, in order`),
        body: [title, "", ...blocks.flatMap((block) => [block, ""])].join("\n").trimEnd(),
        format: "text",
        fingerprint: fingerprintOfAll(plans),
    };
}
