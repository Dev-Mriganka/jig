// Test support: sample record files in jig-core's own format, a temporary state folder, and a fake Pi. The records are
// built with jig-core's callRecord and turnRecord, so a change to the format that jig-lens does not follow fails here
// and not on somebody's machine. Only the Pi calls the plugin makes are faked; none of Pi's SDK is loaded.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishJig, withdrawJig } from "../../jig-core/src/client.ts";
import type { JigApi } from "../../jig-core/src/contract.ts";
import { callRecord, turnRecord } from "../../jig-core/src/records.ts";
import type { CallInput, CallRecord, RecordLine, TurnInput, TurnRecord } from "../../jig-core/src/records.ts";
import { importRecords } from "../src/import.ts";
import { lens } from "../src/index.ts";
import type { LensOptions } from "../src/index.ts";
import { lensPaths } from "../src/paths.ts";
import type { Paths } from "../src/paths.ts";
import { openForReading, openIndex } from "../src/store.ts";
import type { Viewer, ViewerCommand, ViewerState } from "../src/viewer.ts";

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
            "ci",
            {
                action: "watch",
                plugin: "jig-ops",
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
            plugin: "jig-workflow",
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

/**
 * One busy morning in one session, with more of everything than a section shows, so that every limit is reached: seven
 * models and six agent roles, seven tools that failed, questions with four answers, eight kinds of blocked call, seven
 * tools with facts, and a tool whose name and facts carry control characters.
 */
export function busyRecords(): RecordLine[] {
    const records: RecordLine[] = [];
    let n = 0;
    const id = (prefix: string) => `${prefix}${n++}`;
    const pad = (n: number) => String(n).padStart(2, "0");
    const at = (minute: number) => `2026-10-30T${pad(9 + Math.floor(minute / 60))}:${pad(minute % 60)}:00Z`;

    const models = [
        "claude-sonnet-5-5",
        "claude-opus-5",
        "anthropic.claude-haiku-4-5-20251001-v1:0-with-a-very-long-suffix",
        "gpt-5.2",
        "gemini-3",
        "local-model",
        "tiny-model",
    ];
    const costs = [3.2, 1.5, 0.4, 0.2, 0.05, 0.004, 0];
    const roles = ["main", "main", "reviewer", "scout", "planner", "tester", "fixer"];
    models.forEach((model, i) => {
        records.push(
            turn(
                id("t"),
                at(i),
                "busy",
                model,
                costs[i] ?? 0,
                { cacheRead: 1000 * (i + 1) },
                { JIG_AGENT_ROLE: roles[i] ?? "main" },
            ),
        );
    });

    // Tool k fails k times, and every third failure never ran. Each tool also has one call that went well.
    for (let k = 1; k <= 7; k++) {
        for (let i = 0; i < k; i++) {
            records.push(
                call(id("f"), at(20 + i), "busy", `tool${k}`, {
                    outcome: "error",
                    errorKind: i % 3 === 2 ? "not-run" : "tool",
                    durationMs: 100 * k + i,
                }),
            );
        }
        records.push(call(id("o"), at(30), "busy", `tool${k}`, { durationMs: 50 * k }));
    }

    // Four questions: three allowed, and one declined, which stops the call.
    for (let k = 1; k <= 4; k++) {
        records.push(
            call(id("q"), at(40 + k), "busy", "git", {
                action: `a${k}`,
                decision: "ask",
                approval: "dialog",
                answer: k === 4 ? "decline" : "allow",
                waitedMs: 1000 * k * k,
                ...(k === 4 ? { outcome: "blocked", errorKind: "declined", decisionSource: "table" } : {}),
            }),
        );
    }

    // Eight groups of blocked calls, five tools each.
    const groups: Array<[string, "denied" | "no-screen" | "invalid"]> = [
        ["floor", "denied"],
        ["floor", "no-screen"],
        ["rule", "denied"],
        ["rule", "no-screen"],
        ["table", "denied"],
        ["table", "invalid"],
        ["tool", "denied"],
        ["tool", "invalid"],
    ];
    for (const [source, kind] of groups) {
        for (const tool of ["a", "b", "c", "d", "e"]) {
            records.push(
                call(id("b"), at(50), "busy", `blk-${tool}`, {
                    outcome: "blocked",
                    errorKind: kind,
                    decisionSource: source as "floor",
                }),
            );
        }
    }

    // Seven tools with facts, one of them with nine, and one whose name and facts hold control characters.
    for (let k = 1; k <= 7; k++) {
        const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`fact${i}`, i]));
        records.push(
            call(id("c"), at(60 + k), "busy", `check${k}`, {
                facts: k === 1 ? nine : { passed: k, long: "x".repeat(40) },
            }),
        );
    }
    records.push(call(id("h"), at(70), "busy", "evil\u001b[2Jtool", { facts: { "k\u001b": "v\u202etxt" } }));
    return records;
}

