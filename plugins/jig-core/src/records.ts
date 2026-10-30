// Records: one JSON line for every tool call and every model turn, in `<state>/records/<YYYY-MM-DD>.jsonl` (the day
// is UTC). Only this module writes them; `jig-lens` reads them.
//
// A record never holds tool arguments or tool output. An error is kept as its kind plus one masked and redacted line.
// That is enforced by shape: a call record is built from the fields below and nothing else, so there is no place
// where arguments or output could be added by accident.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
    ApprovalKind,
    Decision,
    DecisionEvent,
    Effect,
    EnvironmentKind,
    EnvironmentName,
    Facts,
} from "./contract.ts";
import { appendPrivateLine, privateDir, stateDir } from "./paths.ts";

export type Outcome = "ok" | "error" | "blocked";

/** Why a call did not run or did not succeed, in words a dashboard can group by. */
export type ErrorKind =
    | "denied" // a rule, the table or the tool's declaration said deny
    | "no-screen" // the call needed approval and there was no screen
    | "declined" // the user said no
    | "invalid" // the tool's preview said the input is invalid, so nobody was asked
    | "dismissed" // the question was closed without an answer
    | "internal" // jig-core could not decide, so it blocked the call
    | "tool" // the tool ran and failed
    | "withheld" // the tool ran, but its result could not be masked or redacted, so the model never saw it
    | "not-run"; // the call never reached the tool (unknown tool, invalid arguments, aborted)

export type Answer = NonNullable<DecisionEvent["answer"]>;

/** Fields every line has. */
interface Line {
    id: string;
    kind: "call" | "turn";
    time: string;
    session: string;
    parentSession?: string;
    agentRole: string;
    ticket?: string;
}

export interface CallRecord extends Line {
    kind: "call";
    tool: string;
    action?: string;
    plugin?: string;
    /** The next five are missing for a call that never reached the tool manager (an unknown tool, arguments that
     *  failed validation): it was never classified. */
    environment?: EnvironmentName;
    environmentKind?: EnvironmentKind;
    effect?: Effect;
    decision?: Decision;
    decisionSource?: DecisionEvent["source"];
    approval?: ApprovalKind;
    answer?: Answer;
    waitedMs?: number;
    outcome: Outcome;
    errorKind?: ErrorKind;
    /** One masked and redacted line, at most 200 characters. */
    error?: string;
    durationMs?: number;
    toolCallId: string;
    parentToolCallId?: string;
    spill?: string;
    facts?: Facts;
}

export interface TurnRecord extends Line {
    kind: "turn";
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** The total cost of the turn, in dollars, as Pi's usage data reports it. */
    cost: number;
}

export type RecordLine = CallRecord | TurnRecord;

/** Who the line belongs to. */
export interface Who {
    session: string;
    ticket?: string;
}

export type CallInput = Who & Omit<CallRecord, keyof Line | "kind">;
export type TurnInput = Who & Omit<TurnRecord, keyof Line | "kind">;

/** The fields every line has. The parent session and the role come from the environment: a child agent is started
 *  with `JIG_PARENT_SESSION` and `JIG_AGENT_ROLE` set. */
function header(kind: "call" | "turn", who: Who, now: Date, env: NodeJS.ProcessEnv): Line {
    const parent = env.JIG_PARENT_SESSION;
    return {
        id: randomUUID(),
        kind,
        time: now.toISOString(),
        session: who.session,
        ...(parent === undefined || parent === "" ? {} : { parentSession: parent }),
        agentRole: env.JIG_AGENT_ROLE !== undefined && env.JIG_AGENT_ROLE !== "" ? env.JIG_AGENT_ROLE : "main",
        ...(who.ticket === undefined ? {} : { ticket: who.ticket }),
    };
}

export function callRecord(input: CallInput, now: Date, env: NodeJS.ProcessEnv = process.env): CallRecord {
    return {
        ...header("call", input, now, env),
        kind: "call",
        tool: input.tool,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.plugin === undefined ? {} : { plugin: input.plugin }),
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...(input.environmentKind === undefined ? {} : { environmentKind: input.environmentKind }),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        ...(input.decision === undefined ? {} : { decision: input.decision }),
        ...(input.decisionSource === undefined ? {} : { decisionSource: input.decisionSource }),
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        ...(input.answer === undefined ? {} : { answer: input.answer }),
        ...(input.waitedMs === undefined ? {} : { waitedMs: Math.round(input.waitedMs) }),
        outcome: input.outcome,
        ...(input.errorKind === undefined ? {} : { errorKind: input.errorKind }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.durationMs === undefined ? {} : { durationMs: Math.round(input.durationMs) }),
        toolCallId: input.toolCallId,
        ...(input.parentToolCallId === undefined ? {} : { parentToolCallId: input.parentToolCallId }),
        ...(input.spill === undefined ? {} : { spill: input.spill }),
        ...(input.facts === undefined || Object.keys(input.facts).length === 0 ? {} : { facts: input.facts }),
    };
}

