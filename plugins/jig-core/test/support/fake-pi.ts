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
    /** Runs every handler of an event, in order, and returns the last answer that was not undefined. */
    fire(type: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown>;
}

export function fakePi(tools: FakeTool[] = []): FakePi {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const registered = new Map<string, ToolDefinition>();
    const sent: FakePi["sent"] = [];
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
    } = {},
): FakeContext {
    const screen = fakeUi(options.ui === false ? {} : (options.ui ?? { select: () => "Allow" }));
    const ctx = {
        hasUI: options.ui !== false,
        mode: options.mode ?? (options.ui === false ? "print" : "rpc"),
        ui: screen.ui,
        signal: options.signal,
        cwd: options.cwd ?? process.cwd(),
        sessionManager: { getSessionId: () => options.session ?? "session-test" },
    } as unknown as ExtensionContext;
    return { ctx, log: screen.log };
}
