// Test support: sample record files in jig-core's own format, a temporary state folder, and a fake Pi. The records are
// built with jig-core's callRecord and turnRecord, so a change to the format that jig-lens does not follow fails here
// and not on somebody's machine. Only the Pi calls the plugin makes are faked; none of Pi's SDK is loaded.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishJig, withdrawJig } from "../../jig-core/src/client.ts";
import type { JigApi } from "../../jig-core/src/contract.ts";
import { callRecord, turnRecord } from "../../jig-core/src/records.ts";
import type { CallInput, CallRecord, RecordLine, TurnInput, TurnRecord } from "../../jig-core/src/records.ts";
import { importRecords } from "../src/import.ts";
import { lensPaths } from "../src/paths.ts";
import type { Paths } from "../src/paths.ts";
import { openIndex } from "../src/store.ts";

/** The moment the sample records are measured from. */
export const NOW = new Date("2026-10-30T12:00:00.000Z");

/** A temporary state folder, removed when the test ends. */
export function tempState(t: TestContext): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jig-lens-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

export function paths(state: string): Paths {
    return lensPaths(state);
}

// ---- records --------------------------------------------------------------------------------------------------------

/** A call with the fields most calls have: a local read that was allowed and went well. */
export function call(
    id: string,
    at: string,
    session: string,
    tool: string,
    extra: Partial<CallInput> = {},
    env: NodeJS.ProcessEnv = {},
): CallRecord {
    const input: CallInput = {
        session,
        tool,
        environment: "local",
        environmentKind: "local",
        effect: "read",
        decision: "allow",
        decisionSource: "table",
        outcome: "ok",
        toolCallId: `tc-${id}`,
        ...extra,
    };
    return { ...callRecord(input, new Date(at), env), id };
}

export function turn(
    id: string,
    at: string,
    session: string,
    model: string,
    cost: number,
    extra: Partial<TurnInput> = {},
    env: NodeJS.ProcessEnv = {},
): TurnRecord {
    const input: TurnInput = { session, model, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost, ...extra };
    return { ...turnRecord(input, new Date(at), env), id };
}

