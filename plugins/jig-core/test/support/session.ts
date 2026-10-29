// A real Pi session (the SDK, with its scripted "faux" model) that has jig-core loaded and a few fake tools. The model
// is scripted to make the tool calls a test wants; everything else, the tool registry, the hooks and the way results
// reach the model, is Pi's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jig, withJig } from "../../src/client.ts";
import { JIG_EVENTS } from "../../src/contract.ts";
import type { CallClass, DecisionEvent } from "../../src/contract.ts";
import { jigCore } from "../../src/index.ts";
import type { Masker } from "../../src/mask/index.ts";
import { fakeMasker, fakeUi } from "./fakes.ts";
import type { FakeUiLog, FakeUiScript } from "./fakes.ts";
import { readRecords } from "./state.ts";

/** What the fake plugin saw. */
export interface PluginLog {
    executed: Array<{ tool: string; id: string; input: Record<string, unknown> }>;
    decisions: DecisionEvent[];
    /** The fake plugin's own section of jig.json, as `jig().config.section("fake")` returned it at session start. */
    section: unknown;
}

const fakeParameters = Type.Object({
    env: Type.Optional(Type.String()),
    action: Type.Optional(Type.String()),
    effect: Type.Optional(Type.String()),
    output: Type.Optional(Type.String()),
    secretRef: Type.Optional(Type.String()),
    fail: Type.Optional(Type.Boolean()),
    facts: Type.Optional(Type.Record(Type.String(), Type.Any())),
    body: Type.Optional(Type.String()),
    readPreview: Type.Optional(Type.Boolean()),
    marker: Type.Optional(Type.String()),
});

const outerParameters = Type.Object({ env: Type.Optional(Type.String()), effect: Type.Optional(Type.String()) });

const classifyByInput = (input: Readonly<Record<string, unknown>>): CallClass => ({
    ...(typeof input.action === "string" ? { action: input.action } : {}),
    environment: String(input.env ?? "local"),
    effect: input.effect === "write" ? "write" : "read",
});

/** Registers the fake tools. `fake_tool` is a Jig tool: it declares itself to jig-core, with a preview. */
export function fakePlugin(log: PluginLog): ExtensionFactory {
    return (pi) => {
        pi.events.on(JIG_EVENTS.decision, (data) => { log.decisions.push(data as DecisionEvent); });

        withJig((api) => {
            api.declareTool({
                tool: "fake_tool",
                plugin: "jig-test",
                classify: classifyByInput,
                preview: async (input) => ({
                    summary: `fake_tool ${String(input.action ?? "run")} in ${String(input.env ?? "local")}`,
                    ...(typeof input.body === "string" ? { body: input.body, format: "text" as const } : {}),
                    fingerprint: "fp-test",
                }),
            });
            api.declareTool({ tool: "outer_tool", plugin: "jig-test", classify: () => ({ environment: "local", effect: "read" }) });
            api.declareTool({ tool: "own_masker", plugin: "jig-test", masksOwnResults: true, classify: classifyByInput });
            api.config.registerSection("fake", (raw) => (typeof raw === "object" && raw !== null && typeof (raw as { level?: unknown }).level === "number" ? [] : ["fake.level must be a number"]));
        });

        pi.on("session_start", () => { log.section = jig().config.section("fake"); });

        pi.registerTool({
            name: "fake_tool",
            label: "Fake tool",
            description: "A Jig tool for tests.",
            parameters: fakeParameters,
            async execute(toolCallId, params) {
                log.executed.push({ tool: "fake_tool", id: toolCallId, input: params });
                if (params.fail === true) throw new Error("fake tool failed: boom");
                if (params.facts !== undefined) jig().addFacts(toolCallId, params.facts);
                let text = params.output ?? "ok";
                const details: Record<string, unknown> = { marker: params.marker };
                if (params.secretRef !== undefined) {
                    const secret = await jig().secrets.resolve(params.secretRef);
                    text += ` secret=${secret}`;
                    details.echo = secret;
                }
                if (params.readPreview === true) details.approved = jig().approvedPreview(toolCallId);
                return { content: [{ type: "text", text }], details, structuredContent: { text } };
            },
        });

        pi.registerTool({
            name: "own_masker",
            label: "Own masker",
            description: "A Jig tool that masks its own results.",
            parameters: fakeParameters,
            async execute(toolCallId, params) {
                log.executed.push({ tool: "own_masker", id: toolCallId, input: params });
                return { content: [{ type: "text", text: params.output ?? "ok" }], details: {} };
            },
        });

        pi.registerTool({
            name: "outer_tool",
            label: "Outer tool",
            description: "A tool that calls fake_tool through ctx.executeTool.",
            parameters: outerParameters,
            async execute(toolCallId, params, _signal, _onUpdate, ctx) {
                log.executed.push({ tool: "outer_tool", id: toolCallId, input: params });
                const nested = await ctx.executeTool("fake_tool", { env: params.env, effect: params.effect, action: "inner", output: "nested output" });
                const said = nested.result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
                return { content: [{ type: "text", text: `outer saw: ${nested.isError ? "ERROR " : ""}${said}` }], details: {} };
            },
        });

        // A tool that nobody classified: no declaration, no hints.
        pi.registerTool({
            name: "mystery_tool",
            label: "Mystery tool",
            description: "A tool nobody classified.",
            parameters: fakeParameters,
            async execute(toolCallId, params) {
                log.executed.push({ tool: "mystery_tool", id: toolCallId, input: params });
                return { content: [{ type: "text", text: "mystery done" }], details: {} };
            },
        });

        // Tools that say what they do through hints, as MCP tools do.
        pi.registerTool({
            name: "viewer_tool",
            label: "Viewer",
            description: "Read-only by its hints.",
            parameters: fakeParameters,
            annotations: { readOnlyHint: true },
            async execute(toolCallId, params) {
                log.executed.push({ tool: "viewer_tool", id: toolCallId, input: params });
                return { content: [{ type: "text", text: "viewed" }], details: {} };
            },
        });
        pi.registerTool({
            name: "editor_tool",
            label: "Editor",
            description: "Destructive by its hints.",
            parameters: fakeParameters,
            annotations: { destructiveHint: true },
            async execute(toolCallId, params) {
                log.executed.push({ tool: "editor_tool", id: toolCallId, input: params });
                return { content: [{ type: "text", text: "edited" }], details: {} };
            },
        });
    };
}

