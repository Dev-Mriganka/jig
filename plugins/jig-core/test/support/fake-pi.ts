// A stand-in for Pi's extension API, to drive jig-core's hooks by hand with events of our own making. The integration
// tests run the same hooks inside a real Pi session; this is for cases that are hard to cause there.
import type {
    ExtensionAPI,
    ExtensionContext,
    RegisteredCommand,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fakeUi } from "./fakes.ts";
import type { FakeUiLog, FakeUiScript } from "./fakes.ts";

type Handler = (event: never, ctx: never) => unknown;

export interface FakeTool {
    name: string;
    annotations?: Record<string, boolean>;
    parameters?: unknown;
    sourceInfo?: { source: string };
}

export interface FakePi {
    pi: ExtensionAPI;
    handlers: Map<string, Handler[]>;
    commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
    /** What was emitted on the event bus, in order. */
    emitted: Array<{ channel: string; data: unknown }>;
    /** The tools the extension registered, by name. Pi lists them too, after `tools`. */
    registered: Map<string, ToolDefinition>;
    /** The custom messages the extension sent, with the options it sent them with. */
    sent: Array<{
        message: { customType: string; content: unknown; display: boolean; details?: unknown };
        options: unknown;
    }>;
    tools: FakeTool[];
    /** The entries `pi.appendEntry` was given, in order: they are kept in the session file and never reach the model. */
    entries: Array<{ customType: string; data: unknown }>;
    /** The messages `pi.sendUserMessage` was given, as if the user had typed them, with the options they were sent with. */
    userMessages: Array<{ content: unknown; options: unknown }>;
    /** The renderers extensions registered, by the type they draw (`registerEntryRenderer`, `registerMessageRenderer`). */
    entryRenderers: Map<string, unknown>;
    messageRenderers: Map<string, unknown>;
    /** What `pi.getThinkingLevel()` answers. Default `off`. */
    thinkingLevel: string;
    /** Runs every handler of an event, in order, and returns the last answer that was not undefined. */
    fire(type: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown>;
}

export function fakePi(tools: FakeTool[] = []): FakePi {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const registered = new Map<string, ToolDefinition>();
    const sent: FakePi["sent"] = [];
    const entries: FakePi["entries"] = [];
    const userMessages: FakePi["userMessages"] = [];
    const entryRenderers = new Map<string, unknown>();
    const messageRenderers = new Map<string, unknown>();
    const fake = { thinkingLevel: "off" };
    const pi = {
        on(type: string, handler: Handler) {
            handlers.set(type, [...(handlers.get(type) ?? []), handler]);
            return () => {};
        },
        registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
            commands.set(name, options);
        },
        registerTool(tool: ToolDefinition) {
            registered.set(tool.name, tool);
        },
        sendMessage(message: FakePi["sent"][number]["message"], options: unknown) {
            sent.push({ message, options });
        },
        // The calls other plugins make that jig-core does not: a plugin that draws its own entries, keeps a note in the session,
        // sends a message as the user, or reads the thinking level.
        sendUserMessage(content: unknown, options?: unknown) {
            userMessages.push({ content, options });
        },
        appendEntry(customType: string, data?: unknown) {
            entries.push({ customType, data });
        },
        registerEntryRenderer(customType: string, renderer: unknown) {
            entryRenderers.set(customType, renderer);
        },
        registerMessageRenderer(customType: string, renderer: unknown) {
            messageRenderers.set(customType, renderer);
        },
        getThinkingLevel: () => fake.thinkingLevel,
        // Pi lists the tools extensions registered along with the ones it was given.
        getAllTools: () => [
            ...tools,
            ...[...registered.values()].map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })),
        ],
        events: {
            emit: (channel: string, data: unknown) => {
                emitted.push({ channel, data });
            },
            on: () => () => {},
        },
    } as unknown as ExtensionAPI;
    return {
        pi,
        handlers,
        commands,
        emitted,
        registered,
        sent,
        entries,
        userMessages,
        entryRenderers,
        messageRenderers,
        get thinkingLevel() {
            return fake.thinkingLevel;
        },
        set thinkingLevel(level: string) {
            fake.thinkingLevel = level;
        },
        tools,
        async fire(type, event, ctx) {
            let answer: unknown;
            for (const handler of handlers.get(type) ?? []) {
                const result = await handler({ type, ...event } as never, ctx as never);
                if (result !== undefined) answer = result;
            }
            return answer;
        },
    };
}

export interface FakeContext {
    ctx: ExtensionContext;
    log: FakeUiLog;
}

/** A context for a hook: with a screen (default) or without, in the given mode, in the given session. */
export function fakeContext(
    options: {
        ui?: FakeUiScript | false;
        mode?: "tui" | "rpc" | "print";
        session?: string;
        signal?: AbortSignal;
        cwd?: string;
        /** What `sessionManager.getBranch()` returns: the entries of the conversation so far. Default none. */
        branch?: readonly unknown[];
    } = {},
): FakeContext {
    const screen = fakeUi(options.ui === false ? {} : (options.ui ?? { select: () => "Allow" }));
    const ctx = {
        hasUI: options.ui !== false,
        mode: options.mode ?? (options.ui === false ? "print" : "rpc"),
        ui: screen.ui,
        signal: options.signal,
        cwd: options.cwd ?? process.cwd(),
        sessionManager: {
            getSessionId: () => options.session ?? "session-test",
            getBranch: () => [...(options.branch ?? [])],
        },
    } as unknown as ExtensionContext;
    return { ctx, log: screen.log };
}
