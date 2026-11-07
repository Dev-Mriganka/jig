// Test support: a fake jig-core and a fake Pi, both recording what the plugin does. The plugin needs only Pi's types
// at run time, so none of Pi's SDK is loaded: the fakes stand in for the handful of calls the plugin makes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishJig, withdrawJig } from "../../jig-core/src/client.ts";
import type { JigApi, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { type CardFront, type CardSections, renderCard } from "../src/card.ts";
import factory from "../src/index.ts";
import { ticketPaths } from "../src/store.ts";

/** A ticket key pattern for tests, as a company plugin or jig.json would set it. */
export const PATTERN = "[A-Z][A-Z0-9]+-\\d+";

/** A temporary folder, removed when the test ends. */
export function tempFolder(t: TestContext): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jig-memory-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Writes a valid card for `ticket` into the tickets folder: front matter from `extra`, and the three sections. */
export function writeCard(
    folder: string,
    ticket: string,
    sections: CardSections,
    extra: Partial<Omit<CardFront, "ticket">> = {},
): string {
    const file = ticketPaths(folder, ticket).card;
    mkdirSync(ticketPaths(folder, ticket).dir, { recursive: true });
    const front: CardFront = {
        ticket,
        closedAt: "2026-10-01T09:00:00.000Z",
        repositories: [],
        keys: [],
        identifiers: [],
        errors: [],
        ...extra,
    };
    writeFileSync(file, renderCard(front, sections));
    return file;
}

/** What the fake jig-core recorded. Only the members jig-memory uses are real; the rest of JigApi is never called. */
export interface FakeJig {
    api: JigApi;
    /** Every setTicket call, in order. */
    tickets: Array<string | undefined>;
    /** The entry counts passed to records.recall, in order. */
    recalls: number[];
    /** The full records.recall inputs, in order. */
    recallInputs: Array<{
        tool: string;
        action: string;
        plugin: string;
        ticket?: string;
        entries: number;
        queries?: number;
    }>;
    /** Facts added to a call, in order. */
    factsCalls: Array<{ id: string; facts: Record<string, unknown> }>;
    /** Every section name the plugin asked for, in order. */
    reads: string[];
    /** The check each plugin registered for its section, by section name. */
    checks: Map<string, (raw: unknown) => readonly string[]>;
    /** The tools declared, by name. */
    declared: Map<string, ToolDeclaration>;
    /** Every text given to mask.text, in order. The fake masks an email address as `email#1`. */
    masked: string[];
}

/** `sections` is what jig.json holds, by section name: a section that is absent is undefined here. */
export function fakeJig(sections: Record<string, unknown>): FakeJig {
    const tickets: Array<string | undefined> = [];
    const recalls: number[] = [];
    const recallInputs: Array<{
        tool: string;
        action: string;
        plugin: string;
        ticket?: string;
        entries: number;
        queries?: number;
    }> = [];
    const factsCalls: Array<{ id: string; facts: Record<string, unknown> }> = [];
    const reads: string[] = [];
    const checks = new Map<string, (raw: unknown) => readonly string[]>();
    const declared = new Map<string, ToolDeclaration>();
    const masked: string[] = [];
    const api = {
        version: 1,
        declareTool: (declaration: ToolDeclaration) => {
            declared.set(declaration.tool, declaration);
        },
        mask: {
            text: (input: string) => {
                masked.push(input);
                return input.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "email#1");
            },
        },
        setTicket: (key: string | undefined) => {
            tickets.push(key);
        },
        records: {
            recall: (input: {
                tool: string;
                action: string;
                plugin: string;
                ticket?: string;
                entries: number;
                queries?: number;
            }) => {
                recalls.push(input.entries);
                recallInputs.push(input);
            },
        },
        addFacts: (id: string, facts: Record<string, unknown>) => {
            factsCalls.push({ id, facts });
        },
        config: {
            registerSection: (name: string, check: (raw: unknown) => readonly string[]) => {
                checks.set(name, check);
            },
            section: (name: string) => {
                reads.push(name);
                return sections[name];
            },
        },
    };
    return {
        api: api as unknown as JigApi,
        tickets,
        recalls,
        recallInputs,
        factsCalls,
        reads,
        checks,
        declared,
        masked,
    };
}

/** Publishes a fake jig-core for the rest of the test, the way jig-core itself does at start-up. */
export function useJig(t: TestContext, sections: Record<string, unknown> = {}): FakeJig {
    const jig = fakeJig(sections);
    publishJig(jig.api);
    t.after(() => withdrawJig(jig.api));
    return jig;
}

export interface Notice {
    text: string;
    level: string;
}

/** One entry of the session file as Pi keeps it. */
export type LogEntry = Record<string, unknown> & { type: string };

type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** The result a tool_result handler may return. */
export interface ToolResultChange {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
}

