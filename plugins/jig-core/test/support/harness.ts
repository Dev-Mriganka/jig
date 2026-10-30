// Drives jig-core's hooks with hand-made events, the way Pi calls them for one tool call:
// tool_call, then (if it was not blocked) the tool runs and tool_result, then tool_execution_end.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jig } from "../../src/client.ts";
import type { JigApi } from "../../src/contract.ts";
import { jigCore } from "../../src/index.ts";
import type { Masker } from "../../src/mask/index.ts";
import { fakeMasker } from "./fakes.ts";
import type { FakeUiLog, FakeUiScript } from "./fakes.ts";
import { fakeContext, fakePi } from "./fake-pi.ts";
import type { FakePi, FakeTool } from "./fake-pi.ts";
import { readRecords } from "./state.ts";
import type { FakeClock } from "./clock.ts";

export interface Result {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    details?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
}

export interface Call {
    tool: string;
    input?: Record<string, unknown>;
    id?: string;
    parent?: string;
    /** What the tool returns, when it runs. */
    result?: Result;
    /** Where the tool does its work. It runs only if the call is not blocked. */
    // biome-ignore lint/suspicious/noConfusingVoidType: a run may return nothing at all
    run?: () => Promise<Result | void> | Result | void;
    durationMs?: number;
}

export interface Outcome {
    /** True when jig-core stopped the call. */
    blocked: boolean;
    /** What the model reads when it was blocked. */
    reason?: string;
    /** The result as the model gets it: after jig-core's replacement, or the error that blocked the call. */
    final: Result;
    ran: boolean;
}

export interface Harness {
    host: FakePi;
    api: JigApi;
    ctx: ExtensionContext;
    ui: FakeUiLog;
    stateDir: string;
    agentDir: string;
    call(call: Call): Promise<Outcome>;
    /** Runs the first half only: the tool_call hook. */
    gate(call: Call): Promise<{ block?: boolean; reason?: string } | undefined>;
    records(): Array<Record<string, any>>;
    decisions(): Array<Record<string, any>>;
    notifications(): string[];
    shutdown(): Promise<void>;
}

let counter = 0;

export interface StartOptions {
    /** The content of jig.json. */
    config?: unknown;
    ui?: FakeUiScript | false;
    mode?: "tui" | "rpc" | "print";
    tools?: FakeTool[];
    masker?: Masker;
    session?: string;
    signal?: AbortSignal;
    /** Pi's working folder, where a relative path starts. Default: this process's. */
    cwd?: string;
    /** Runs after jig-core is published and before the session starts, as a plugin's start-up would. */
    plugins?: (api: JigApi) => void;
    openPreview?: (preview: never, header: string) => Promise<string>;
    /** The time and timers the watch engine uses, so a test can move them by hand. Default: the real ones. */
    clock?: FakeClock;
}

/** Loads jig-core into a fake Pi and starts a session. The state folder must already be set (see `tempState`). */
export async function start(options: StartOptions = {}): Promise<Harness> {
    const agentDir = mkdtempSync(path.join(tmpdir(), "jig-agent-"));
    if (options.config !== undefined) writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(options.config));
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const host = fakePi(options.tools ?? []);
    jigCore({
        createMasker: () => options.masker ?? fakeMasker,
        ...(options.openPreview === undefined ? {} : { openPreview: options.openPreview as never }),
        ...(options.clock === undefined ? {} : { now: options.clock.date, timers: options.clock.timers }),
    })(host.pi);
    const api = jig();
    options.plugins?.(api);
    const { ctx, log } = fakeContext({
        ...(options.ui === undefined ? {} : { ui: options.ui }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    await host.fire("session_start", { reason: "startup" }, ctx);

    // Records written before this session started belong to somebody else.
    const earlier = readRecords(process.env.JIG_STATE_DIR ?? "").length;

    const toEvent = (call: Call, id: string) => ({
        toolCallId: id,
        toolName: call.tool,
        input: call.input ?? {},
        ...(call.parent === undefined ? {} : { parentToolCallId: call.parent }),
    });

    return {
        host,
        api,
        ctx,
        ui: log,
        agentDir,
        stateDir: process.env.JIG_STATE_DIR ?? "",
        gate: async (call) =>
            host.fire("tool_call", toEvent(call, call.id ?? `call-${++counter}`), ctx) as Promise<
                { block?: boolean; reason?: string } | undefined
            >,
        async call(call) {
            const id = call.id ?? `call-${++counter}`;
            const answer = (await host.fire("tool_call", toEvent(call, id), ctx)) as
                | { block?: boolean; reason?: string }
                | undefined;
            let outcome: Outcome;
            if (answer?.block === true) {
                // What Pi does for a blocked call: the reason becomes the error result, and the tool never runs.
                const final: Result = {
                    content: [{ type: "text", text: answer.reason ?? "Tool execution was blocked" }],
                    details: {},
                    isError: true,
                };
                outcome = {
                    blocked: true,
                    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
                    final,
                    ran: false,
                };
            } else {
                let produced: Result;
                try {
                    produced = (await call.run?.()) ??
                        call.result ?? { content: [{ type: "text", text: "ok" }], details: undefined };
                } catch (error) {
                    produced = {
                        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                        details: {},
                        isError: true,
                    };
                }
                const replacement = (await host.fire(
                    "tool_result",
                    {
                        ...toEvent(call, id),
                        content: produced.content,
                        details: produced.details,
                        structuredContent: produced.structuredContent,
                        isError: produced.isError === true,
                    },
                    ctx,
                )) as Partial<Result> | undefined;
                // What Pi does with the answer: structured content goes unless it is returned along with the content.
                const final: Result = { ...produced };
                if (replacement?.content !== undefined) {
                    final.content = replacement.content;
                    if (replacement.structuredContent === undefined) delete final.structuredContent;
                }
                if (replacement?.details !== undefined) final.details = replacement.details;
                if (replacement?.structuredContent !== undefined)
                    final.structuredContent = replacement.structuredContent;
                if (replacement?.isError !== undefined) final.isError = replacement.isError;
                outcome = { blocked: false, final, ran: true };
            }
            await host.fire(
                "tool_execution_end",
                {
                    toolCallId: id,
                    toolName: call.tool,
                    result: outcome.final,
                    isError: outcome.final.isError === true,
                    ...(outcome.ran && call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
                    ...(call.parent === undefined ? {} : { parentToolCallId: call.parent }),
                },
                ctx,
            );
            return outcome;
        },
        records: () => readRecords(process.env.JIG_STATE_DIR ?? "").slice(earlier) as Array<Record<string, any>>,
        decisions: () =>
            host.emitted
                .filter((entry) => entry.channel === "jig:decision")
                .map((entry) => entry.data as Record<string, any>),
        notifications: () => log.notifications.map((entry) => entry.message),
        async shutdown() {
            await host.fire("session_shutdown", { reason: "quit" }, ctx);
            rmSync(agentDir, { recursive: true, force: true });
            if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
        },
    };
}

export const text = (value: string): Result => ({ content: [{ type: "text", text: value }] });

export function textOf(result: Result): string {
    return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