export function turnRecord(input: TurnInput, now: Date, env: NodeJS.ProcessEnv = process.env): TurnRecord {
    return {
        ...header("turn", input, now, env),
        kind: "turn",
        model: input.model,
        input: input.input,
        output: input.output,
        cacheRead: input.cacheRead,
        cacheWrite: input.cacheWrite,
        cost: input.cost,
    };
}

// ---- cleaning what goes into a line ----------------------------------------------------------------------------------------

const MAX_ERROR_CHARS = 200;
const MAX_FACT_STRING = 64;
const MAX_FACTS = 50;

/** The first non-empty line of a text, with runs of white space collapsed, at most 200 characters. The caller has
 *  masked and redacted the text first. */
export function oneLine(text: string, max: number = MAX_ERROR_CHARS): string {
    const first =
        text
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+/g, " ").trim())
            .find((line) => line !== "") ?? "";
    return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}

/** Facts are a few named numbers, flags or short codes. Anything else is dropped: strings over 64 characters, values
 *  that are not plain, and everything past 50 entries. String facts are redacted, in case a code is a secret. */
export function cleanFacts(
    raw: Readonly<Record<string, unknown>>,
    redact: (text: string) => string,
): Facts | undefined {
    const kept: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (Object.keys(kept).length >= MAX_FACTS) break;
        if (key === "" || key.length > MAX_FACT_STRING) continue;
        if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
        else if (typeof value === "boolean") kept[key] = value;
        else if (typeof value === "string" && value.length <= MAX_FACT_STRING) kept[key] = redact(value);
    }
    return Object.keys(kept).length === 0 ? undefined : kept;
}

// ---- the files --------------------------------------------------------------------------------------------------------

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export function recordsDir(): string {
    return join(stateDir(), "records");
}

/** Today's file, by UTC date. */
export function recordsFile(now: Date): string {
    return join(recordsDir(), `${now.toISOString().slice(0, 10)}.jsonl`);
}

/** Appends one line. Throws when the file cannot be written; the caller decides what that means (it must never
 *  break a tool call). */
export function writeRecord(record: RecordLine, now: Date): void {
    privateDir("records");
    appendPrivateLine(recordsFile(now), `${JSON.stringify(record)}\n`);
}

/** Deletes record files whose day is more than `retentionDays` before today. Returns how many. */
export function cleanupRecords(retentionDays: number, now: Date): number {
    let names: string[];
    try {
        names = readdirSync(recordsDir());
    } catch {
        return 0;
    }
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let deleted = 0;
    for (const name of names) {
        const match = DAY_FILE.exec(name);
        if (match === null) continue;
        const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if ((today - day) / 86_400_000 <= retentionDays) continue;
        try {
            unlinkSync(join(recordsDir(), name));
            deleted++;
        } catch {
            // Gone already.
        }
    }
    return deleted;
}

// ---- the summary `/jig records` shows -------------------------------------------------------------------------------

export interface Summary {
    file: string;
    exists: boolean;
    calls: number;
    errors: number;
    blocked: number;
    turns: number;
    questions: number;
    waitedMs: number;
}

/** Counts what today's file holds. Lines that are not complete JSON are skipped. */
export function summarize(now: Date): Summary {
    const file = recordsFile(now);
    const summary: Summary = {
        file,
        exists: false,
        calls: 0,
        errors: 0,
        blocked: 0,
        turns: 0,
        questions: 0,
        waitedMs: 0,
    };
    let text: string;
    try {
        if (statSync(file).size > 200 * 1024 * 1024) return { ...summary, exists: true };
        text = readFileSync(file, "utf8");
    } catch {
        return summary;
    }
    summary.exists = true;
    for (const line of text.split("\n")) {
        if (line === "") continue;
        let record: { kind?: string; outcome?: string; answer?: string; waitedMs?: unknown };
        try {
            record = JSON.parse(line) as typeof record;
        } catch {
            continue;
        }
        if (record.kind === "turn") summary.turns++;
        if (record.kind !== "call") continue;
        summary.calls++;
        if (record.outcome === "error") summary.errors++;
        if (record.outcome === "blocked") summary.blocked++;
        if (record.answer !== undefined) summary.questions++;
        if (typeof record.waitedMs === "number") summary.waitedMs += record.waitedMs;
    }
    return summary;
}

/** `850 ms`, `4.2 s`, `3 min 5 s`. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(ms / 60_000);
    return `${minutes} min ${Math.round((ms - minutes * 60_000) / 1000)} s`;
}