export interface ToolOutcome {
    text: string;
    isError: boolean;
    toolCallId: string;
    details: unknown;
    /** The result as `tool_execution_end` reported it, which is where `structuredContent` can be seen. */
    ended: { result: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; details?: unknown }; isError: boolean; durationMs?: number; parentToolCallId?: string } | undefined;
}

type Mode = "tui" | "rpc" | "json" | "print";

export interface WorldOptions {
    /** The content of jig.json. */
    config?: unknown;
    /** The screen: a script of answers, or none (the session has no way to ask). */
    ui?: FakeUiScript;
    mode?: Mode;
    masker?: Masker;
    /** Use the masker jig-core ships with, which is the stub until the mask port is built. */
    stubMasker?: boolean;
    /** Put the fake plugin before jig-core, so its `withJig` waits for jig-core to load. */
    pluginFirst?: boolean;
    env?: Record<string, string>;
}

export interface World {
    session: AgentSession;
    cwd: string;
    stateDir: string;
    agentDir: string;
    log: PluginLog;
    ui: FakeUiLog | undefined;
    /** One model turn that makes these tool calls, then a closing message. */
    calls(calls: Array<{ name: string; args: JsonObject; id?: string }>): Promise<ToolOutcome[]>;
    call(name: string, args?: JsonObject, id?: string): Promise<ToolOutcome>;
    /** Every line in the records: calls and turns. */
    records(): Array<Record<string, any>>;
    /** The lines for tool calls only. */
    callRecords(): Array<Record<string, any>>;
    close(): Promise<void>;
}

let worlds = 0;

/** Starts a session. `JIG_STATE_DIR` must already point at a temporary folder (see `tempState`). */
export async function startWorld(options: WorldOptions = {}): Promise<World> {
    const root = mkdtempSync(path.join(tmpdir(), "jig-world-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    if (options.config !== undefined) writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(options.config));

    const saved: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    for (const [name, value] of Object.entries(options.env ?? {})) {
        saved[name] = process.env[name];
        process.env[name] = value;
    }

    const modelRuntime = await ModelRuntime.create({
        authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "store.json"),
        allowModelNetwork: false, refreshOnCreate: false,
    });
    const faux = fauxProvider();
    modelRuntime.registerNativeProvider(faux.provider);

    const log: PluginLog = { executed: [], decisions: [], section: undefined };
    const jigFactory = options.stubMasker === true ? jigCore() : jigCore({ createMasker: () => options.masker ?? fakeMasker });
    const plugin = fakePlugin(log);
    const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir,
        extensionFactories: options.pluginFirst === true ? [plugin, jigFactory] : [jigFactory, plugin],
        noExtensions: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    const screen = options.ui === undefined ? undefined : fakeUi(options.ui);
    await session.bindExtensions(screen === undefined ? {} : { uiContext: screen.ui, mode: options.mode ?? "rpc" });

    const ended = new Map<string, NonNullable<ToolOutcome["ended"]> & { toolName: string }>();
    session.subscribe((event) => {
        if (event.type === "tool_execution_end") ended.set(event.toolCallId, event as never);
    });

    async function calls(list: Array<{ name: string; args: JsonObject; id?: string }>): Promise<ToolOutcome[]> {
        const before = session.messages.length;
        const ids = list.map((entry, index) => entry.id ?? `world${++worlds}-call${index}`);
        faux.setResponses([
            fauxAssistantMessage(list.map((entry, index) => fauxToolCall(entry.name, entry.args, { id: ids[index] as string })), { stopReason: "toolUse" }),
            fauxAssistantMessage("done"),
        ]);
        await session.prompt(`use ${list.map((entry) => entry.name).join(", ")}`);
        const results = session.messages.slice(before).filter((message) => message.role === "toolResult") as Array<{ toolCallId: string; content: Array<{ text?: string }>; isError: boolean; details: unknown }>;
        return ids.map((id) => {
            const message = results.find((result) => result.toolCallId === id);
            if (message === undefined) throw new Error(`no result for ${id}: ${JSON.stringify(session.messages.slice(before)).slice(0, 500)}`);
            return {
                text: message.content.map((block) => block.text ?? "").join("\n"),
                isError: message.isError === true,
                toolCallId: id,
                details: message.details,
                ended: ended.get(id),
            };
        });
    }

    return {
        session, cwd, agentDir, log,
        stateDir: process.env.JIG_STATE_DIR ?? "",
        ui: screen?.log,
        calls,
        call: async (name, args = {}, id) => (await calls([{ name, args, ...(id === undefined ? {} : { id }) }]))[0] as ToolOutcome,
        records: () => readRecords(process.env.JIG_STATE_DIR ?? "") as Array<Record<string, any>>,
        callRecords: () => (readRecords(process.env.JIG_STATE_DIR ?? "") as Array<Record<string, any>>).filter((record) => record.kind === "call"),
        async close() {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
}
