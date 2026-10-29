// What the user sees when a call asks: a one-line summary and, for a long preview, a body.
//
// A Jig tool builds its own preview (`ToolDeclaration.preview`). Every other tool gets a plain summary made from the
// call itself, so the user always sees what they are approving.
import type { Effect, EnvironmentName, Preview, ToolDeclaration } from "./contract.ts";
import { errorMessage } from "./errors.ts";

/** How long a tool may take to build its preview. */
export const PREVIEW_TIMEOUT_MS = 15_000;
const MAX_ARGS_CHARS = 200;

/** `git · push · external · write`: the line every question starts with. */
export function describeCall(call: { tool: string; action?: string; environment: EnvironmentName; effect: Effect }): string {
    return [call.tool, ...(call.action === undefined ? [] : [call.action]), call.environment, call.effect].join(" · ");
}

/** The arguments of a call on one line, cut short. They are shown to the user only; records never hold them. */
function compactArguments(input: Readonly<Record<string, unknown>>): string {
    let text: string;
    try {
        text = JSON.stringify(input) ?? "";
    } catch {
        text = "(arguments cannot be shown)";
    }
    text = text.replace(/\s+/g, " ");
    return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS - 1)}…` : text;
}

/** The summary for a tool that gave no preview of its own. */
export function defaultSummary(
    call: { tool: string; action?: string; environment: EnvironmentName; effect: Effect; unknown: boolean },
    input: Readonly<Record<string, unknown>>,
): string {
    const what = call.action === undefined ? call.tool : `${call.tool} ${call.action}`;
    const note = call.unknown ? " (not classified, so treated as a write outside this machine)" : "";
    return `${what}${note}: ${compactArguments(input)}`;
}

function isPreview(value: unknown): value is Preview {
    if (typeof value !== "object" || value === null) return false;
    const preview = value as Record<string, unknown>;
    return typeof preview.summary === "string" && preview.summary !== ""
        && (preview.body === undefined || typeof preview.body === "string");
}

/**
 * Builds the preview with the tool's own function, which may take a while (it can read a diff or fetch text). If it
 * fails or takes more than 15 seconds, the user sees "preview unavailable: <reason>" and can still decide.
 */
export async function buildPreview(
    declaration: ToolDeclaration | undefined,
    input: Readonly<Record<string, unknown>>,
    fallbackSummary: string,
    timeoutMs: number = PREVIEW_TIMEOUT_MS,
): Promise<Preview> {
    if (declaration?.preview === undefined) return { summary: fallbackSummary };
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`it took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`));
        }, timeoutMs);
    });
    try {
        const preview: unknown = await Promise.race([declaration.preview(input, controller.signal), tooSlow]);
        if (!isPreview(preview)) throw new Error("the tool returned no summary");
        return preview;
    } catch (error) {
        const reason = errorMessage(error).replace(/\s+/g, " ").slice(0, 200);
        return { summary: `preview unavailable: ${reason}` };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