/**
 * A morning's work in one session on one ticket, as the README shows it: calls that went well and calls that failed, two
 * questions, two calls a rule stopped, and a CI watch that passed.
 */
export function exampleRecords(): RecordLine[] {
    const records: RecordLine[] = [];
    let n = 0;
    const id = (prefix: string) => `${prefix}${n++}`;
    const pad = (value: number) => String(value).padStart(2, "0");
    const at = (minute: number) => `2026-10-30T${pad(8 + Math.floor(minute / 60))}:${pad(minute % 60)}:00Z`;
    const who = { ticket: "PROJ-123" };

    [0.18, 0.22, 0.31, 0.27, 0.12].forEach((cost, i) => {
        const tokens = { input: 2100, output: 900, cacheRead: 41_000 + i * 6000, cacheWrite: i === 0 ? 8000 : 500 };
        records.push(turn(id("t"), at(5 + i * 30), "demo", "claude-sonnet-5-5", cost, { ...who, ...tokens }));
    });
    records.push(
        turn(id("t"), at(100), "demo", "claude-opus-5", 0.31, { ...who, input: 3000, output: 1500, cacheRead: 20_000 }),
    );

    for (let i = 0; i < 12; i++) {
        records.push(call(id("c"), at(10 + i), "demo", "read", { ...who, durationMs: 3 + i * 3 }));
    }
    for (let i = 0; i < 6; i++) {
        records.push(call(id("c"), at(25 + i), "demo", "edit", { ...who, effect: "write", durationMs: 10 + i * 4 }));
    }
    for (let i = 0; i < 8; i++) {
        const failed = i === 2 || i === 5;
        const outcome = failed ? ({ outcome: "error", errorKind: "tool", error: "exit code 1" } as const) : {};
        records.push(call(id("c"), at(40 + i), "demo", "bash", { ...who, durationMs: 1000 + i * 1500, ...outcome }));
    }
    for (let i = 0; i < 3; i++) {
        records.push(call(id("c"), at(55 + i), "demo", "git", { ...who, action: "status", durationMs: 60 + i * 10 }));
    }
    const asked = { ...who, action: "push", decision: "ask", approval: "review" } as const;
    records.push(
        call(id("c"), at(60), "demo", "git", { ...asked, durationMs: 1800, answer: "allow", waitedMs: 41_000 }),
    );
    records.push(
        call(id("c"), at(90), "demo", "git", { ...asked, durationMs: 2400, answer: "allow-session", waitedMs: 12_000 }),
    );
    const facts = { conclusion: "success", passed: 412, failed: 0 };
    records.push(call(id("c"), at(92), "demo", "ci", { ...who, action: "watch", durationMs: 250_000, facts }));
    const stopped = {
        ...who,
        outcome: "blocked",
        errorKind: "denied",
        decisionSource: "rule",
        decision: "deny",
    } as const;
    records.push(call(id("c"), at(80), "demo", "http", stopped), call(id("c"), at(81), "demo", "http", stopped));
    return records;
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

/** An index imported from these records, open for reading, and closed when the test ends. */
export async function indexOf(t: TestContext, records: readonly RecordLine[]): Promise<DatabaseSync> {
    const state = tempState(t);
    writeRecords(state, records);
    const where = paths(state);
    const writer = openIndex(where.index);
    try {
        await importRecords(writer, { records: where.records, now: NOW });
    } finally {
        writer.close();
    }
    const db = openForReading(where.index);
    if (db === undefined) throw new Error("the index was not made");
    t.after(() => {
        if (db.isOpen) db.close();
    });
    return db;
}

/** The sample records as an index open for reading. */
export const sampleDb = (t: TestContext) => indexOf(t, sampleRecords());

// ---- a fake Pi ------------------------------------------------------------------------------------------------------

export interface Notice {
    text: string;
    level: string;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** The ways Pi runs: with a terminal, behind RPC, or with no screen at all. */
export type Mode = "tui" | "rpc" | "print" | "json";

export interface FakePiOptions {
    mode?: Mode;
    /** The id `ctx.sessionManager.getSessionId()` returns, or undefined to make it fail. */
    session?: string | undefined;
}

/** What the plugin registers with Pi, and a screen that remembers what it was told. */
export class FakePi {
    /** Listeners on Pi's event bus, by event name. */
    readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
    /** What `ui.custom` was given, with the promise it returned. */
    readonly customs: Array<{
        component: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };
        result: Promise<unknown>;
        requested: { count: number };
    }> = [];
    /** The rows of the terminal, which a custom view sizes itself by. */
    rows = 30;
    readonly handlers = new Map<string, Handler[]>();
    readonly commands = new Map<
        string,
        { description?: string; handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown }
    >();
    /** Entry renderers by entry type, as Pi would call them. */
    readonly renderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();
    /** Everything that went to the screen as a notification. */
    readonly notices: Notice[] = [];
    /** Custom entries the plugin appended to the session: kept in it, and never sent to the model. */
    readonly entries: Array<{ type: string; data: unknown }> = [];
    /** Everything the plugin did that reaches the model: messages added to the conversation, and user messages. */
    readonly sent: unknown[] = [];
    readonly ctx: ExtensionCommandContext;

    constructor(options: FakePiOptions = {}) {
        const mode = options.mode ?? "tui";
        // `session: undefined` is a Pi that cannot say, which is not the same as leaving it out.
        const session = "session" in options ? options.session : "s2";
        this.ctx = {
            mode,
            hasUI: mode === "tui" || mode === "rpc",
            ui: {
                notify: (text: string, level?: string) => {
                    this.notices.push({ text, level: level ?? "info" });
                },
                custom: (
                    factory: (
                        tui: unknown,
                        theme: unknown,
                        keys: unknown,
                        done: (value?: unknown) => void,
                    ) => { render(width: number): string[]; handleInput(data: string): void; dispose?(): void },
                ) => {
                    let finish: (value?: unknown) => void = () => {};
                    const result = new Promise<unknown>((resolve) => {
                        finish = resolve;
                    });
                    const requested = { count: 0 };
                    const component = factory(
                        { terminal: { rows: this.rows }, requestRender: () => requested.count++ },
                        { fg: (_role: string, value: string) => value },
                        {},
                        (value) => finish(value),
                    );
                    this.customs.push({ component, result, requested });
                    return result;
                },
            },
            sessionManager: {
                getSessionId: () => {
                    if (session === undefined) throw new Error("no session");
                    return session;
                },
            },
        } as unknown as ExtensionCommandContext;
    }

    get api(): ExtensionAPI {
        return this as unknown as ExtensionAPI;
    }

    get events() {
        return {
            on: (name: string, listener: (payload: unknown) => void) => {
                this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
                return () => {
                    this.listeners.set(
                        name,
                        (this.listeners.get(name) ?? []).filter((item) => item !== listener),
                    );
                };
            },
            emit: (name: string, payload: unknown) => {
                for (const listener of this.listeners.get(name) ?? []) listener(payload);
            },
        };
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

    registerEntryRenderer(type: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown): void {
        this.renderers.set(type, renderer);
    }

    appendEntry(type: string, data?: unknown): void {
        this.entries.push({ type, data });
    }

    sendMessage(message: unknown): void {
        this.sent.push(message);
    }

    sendUserMessage(content: unknown): void {
        this.sent.push(content);
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

// ---- the plugin in a fake Pi ----------------------------------------------------------------------------------------

export interface RigOptions {
    /**
     * What the probe answers, one answer for each time it is asked, the last one for ever. A list answers for whichever
     * viewer is asked; an object answers for each viewer on its own (a viewer it leaves out is stopped).
     */
    answers?: ViewerState[] | Partial<Record<Viewer, ViewerState[]>>;
    /** The programs on PATH, by name. */
    installed?: Record<string, string>;
    /** The viewer's settings. Without them, the `lens` section of the fake jig-core, or the defaults. */
    settings?: NonNullable<LensOptions["settings"]>;
    /** Set when the started program has already exited. */
    exit?: { code: number | null };
    spawnFails?: Error;
    /** Called when the program is started, with the paths of the state folder. */
    onSpawn?: (where: Paths) => void;
    /** Whether a browser could be found to open the page. */
    opens?: boolean;
    /** How Pi runs. Default: with a terminal. */
    mode?: Mode;
    /** The id of the session the user is in. Default `s2`; undefined for a Pi that cannot say. */
    session?: string | undefined;
    /** The moment the plugin takes for now. Default: `NOW`. */
    now?: Date;
}

/** A plugin loaded into a fake Pi, with everything that would start a program or open a page recorded instead. */
export function rig(t: TestContext, o: RigOptions = {}) {
    const state = tempState(t);
    const spawned: ViewerCommand[] = [];
    const opened: string[] = [];
    const probes: Array<[string, number]> = [];
    const slept: number[] = [];
    const installed = o.installed ?? { grafana: "/usr/bin/grafana", datasette: "/usr/bin/datasette" };
    const asked = new Map<string, number>();
    const answerFor = (viewer: Viewer): ViewerState => {
        const { answers } = o;
        let key: string = viewer;
        let script: readonly ViewerState[] = ["stopped"];
        if (answers === undefined || Array.isArray(answers)) {
            key = "any";
            script = answers ?? ["stopped", "running"];
        } else {
            script = answers[viewer] ?? ["stopped"];
        }
        const n = asked.get(key) ?? 0;
        asked.set(key, n + 1);
        return script[Math.min(n, script.length - 1)] ?? "stopped";
    };
    const pi = new FakePi({ mode: o.mode ?? "tui", ...("session" in o ? { session: o.session } : {}) });
    lens({
        env: { JIG_STATE_DIR: state, PATH: "/usr/bin:/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "must-not-pass-on" },
        now: () => o.now ?? NOW,
        sessionsDir: () => path.join(state, "pi-sessions"),
        find: (names) => names.map((name) => installed[name]).find((file) => file !== undefined),
        homepath: () => undefined,
        probe: async (viewer, port) => {
            probes.push([viewer, port]);
            return answerFor(viewer);
        },
        spawn: async (command) => {
            spawned.push(command);
            o.onSpawn?.(paths(state));
            if (o.spawnFails !== undefined) throw o.spawnFails;
            return { pid: 4242, exited: () => o.exit };
        },
        open: async (url) => {
            opened.push(url);
            return o.opens ?? true;
        },
        sleep: async (ms) => {
            slept.push(ms);
        },
        ...(o.settings === undefined ? {} : { settings: o.settings }),
    })(pi.api);
    return { pi, state, where: paths(state), spawned, opened, probes, slept };
}

/** The text of notices, one after the other. */
export const text = (notices: readonly Notice[]) => notices.map((notice) => notice.text).join("\n");

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