/** Appends lines to the record file of a UTC day, the way jig-core does: one line each, ending in a line break. */
export function appendLines(state: string, day: string, lines: readonly string[]): string {
    const folder = path.join(state, "records");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${day}.jsonl`);
    appendFileSync(file, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
    return file;
}

/** Writes records into the files of their days. */
export function writeRecords(state: string, records: readonly RecordLine[]): void {
    for (const record of records) appendLines(state, record.time.slice(0, 10), [JSON.stringify(record)]);
}

/**
 * Four days of work by three sessions: a main session on a ticket, a second main session without one, and a reviewer
 * child of the first. It has every kind of call a dashboard tells apart: allowed, asked and allowed, asked and
 * declined,
 * dismissed, refused by a rule, a tool that failed, a call that never ran, and calls that carry facts.
 */
export function sampleRecords(): RecordLine[] {
    const child = { JIG_AGENT_ROLE: "reviewer", JIG_PARENT_SESSION: "s1" };
    return [
        turn("t1", "2026-10-27T09:00:00Z", "s1", "model-a", 0.1, { ticket: "T-1", cacheRead: 4000, cacheWrite: 500 }),
        turn("t2", "2026-10-27T09:05:00Z", "s1", "model-a", 0.05, { ticket: "T-1", cacheRead: 6000 }),
        call("c01", "2026-10-27T09:01:00Z", "s1", "read", { ticket: "T-1", durationMs: 4 }),
        call("c02", "2026-10-27T09:02:00Z", "s1", "bash", { ticket: "T-1", durationMs: 1200 }),
        call("c03", "2026-10-27T09:03:00Z", "s1", "git", {
            ticket: "T-1",
            action: "status",
            plugin: "jig-git",
            durationMs: 90,
        }),
        call("c04", "2026-10-27T09:04:00Z", "s1", "bash", {
            ticket: "T-1",
            outcome: "error",
            errorKind: "tool",
            error: "exit code 1",
            durationMs: 300,
        }),

        turn("t3", "2026-10-28T10:00:00Z", "s1", "model-a", 0.2, { ticket: "T-1", cacheRead: 9000 }),
        call("c05", "2026-10-28T10:01:00Z", "s1", "git", {
            ticket: "T-1",
            action: "push",
            plugin: "jig-git",
            environment: "external",
            environmentKind: "external",
            effect: "write",
            decision: "ask",
            approval: "review",
            answer: "allow",
            waitedMs: 3000,
            durationMs: 2100,
        }),
        call("c06", "2026-10-28T10:02:00Z", "s1", "edit", { ticket: "T-1", effect: "write", durationMs: 12 }),
        call("c07", "2026-10-28T10:03:00Z", "s1", "http", {
            ticket: "T-1",
            environment: "production",
            environmentKind: "production",
            effect: "write",
            decision: "deny",
            decisionSource: "floor",
            outcome: "blocked",
            errorKind: "denied",
            error: "production writes are denied",
        }),
        turn("t4", "2026-10-28T11:00:00Z", "s2", "model-b", 0.01),
        call("c08", "2026-10-28T11:01:00Z", "s2", "bash", {
            effect: "write",
            decision: "ask",
            decisionSource: "unknown",
            approval: "dialog",
            answer: "decline",
            waitedMs: 1500,
            outcome: "blocked",
            errorKind: "declined",
            error: "declined by the user",
        }),

        turn("t5", "2026-10-29T08:00:00Z", "s3", "model-b", 0.03, {}, child),
        call("c09", "2026-10-29T08:01:00Z", "s3", "read", { durationMs: 6 }, child),
        call(
            "c10",
            "2026-10-29T08:02:00Z",
            "s3",
            "checks",
            {
                action: "watch",
                plugin: "jig-git",
                environment: "external",
                environmentKind: "external",
                durationMs: 60_000,
                facts: { conclusion: "success", passed: 12, failed: 0 },
            },
            child,
        ),
        call("c11", "2026-10-29T14:00:00Z", "s2", "mystery", {
            environment: undefined,
            environmentKind: undefined,
            effect: undefined,
            decision: undefined,
            decisionSource: undefined,
            outcome: "error",
            errorKind: "not-run",
        }),

        turn("t6", "2026-10-30T09:00:00Z", "s2", "model-a", 0.07, { cacheRead: 12_000 }),
        call("c12", "2026-10-30T09:01:00Z", "s2", "flow", {
            action: "test",
            plugin: "jig-flow",
            effect: "write",
            outcome: "error",
            errorKind: "tool",
            error: "2 tests failed",
            durationMs: 45_000,
            facts: { passed: 10, failed: 2, ok: false },
        }),
        call("c13", "2026-10-30T09:02:00Z", "s2", "bash", {
            effect: "write",
            decision: "ask",
            decisionSource: "unknown",
            approval: "dialog",
            answer: "decline",
            waitedMs: 9000,
            outcome: "blocked",
            errorKind: "dismissed",
            error: "the question was closed without an answer",
        }),
        call("c14", "2026-10-30T09:03:00Z", "s1", "git", {
            ticket: "T-1",
            action: "push",
            plugin: "jig-git",
            environment: "external",
            environmentKind: "external",
            effect: "write",
            decision: "ask",
            approval: "review",
            answer: "allow-session",
            waitedMs: 800,
            durationMs: 1800,
        }),
    ];
}

/** Writes the sample records into the state folder's record files. */
export function writeSample(state: string): void {
    writeRecords(state, sampleRecords());
}

/** The sample, imported into a new index. Returns the paths of the state folder. */
export async function sampleIndex(state: string): Promise<Paths> {
    writeSample(state);
    const where = paths(state);
    const db = openIndex(where.index);
    try {
        await importRecords(db, { records: where.records, now: NOW });
    } finally {
        db.close();
    }
    return where;
}

// ---- a fake Pi ------------------------------------------------------------------------------------------------------

export interface Notice {
    text: string;
    level: string;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** What the plugin registers with Pi, and a screen that remembers what it was told. */
export class FakePi {
    readonly handlers = new Map<string, Handler[]>();
    readonly commands = new Map<
        string,
        { description?: string; handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown }
    >();
    readonly notices: Notice[] = [];
    readonly ctx: ExtensionCommandContext;

    constructor(hasUI = true) {
        this.ctx = {
            hasUI,
            ui: {
                notify: (text: string, level?: string) => {
                    this.notices.push({ text, level: level ?? "info" });
                },
            },
        } as unknown as ExtensionCommandContext;
    }

    get api(): ExtensionAPI {
        return this as unknown as ExtensionAPI;
    }

    on(event: string, handler: Handler): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    registerCommand(
        name: string,
        options: {
            description?: string;
            handler: CommandHandler;
            getArgumentCompletions?: (prefix: string) => unknown;
        },
    ): void {
        this.commands.set(name, options);
    }

    /** Runs the handlers of an event in order, and waits for each. */
    async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
        for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, this.ctx);
    }

    /** Runs `/lens <args>` and returns the notices it showed. */
    async lens(args = ""): Promise<Notice[]> {
        const before = this.notices.length;
        const command = this.commands.get("lens");
        if (command === undefined) throw new Error("no command lens");
        await command.handler(args, this.ctx);
        return this.notices.slice(before);
    }
}

// ---- a fake jig-core ------------------------------------------------------------------------------------------------

/** What the fake jig-core recorded of the plugin's calls. */
export interface FakeJig {
    /** The check each plugin registered for its section, by section name. */
    checks: Map<string, (raw: unknown) => readonly string[]>;
    /** Every section name the plugin asked for, in order. */
    reads: string[];
}

/** Publishes a fake jig-core for the rest of the test, as jig-core does at start-up. `sections` is jig.json's. */
export function useJig(t: TestContext, sections: Record<string, unknown> = {}): FakeJig {
    const fake: FakeJig = { checks: new Map(), reads: [] };
    const api = {
        version: 1,
        config: {
            registerSection: (name: string, check: (raw: unknown) => readonly string[]) => {
                fake.checks.set(name, check);
            },
            section: (name: string) => {
                fake.reads.push(name);
                return sections[name];
            },
        },
    } as unknown as JigApi;
    publishJig(api);
    t.after(() => withdrawJig(api));
    return fake;
}