/**
 * One Pi process with the plugin loaded: the handlers it registered, its command, and the session file. A new FakePi
 * over the same log is a resume: Pi builds a new extension instance over the same session file.
 */
export class FakePi {
    readonly cwd: string;
    readonly log: LogEntry[];
    readonly notices: Notice[] = [];
    readonly sent: Array<{ message: { customType: string; content: string; details?: unknown }; options: unknown }> =
        [];
    readonly events = new Map<string, Handler[]>();
    readonly commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    readonly tools = new Map<string, ToolDefinition>();
    readonly ctx: ExtensionContext;

    constructor(cwd: string, log: LogEntry[] = []) {
        this.cwd = cwd;
        this.log = log;
        this.ctx = {
            cwd,
            hasUI: true,
            ui: {
                notify: (text: string, level?: string) => {
                    this.notices.push({ text, level: level ?? "info" });
                },
            },
            sessionManager: { getBranch: () => this.log },
        } as unknown as ExtensionContext;
    }

    /** The ExtensionAPI that the plugin's factory receives. */
    get api(): ExtensionAPI {
        return this as unknown as ExtensionAPI;
    }

    on(event: string, handler: Handler): void {
        this.events.set(event, [...(this.events.get(event) ?? []), handler]);
    }

    registerTool(tool: ToolDefinition): void {
        this.tools.set(tool.name, tool);
    }

    /**
     * Runs the `ticket` tool as Pi would: its execute, then every tool_result handler with what it returned. Returns what
     * the model would read, and whether it is an error.
     */
    async tool(input: Record<string, unknown>, name = "ticket"): Promise<{ text: string; isError: boolean }> {
        const tool = this.tools.get(name);
        if (tool === undefined) throw new Error(`no tool ${name}`);
        let result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean };
        try {
            const done = await tool.execute("call", input as never, undefined, undefined, this.ctx as never);
            result = {
                content: done.content as Array<{ type: string; text?: string }>,
                details: done.details,
                isError: false,
            };
        } catch (error) {
            return { text: error instanceof Error ? error.message : String(error), isError: true };
        }
        for (const handler of this.events.get("tool_result") ?? []) {
            const change = handler(
                { type: "tool_result", toolName: name, toolCallId: "call", input, ...result },
                this.ctx,
            ) as Partial<typeof result> | undefined;
            if (change !== undefined) result = { ...result, ...change };
        }
        return { text: result.content.map((part) => part.text ?? "").join("\n"), isError: result.isError };
    }

    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void {
        this.commands.set(name, options.handler);
    }

    appendEntry(customType: string, data?: unknown): void {
        this.log.push({ type: "custom", customType, data });
    }

    sendMessage(
        message: { customType: string; content: string; display: boolean; details?: unknown },
        options?: unknown,
    ): void {
        this.sent.push({ message, options });
        this.log.push({
            type: "custom_message",
            customType: message.customType,
            content: message.content,
            details: message.details,
        });
    }

    /** Runs every handler of an event in registration order, and returns what each one returned. */
    fire(event: string, payload: Record<string, unknown> = {}): unknown[] {
        return (this.events.get(event) ?? []).map((handler) => handler({ type: event, ...payload }, this.ctx));
    }

    start(reason = "startup"): unknown[] {
        return this.fire("session_start", { reason });
    }

    input(text: string, source = "interactive"): unknown[] {
        return this.fire("input", { text, source });
    }

    /** One tool result, as Pi hands it to tool_result handlers. */
    result(toolName: string, text: string, input: Record<string, unknown> = {}): unknown[] {
        return this.fire("tool_result", {
            toolName,
            toolCallId: "call",
            input,
            content: [{ type: "text", text }],
            isError: false,
            details: undefined,
        });
    }

    /** The agent has settled after a run. */
    settle(aborted = false): unknown[] {
        return this.fire("agent_settled", { aborted });
    }

    compact(): unknown[] {
        return this.fire("session_compact", { reason: "threshold", willRetry: false, fromExtension: false });
    }

    async command(args: string, name = "ticket"): Promise<void> {
        const handler = this.commands.get(name);
        if (handler === undefined) throw new Error(`no command ${name}`);
        await handler(args, this.ctx);
    }

    /** The custom messages in the session file, in order. */
    messages(): LogEntry[] {
        return this.log.filter((entry) => entry.type === "custom_message");
    }
}

/** A Pi process with the plugin loaded over `log`. jig-core is `jig`, which the test publishes first. */
export function loadPlugin(cwd: string, log: LogEntry[] = []): FakePi {
    const pi = new FakePi(cwd, log);
    factory(pi.api);
    return pi;
}

/** The text of a tool_result change, or undefined when a handler left the result alone. */
export function changed(results: readonly unknown[]): ToolResultChange | undefined {
    return results.find((result) => result !== undefined) as ToolResultChange | undefined;
}
