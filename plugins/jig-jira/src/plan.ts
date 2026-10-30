// A plan is everything one write needs, worked out once: what the person is shown, the request to send, and how to find
// out afterwards whether it happened. The preview and the execution both build the plan, from the same code, and the
// fingerprint of the plan is what ties them together: if the plan at execution differs from the one that was approved,
// the write is refused (see writes.ts).
import { createHash } from "node:crypto";
import type { IssueHead } from "./api.ts";
import type { Call } from "./params.ts";
import type { Shown } from "./shown.ts";
import { oneLine } from "./values.ts";
import type { Obj } from "./values.ts";

export interface Send {
    method: "POST" | "PUT" | "DELETE";
    /** Below `/rest/api/2`. */
    path: string;
    body?: unknown;
}

/** What one re-read of the issue says about a write whose reply was lost. */
export interface Finding {
    /** True or false when the re-read settles it; undefined when it does not. */
    happened: boolean | undefined;
    text: string;
    /** The key of the issue, when the re-read found it (a new issue has none until it exists). */
    key?: string;
}

export interface Plan {
    shown: Shown;
    send: Send;
    /** What the person relied on besides the request, such as the text that is being replaced. It joins the fingerprint. */
    basis: unknown;
    /** The issue the write is about. A new issue has none until Jira answers. */
    key: string | undefined;
    /** One read that tells whether the write happened. Called only after a reply was lost. */
    check(): Promise<Finding>;
    /** The tool's answer for a write that went through, and the key to record. */
    done(reply: unknown): { text: string; key: string };
}

export type CallOf<A extends Call["action"]> = Extract<Call, { action: A }>;

/** `PROJ-12 "Fix login crash"`: names the issue so a wrong key is seen at once. */
export const about = (head: IssueHead): string => `${head.key} "${oneLine(head.summary, 60)}"`;

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Obj)[key])}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** A digest of what would be sent and of what the person relied on. */
export function fingerprintOf(plan: Plan): string {
    return createHash("sha256").update(canonical({ send: plan.send, basis: plan.basis })).digest("hex").slice(0, 32);
}
