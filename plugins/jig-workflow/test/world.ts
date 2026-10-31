// A whole session for the plugin: the real jig-core (its hooks, rules, gates and questions), the plugin loaded into a fake Pi of
// its own, real git repositories in a temporary workspace, and a fake `gh`, sandbox and clock. A tool call goes through jig-core
// first, as in Pi: classified, decided, gated, asked, and only then run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { afterEach, beforeEach } from "node:test";
import type { ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JigApi } from "../../jig-core/src/contract.ts";
import { start as startCore } from "../../jig-core/test/support/harness.ts";
import type { Harness } from "../../jig-core/test/support/harness.ts";
import { tempState } from "../../jig-core/test/support/state.ts";
import { bashDeclaration } from "../../jig-sandbox/src/outside.ts";
import { workflow } from "../src/index.ts";
import type { RunScript, FakeHost } from "./support.ts";
import { fakeHost, git, makeRepo, tempFolder } from "./support.ts";

const EXAMPLES = path.resolve(import.meta.dirname, "../examples");

type Handler = (event: never, ctx: never) => unknown;

/** Pi, as far as the plugin uses it, with an event bus that delivers. */
export class PluginPi {
    handlers = new Map<string, Handler[]>();
    tools = new Map<string, ToolDefinition>();
    commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    messages: Array<{ message: { customType: string; content: string; details?: unknown }; options: unknown }> = [];
    private listeners = new Map<string, Array<(data: unknown) => void>>();
    private unsubscribed = 0;

    api = {
        on: (event: string, handler: Handler) => {
            this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
            return () => undefined;
        },
        registerTool: (tool: ToolDefinition) => void this.tools.set(tool.name, tool),
        registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) =>
            void this.commands.set(name, options),
        sendMessage: (message: { customType: string; content: string; details?: unknown }, options: unknown) =>
            void this.messages.push({ message, options }),
        events: {
            on: (channel: string, listener: (data: unknown) => void) => {
                this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
                return () => {
                    this.unsubscribed++;
                    this.listeners.set(
                        channel,
                        (this.listeners.get(channel) ?? []).filter((entry) => entry !== listener),
                    );
                };
            },
            emit: (channel: string, data: unknown) => {
                for (const listener of this.listeners.get(channel) ?? []) listener(data);
            },
        },
    };

    get unsubscribedCount(): number {
        return this.unsubscribed;
    }

    async fire(event: string, payload: Record<string, unknown>, ctx: unknown): Promise<unknown[]> {
        const answers: unknown[] = [];
        for (const handler of this.handlers.get(event) ?? [])
            answers.push(await handler({ type: event, ...payload } as never, ctx as never));
        return answers;
    }

    publish(channel: string, data: unknown): void {
        this.api.events.emit(channel, data);
    }
}

export interface Notice {
    text: string;
    level: string | undefined;
}

export interface World {
    core: Harness;
    pi: PluginPi;
    host: FakeHost;
    ctx: ExtensionContext;
    /** The workspace Pi runs in; the repositories and the ticket folder are inside it. */
    workspace: string;
    tickets: string;
    /** The folder of workflow files, as `workflow.folders` names it. */
    workflows: string;
    orders: string;
    other: string;
    /** What the session file holds; `activate` adds the entry `jig-memory` would. */
    entries: SessionEntry[];
    notices: Notice[];
    /** The answers the user gives to questions, in order: the label's position (0 allows) or "decline". Default: allow. */
    answers: Array<number | "decline">;
    /** What the user answers to `ctx.ui.confirm`. */
    confirm: boolean;
    /** Runs just before the user answers a question: whatever changes while the question is open. */
    beforeAnswer: (() => void) | undefined;
    /** Everything the user was asked in a selector, with its options. */
    asked: Array<{ title: string; options: string[] }>;
    /** What `ctx.executeTool` was asked to run. */
    executed: Array<{ name: string; args: Record<string, unknown> }>;
    /**
     * The `bash` tool as the plugin reaches it for a test that runs outside the sandbox: a nested call that goes through the real
     * jig-core (jig-sandbox's own declaration of `bash`, so the classification and the question are the real ones), and a stand-in
     * for the tool itself that runs only when jig-core lets the call through.
     */
    bash: {
        /** Every command that ran, with the reason and time limit the call carried and the id of the nested call. */
        ran: Array<{ id: string; command: string; reason: string; timeout: number | undefined }>;
        /** What a command does when it runs. Default: it prints nothing and exits 0. */
        script: ((command: string) => { code: number; output?: string; timedOut?: boolean }) | undefined;
    };
    activate(ticket: string | undefined): void;
    ticketDir(ticket?: string): string;
    writePlan(text: string, ticket?: string): void;
    writeNotes(text: string, ticket?: string): void;
    bind(...roots: string[]): void;
    /** Calls the tool through jig-core, as Pi does. */
    call(
        input: Record<string, unknown>,
        id?: string,
    ): Promise<{ blocked: boolean; reason: string | undefined; text: string; isError: boolean; ran: boolean }>;
    /** Calls any other tool through jig-core: it runs unless blocked. */
    other_(tool: string, input?: Record<string, unknown>): Promise<{ blocked: boolean; reason: string | undefined }>;
    command(args: string): Promise<Notice[]>;
    state(ticket?: string): Record<string, any> | undefined;
    writeState(change: (state: Record<string, any>) => void, ticket?: string): void;
}

