// A stand-in for Pi's extension API with a working event bus, enough to load the plugin, start a session, run its tool and
// its command, and end the session.
import type {
    ExtensionAPI,
    ExtensionContext,
    RegisteredCommand,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: never, ctx: never) => unknown;

export interface FakeScreen {
    notifications: Array<{ message: string; type: string | undefined }>;
    selects: Array<{ title: string; options: string[] }>;
    statuses: Map<string, string | undefined>;
}

export interface FakePi {
    pi: ExtensionAPI;
    handlers: Map<string, Handler[]>;
    commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
    tools: Map<string, ToolDefinition>;
    /** Runs every handler of an event, in order. */
    fire(type: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown>;
    /** Events on the bus: what listeners got. */
    bus: { emit(channel: string, data: unknown): void };
}

export function fakePi(): FakePi {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const bus = {
        emit(channel: string, data: unknown) {
            for (const listener of listeners.get(channel) ?? []) listener(data);
        },
    };
    const pi = {
        on(type: string, handler: Handler) {
            handlers.set(type, [...(handlers.get(type) ?? []), handler]);
            return () => {};
        },
        registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
            commands.set(name, options);
        },
        registerTool(tool: ToolDefinition) {
            tools.set(tool.name, tool);
        },
        getAllTools: () =>
            [...tools.values()].map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })),
        events: {
            emit: bus.emit,
            on(channel: string, listener: (data: unknown) => void) {
                listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
                return () => {};
            },
        },
        sendMessage() {},
    } as unknown as ExtensionAPI;
    return {
        pi,
        handlers,
        commands,
        tools,
        bus,
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
    screen: FakeScreen;
}

/** A context for a hook or a command, with a screen unless `ui: false`. `select` answers the questions asked. */
export function fakeContext(
    options: {
        cwd: string;
        session?: string;
        ui?: boolean;
        select?: (title: string, options: string[]) => string | undefined;
    } = { cwd: process.cwd() },
): FakeContext {
    const screen: FakeScreen = { notifications: [], selects: [], statuses: new Map() };
    const ui = {
        notify: (message: string, type?: string) => screen.notifications.push({ message, type }),
        select: async (title: string, choices: string[]) => {
            screen.selects.push({ title, options: choices });
            return options.select?.(title, choices);
        },
        setStatus: (key: string, text: string | undefined) => screen.statuses.set(key, text),
        confirm: async () => false,
        input: async () => undefined,
        theme: { fg: (_color: string, text: string) => text },
    };
    const ctx = {
        hasUI: options.ui !== false,
        mode: options.ui === false ? "print" : "rpc",
        ui,
        cwd: options.cwd,
        signal: undefined,
        model: undefined,
        sessionManager: { getSessionId: () => options.session ?? "session-test", getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    return { ctx, screen };
}
