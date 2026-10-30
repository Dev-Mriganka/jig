// A fake Pi around the real coordinator and the real server, over real git repositories in a temporary workspace. Pi's
// folder, the review root and the browser are all temporary, so a test can open a review, use it as the browser does and
// read the record it left behind.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ReviewCoordinator } from "../../src/coordinator.ts";
import type { ReviewOptions } from "../../src/coordinator.ts";
import { workspaceDirFor } from "../../src/settings.ts";
import { installFakeJig } from "./fake-jig.ts";
import { git } from "./git.ts";
import type { FakeJig } from "./fake-jig.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export { git };

/** A temporary folder, and a function that removes everything made so far. */
export function temporaries(): { make(prefix: string): string; cleanup(): void } {
    const made: string[] = [];
    return {
        make: (prefix) => {
            const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
            made.push(dir);
            return dir;
        },
        cleanup: () => {
            for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** A repository with one commit and an uncommitted change, so a review of the workspace finds it. */
export function repositoryWithChange(dir: string, file: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, file), "one\ntwo\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, file), "one\nTWO\n");
}

export interface Session {
    /** Questions Pi asked the user, as "title: message". */
    asked: string[];
    /** Notices shown to the user. */
    notices: string[];
    /** The answer to a question; default no. */
    answer: (title: string) => boolean | Promise<boolean>;
    ctx: never;
}

/** The context Pi passes to a handler: an interactive session by default, `print` for `pi -p`. */
export function context(cwd: string, mode: "tui" | "print" | "json" = "tui", entries: unknown[] = []): Session {
    const session: Session = { asked: [], notices: [], answer: () => false, ctx: undefined as never };
    session.ctx = {
        mode,
        hasUI: mode === "tui",
        cwd,
        ui: {
            notify: (message: string) => void session.notices.push(message),
            confirm: async (title: string, message: string) => {
                session.asked.push(`${title}: ${message}`);
                return session.answer(title);
            },
            select: async () => undefined,
        },
        waitForIdle: async () => {},
        sessionManager: { getEntries: () => entries },
    } as never;
    return session;
}

export interface FakeHost {
    pi: never;
    /** Messages the extension sent to the agent as the user. */
    sent: string[];
    /** What the extension announced on the event bus. */
    events: Array<{ channel: string; data: unknown }>;
    /** Fires a Pi event; `payload` adds the event's fields (a tool_call's toolName and input). */
    fire(event: string, ctx: unknown, payload?: Record<string, unknown>): Promise<void>;
    run(command: string, args: string, ctx: unknown): Promise<void>;
    /** Runs a tool the extension registered, as Pi does: (toolCallId, params, signal, onUpdate, ctx). */
    tool(name: string, params: object, ctx: unknown): Promise<{ content: Array<{ text: string }> }>;
    /** The tools registered, by name. */
    toolNames(): string[];
}

export function fakeHost(): FakeHost {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const sent: string[] = [];
    const events: FakeHost["events"] = [];
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const pi = {
        on: (event: string, handler: Handler) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
            commands.set(name, options.handler);
        },
        registerTool: (definition: {
            name: string;
            execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
        }) => {
            tools.set(definition.name, definition);
        },
        sendUserMessage: (text: string) => {
            sent.push(text);
        },
        events: { emit: (channel: string, data: unknown) => void events.push({ channel, data }), on: () => () => {} },
    };
    return {
        pi: pi as never,
        sent,
        events,
        fire: async (event, ctx, payload = {}) => {
            for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
        },
        run: async (command, args, ctx) => {
            const handler = commands.get(command);
            if (!handler) throw new Error(`no such command: ${command}`);
            await handler(args, ctx);
        },
        tool: async (name, params, ctx) => {
            const definition = tools.get(name);
            if (!definition) throw new Error(`no such tool: ${name}`);
            return definition.execute("call-1", params, undefined, undefined, ctx);
        },
        toolNames: () => [...tools.keys()],
    };
}

/** Raw HTTP, so a test controls Host, Origin and the cookie exactly as the browser would send them. */
export function request(
    base: string,
    pathAndQuery: string,
    options: { method?: string; cookie?: string; body?: unknown; host?: string; origin?: string | null } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    const url = new URL(base);
    return new Promise((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const writes = options.method !== undefined && options.method !== "GET";
        const origin = options.origin === undefined ? (writes ? base : undefined) : (options.origin ?? undefined);
        const req = http.request(
            {
                host: "127.0.0.1",
                port: url.port,
                path: pathAndQuery,
                method: options.method ?? "GET",
                headers: {
                    host: options.host ?? `${url.hostname}:${url.port}`,
                    ...(options.cookie ? { cookie: options.cookie } : {}),
                    ...(origin ? { origin } : {}),
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    text += chunk;
                });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

export interface ReviewSession {
    /** Pi's folder: a workspace holding two repositories. */
    root: string;
    /** The review root: what the plugin keeps under Pi's agent folder. */
    agentRoot: string;
    /** Where the extension keeps this workspace's reviews. */
    reviewsDir: string;
    base: string;
    /** The browser's cookie, after following the link Pi printed. */
    cookie: string;
    host: FakeHost;
    jig: FakeJig;
    session: Session;
    /** The link Pi showed the user. */
    link: string;
    /** The review records on disk, newest last. */
    records(): Array<Record<string, unknown>>;
    /** Posts as the page does. */
    post(route: string, body?: unknown): ReturnType<typeof request>;
    get(route: string): ReturnType<typeof request>;
    close(): Promise<void>;
}

/** The repositories of the workspace `openReview` makes, as paths from Pi's folder. */
export const REPOSITORIES = ["orders-api", "worktrees/PROJ-1/orders-engine"];

/** The key of the ticket `openReview` binds to both repositories when the agent opens the review. */
export const TICKET = "PROJ-1";

/**
 * Runs `/code-review <args>` in a fresh workspace the way a user does, then visits the link it printed. `byAgent` opens
 * it as the agent does, with start_interactive_code_review in a session whose active ticket is bound to both repositories,
 * so it is the ticket's branch review (what /code-review gives there, and what a push needs); `ticket: false` leaves the
 * ticket out, so it reviews the uncommitted changes.
 */
export async function openReview(
    args = "",
    options: { byAgent?: boolean; ticket?: boolean } = {},
): Promise<ReviewSession> {
    const root = mkdtempSync(path.join(os.tmpdir(), "jig-review-ws-"));
    const agentRoot = mkdtempSync(path.join(os.tmpdir(), "jig-review-root-"));
    const tickets = mkdtempSync(path.join(os.tmpdir(), "jig-review-tickets-"));
    const savedBrowser = process.env.BROWSER;
    process.env.BROWSER = "true"; // the review link is read from Pi's notification; nothing opens
    for (const repository of REPOSITORIES) repositoryWithChange(path.join(root, repository), "Service.java");

    const jig = installFakeJig();
    jig.setSection("memory", { folder: tickets });
    const host = fakeHost();
    new ReviewCoordinator(host.pi, root, { root: agentRoot } satisfies ReviewOptions).register();
    const withTicket = options.byAgent === true && options.ticket !== false;
    if (withTicket) {
        mkdirSync(path.join(tickets, TICKET), { recursive: true });
        writeFileSync(path.join(tickets, TICKET, "ticket.json"), JSON.stringify({ repositories: REPOSITORIES }));
    }
    const session = context(
        root,
        "tui",
        withTicket ? [{ type: "custom", customType: "jig-memory-ticket", data: { key: TICKET } }] : [],
    );
    if (options.byAgent) await host.tool("start_interactive_code_review", {}, session.ctx);
    else await host.run("code-review", args, session.ctx);
    const link = session.notices.map((notice) => /^Interactive review ready: (\S+)$/.exec(notice)?.[1]).find(Boolean);
    if (!link) throw new Error(`no review link in: ${session.notices.join(" | ")}`);

    const url = new URL(link);
    const base = url.origin;
    const visit = await request(base, `${url.pathname}${url.search}`);
    const cookie = String(visit.headers["set-cookie"]).split(";")[0]!;
    const reviewsDir = path.join(workspaceDirFor(agentRoot, root), "reviews");

    return {
        root,
        agentRoot,
        reviewsDir,
        base,
        cookie,
        host,
        jig,
        session,
        link,
        records: () =>
            readdirSync(reviewsDir)
                .filter((name) => name.endsWith(".json"))
                .sort()
                .map(
                    (name) => JSON.parse(readFileSync(path.join(reviewsDir, name), "utf8")) as Record<string, unknown>,
                ),
        post: (route, body) => request(base, route, { method: "POST", cookie, body }),
        get: (route) => request(base, route, { cookie }),
        close: async () => {
            await host.fire("session_shutdown", session.ctx);
            jig.remove();
            if (savedBrowser === undefined) delete process.env.BROWSER;
            else process.env.BROWSER = savedBrowser;
            for (const dir of [root, agentRoot, tickets]) rmSync(dir, { recursive: true, force: true });
        },
    };
}