export const PLAN = `## Approach
Cache the price list.

## Repositories
- orders-api

## Scenarios
1. Two reads, one query.
2. A price change shows at once.
`;

export interface WorldOptions {
    run?: RunScript;
    /** Extra files of the workflow folder, by name without .json. */
    workflows?: Record<string, unknown>;
    config?: Record<string, unknown>;
    ui?: boolean;
    trusted?: boolean;
    /** Skip starting the session (the plugin has not seen session_start). */
    noSession?: boolean;
    /** What a company plugin does while it loads, before the session starts. With it, jig.json has no `workflow` section,
     *  unless `userWorkflow` gives the user's own. */
    company?: (api: JigApi, workspace: string) => void;
    /** With `company`: the `workflow` section the user wrote in jig.json. `$workflows` stands for the world's folder of files. */
    userWorkflow?: Record<string, unknown>;
}

/** Hooks that keep the state folder of jig-core private to each test. */
export function useWorlds(): void {
    const state = tempState();
    beforeEach(() => state.start());
    afterEach(() => state.stop());
}

export async function world(t: TestContext, options: WorldOptions = {}): Promise<World> {
    const workspace = tempFolder(t);
    const tickets = path.join(workspace, "tickets");
    const workflows = path.join(workspace, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(path.join(workflows, "feature.json"), readFileSync(path.join(EXAMPLES, "feature.json")));
    for (const [name, content] of Object.entries(options.workflows ?? {})) {
        writeFileSync(
            path.join(workflows, `${name}.json`),
            typeof content === "string" ? content : JSON.stringify(content),
        );
    }
    const orders = makeRepo(workspace, "orders-api-PROJ-1", "git@github.example.com:acme/orders-api.git");
    const other = makeRepo(workspace, "unbound", "git@github.example.com:acme/unbound.git");

    const host = fakeHost(options.run === undefined ? {} : { run: options.run });
    const pi = new PluginPi();
    const entries: SessionEntry[] = [];
    const notices: Notice[] = [];
    const executed: World["executed"] = [];
    const asked: World["asked"] = [];
    const answers: World["answers"] = [];
    const bash: World["bash"] = { ran: [], script: undefined };
    const self: Partial<World> = {};

    const ctx = {
        cwd: workspace,
        hasUI: options.ui !== false,
        mode: "rpc",
        signal: undefined,
        ui: {
            notify: (text: string, level?: string) => void notices.push({ text, level }),
            confirm: async () => self.confirm === true,
            select: async () => undefined,
            input: async () => undefined,
        },
        sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "session-test" },
        isProjectTrusted: () => options.trusted === true,
        executeTool: async (name: string, args: Record<string, unknown>) => {
            if (name === "bash") throw new Error("the test world runs bash only for a call that has an id: use w.call");
            executed.push({ name, args });
            // What the git tool's `worktree add` does, with the real git.
            const destination = path.join(
                path.dirname(
                    String(args.repo).startsWith("/") ? String(args.repo) : path.join(workspace, String(args.repo)),
                ),
                String(args.dir),
            );
            const source = String(args.repo).startsWith("/")
                ? String(args.repo)
                : path.join(workspace, String(args.repo));
            git(source, "worktree", "add", "-q", "-b", String(args.branch), destination);
            return {
                toolCall: { id: "x", name, arguments: args },
                result: {
                    content: [{ type: "text", text: `Added the work tree ${destination} on ${String(args.branch)}.` }],
                    details: { path: destination, branch: args.branch },
                },
                isError: false,
            };
        },
    } as unknown as ExtensionContext;

    const core = await startCore({
        config: {
            memory: { folder: tickets },
            ...(options.company === undefined
                ? { workflow: { folders: [workflows], ...(options.config ?? {}) } }
                : options.userWorkflow === undefined
                  ? {}
                  : { workflow: JSON.parse(JSON.stringify(options.userWorkflow).replaceAll("$workflows", workflows)) }),
        },
        cwd: workspace,
        ui:
            options.ui === false
                ? false
                : {
                      select: (title, choices) => {
                          asked.push({ title, options: choices });
                          self.beforeAnswer?.();
                          const next = answers.shift() ?? 0;
                          return next === "decline" ? choices[choices.length - 1] : choices[next];
                      },
                      input: () => undefined,
                  },
        plugins: (api: JigApi) => {
            api.config.registerSection("memory", () => []);
            options.company?.(api, workspace);
            api.declareTool(bashDeclaration({ folder: () => workspace, home: () => path.join(workspace, "home") }));
            for (const tool of ["git", "deploy"]) {
                api.declareTool({
                    tool,
                    plugin: "jig-test",
                    classify: (input) => ({
                        ...(typeof input.action === "string" ? { action: input.action } : {}),
                        environment: "local",
                        effect: "write",
                    }),
                });
            }
            workflow({ host: Object.assign(host, { approvedPreview: (id: string) => api.approvedPreview(id) }) })(
                pi.api as never,
            );
        },
    });
    t.after(() => core.shutdown());

    const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
        result.content
            .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
            .join("\n");
    let counter = 0;
    let nested = 0;
    type ToolCtx = { executeTool(name: string, args: Record<string, unknown>): Promise<unknown> };

    /** A call to `bash` that the tool makes: decided by jig-core, run (here, scripted) only if it is let through. */
    async function nestedBash(parent: string, args: Record<string, unknown>) {
        const id = `${parent}/${++nested}`;
        const outcome = await core.call({
            tool: "bash",
            input: args,
            id,
            parent,
            run: () => {
                bash.ran.push({
                    id,
                    command: String(args.command),
                    reason: String(args.reason),
                    timeout: typeof args.timeout === "number" ? args.timeout : undefined,
                });
                const done = bash.script?.(String(args.command)) ?? { code: 0 };
                const output = done.output ?? "";
                if (done.timedOut === true) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `${output}\n\nCommand timed out after ${args.timeout} seconds`,
                            },
                        ],
                        isError: true,
                    };
                }
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: done.code === 0 ? output : `${output}\n\nCommand exited with code ${done.code}`,
                        },
                    ],
                    structuredContent: { output, truncated: false, exit_code: done.code, wall_time_seconds: 0.1 },
                    isError: done.code !== 0,
                };
            },
        });
        return {
            toolCall: { id, name: "bash", arguments: args },
            result: outcome.final,
            isError: outcome.final.isError === true,
        };
    }

    const w: World = {
        core,
        pi,
        host,
        ctx,
        workspace,
        tickets,
        workflows,
        orders,
        other,
        entries,
        notices,
        answers,
        confirm: false,
        beforeAnswer: undefined,
        asked,
        executed,
        bash,
        activate(ticket) {
            entries.push({
                type: "custom",
                customType: "jig-memory-ticket",
                data: { key: ticket ?? null },
            } as unknown as SessionEntry);
        },
        ticketDir: (ticket = "PROJ-1") => path.join(tickets, ticket),
        writePlan(text, ticket = "PROJ-1") {
            mkdirSync(w.ticketDir(ticket), { recursive: true });
            writeFileSync(path.join(w.ticketDir(ticket), "plan.md"), text);
        },
        writeNotes(text, ticket = "PROJ-1") {
            mkdirSync(w.ticketDir(ticket), { recursive: true });
            writeFileSync(path.join(w.ticketDir(ticket), "notes.md"), text);
        },
        bind(...roots) {
            mkdirSync(w.ticketDir(), { recursive: true });
            writeFileSync(path.join(w.ticketDir(), "ticket.json"), JSON.stringify({ repositories: roots }));
        },
        async call(input, id = `wf-${++counter}`) {
            const tool = pi.tools.get("workflow");
            if (tool === undefined) throw new Error("the plugin registered no workflow tool");
            const outcome = await core.call({
                tool: "workflow",
                input,
                id,
                run: async () => {
                    // Pi hands a tool a context whose `executeTool` makes calls that are children of this one.
                    const base = ctx as never as Partial<ToolCtx>;
                    const callCtx = {
                        ...ctx,
                        // A test that takes `executeTool` away from the context gets a call that cannot run other tools.
                        executeTool:
                            typeof base.executeTool !== "function"
                                ? undefined
                                : (name: string, args: Record<string, unknown>) =>
                                      name === "bash" ? nestedBash(id, args) : base.executeTool?.(name, args),
                    };
                    try {
                        const result = await tool.execute(id, input as never, undefined, undefined, callCtx as never);
                        return { content: result.content as never, details: result.details };
                    } catch (error) {
                        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
                    }
                },
            });
            return {
                blocked: outcome.blocked,
                reason: outcome.reason,
                text: textOf(outcome.final as never),
                isError: outcome.final.isError === true,
                ran: outcome.ran,
            };
        },
        async other_(tool, input = {}) {
            const outcome = await core.call({ tool, input });
            return { blocked: outcome.blocked, reason: outcome.reason };
        },
        async command(args) {
            const before = notices.length;
            await pi.commands.get("workflow")?.handler(args, ctx as never);
            return notices.slice(before);
        },
        state(ticket = "PROJ-1") {
            try {
                return JSON.parse(readFileSync(path.join(w.ticketDir(ticket), "workflow.json"), "utf8")) as Record<
                    string,
                    any
                >;
            } catch {
                return undefined;
            }
        },
        writeState(change, ticket = "PROJ-1") {
            const state = w.state(ticket) as Record<string, any>;
            change(state);
            writeFileSync(path.join(w.ticketDir(ticket), "workflow.json"), JSON.stringify(state));
        },
    };
    // The screen's answers read the world as it is when the question comes.
    Object.defineProperty(self, "confirm", { get: () => w.confirm });
    Object.defineProperty(self, "beforeAnswer", { get: () => w.beforeAnswer });

    if (options.noSession !== true) await pi.fire("session_start", { reason: "startup" }, ctx);
    return w;
}
