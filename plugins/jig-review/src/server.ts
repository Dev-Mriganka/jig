// The local server behind the review page: the page's files, a small JSON API, and a stream that tells the page when
// something changed. It listens on 127.0.0.1 only, on a random port, for this Pi session only.
//
// Who may use it. The agent's shell shares this machine's network, so the server cannot rely on being unreachable. A request
// is served only with:
//   - the right Host (`127.0.0.1:<port>` or `localhost:<port>`), so a page on another name cannot reach it by DNS rebinding;
//   - the session cookie, which the link given to the user sets once (the link carries a secret, swapped for an HttpOnly
//     cookie and then dropped from the address);
//   - for a write, an Origin that is this server's own, so another site's page cannot post to it.
// Comments from the page reach the agent as the user's words, which is why only this page may send them. Approving is
// stronger still: it needs a passkey signature, or a `y` in Pi, and no secret in this file can make either (see
// approval.ts). The link goes only to the user, but it can show up in the opener's arguments, so approval never relies on it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApprovalError } from "./approval.ts";
import type { ApprovalService } from "./approval.ts";
import type { ReviewRecord, ReviewSettings } from "./types.ts";

export type SubmittedCommentInput = {
    body: string;
    filePath?: string;
    line?: number;
    side?: "old" | "new";
};

export type CommentSubmissionMode = "ask" | "review";

export type ReviewServerHandlers = {
    getReview: () => ReviewRecord | undefined;
    getReviewById: (id: string) => Promise<ReviewRecord | undefined>;
    getReviews: () => Promise<ReviewRecord[]>;
    getSettings: () => Promise<ReviewSettings>;
    submitComments: (comments: SubmittedCommentInput[], mode: CommentSubmissionMode) => Promise<void>;
    updateSettings: (settings: Partial<ReviewSettings>) => Promise<void>;
    approval: ApprovalService;
};

export const COOKIE = "jig_review";

/** The page is opened at `localhost`, because a passkey's relying party id cannot be an IP address. */
const PAGE_HOST = "localhost";

const MAX_BODY_BYTES = 1024 * 1024;

/** Hosts the local browser review UI, JSON APIs, and server-sent updates. */
export class ReviewServer {
    private server?: Server;
    private port = 0;
    /** Per-session secret: the printed link carries it once, then a same-site cookie does. */
    private readonly secret = randomBytes(24).toString("base64url");
    private readonly clients = new Set<ReadableStreamDefaultController<string>>();
    private readonly handlers: ReviewServerHandlers;

    public constructor(handlers: ReviewServerHandlers) {
        this.handlers = handlers;
    }

    /** Starts the server if needed and returns its base URL, `http://localhost:<port>`. */
    public async start(): Promise<string> {
        if (this.server === undefined) {
            this.server = serve({ fetch: this.createApp().fetch, hostname: "127.0.0.1", port: 0 }) as Server;
            await new Promise<void>((resolve) => {
                this.server?.once("listening", resolve);
            });
            this.port = (this.server.address() as AddressInfo).port;
        }
        return `http://${PAGE_HOST}:${this.port.toString()}`;
    }

    /** The origins a page of this server can have: what a passkey ceremony's clientDataJSON must name. */
    public origins(): string[] {
        return [`http://${PAGE_HOST}:${this.port.toString()}`, `http://127.0.0.1:${this.port.toString()}`];
    }

    /** The link to open: carries the session secret, which the server swaps for a cookie on the first visit. */
    public authorize(url: string): string {
        return `${url}${url.includes("?") ? "&" : "?"}k=${this.secret}`;
    }

    /** Stops the server and drops the open event streams. */
    public stop(): void {
        this.server?.close();
        this.server?.closeAllConnections();
        this.server = undefined;
        this.clients.clear();
        this.handlers.approval.stop();
    }

    /** Tells the connected pages that something changed. */
    public publish(type: string): void {
        for (const client of this.clients) {
            try {
                client.enqueue(`event: ${type}\ndata: {}\n\n`);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    private createApp(): Hono {
        const app = new Hono();
        const approval = this.handlers.approval;

        app.use("*", async (context, next) => {
            const hosts = [`127.0.0.1:${this.port.toString()}`, `localhost:${this.port.toString()}`];
            if (!hosts.includes(context.req.header("host") ?? "")) return context.text("Forbidden", 403);
            const key = context.req.query("k");
            if (key !== undefined) {
                if (!sameSecret(key, this.secret))
                    return context.text("This review link has expired: open the one Pi printed.", 403);
                // Lax, because Strict is not sent on the redirect after the link was opened from outside the browser.
                context.header("Set-Cookie", `${COOKIE}=${this.secret}; HttpOnly; SameSite=Lax; Path=/`);
                return context.redirect(context.req.path, 302);
            }
            if (!sameSecret(readCookie(context.req.header("cookie"), COOKIE), this.secret)) {
                return context.text("Open the review from the link Pi printed.", 403);
            }
            const origin = context.req.header("origin");
            if (
                context.req.method !== "GET" &&
                origin !== undefined &&
                !hosts.some((host) => origin === `http://${host}`)
            ) {
                return context.text("Forbidden", 403);
            }
            await next();
            // On the finished response, not before: a response a handler builds itself (a file, the event stream) would
            // otherwise lose the headers.
            for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
                if (!context.res.headers.has(name)) context.res.headers.set(name, value);
            }
        });
        app.use(
            "/api/*",
            bodyLimit({
                maxSize: MAX_BODY_BYTES,
                onError: (context) => context.json({ error: "The request is too big." }, 413),
            }),
        );

        app.onError((error, context) => {
            if (error instanceof ApprovalError) return context.json({ error: error.message }, error.status as 400);
            return context.json({ error: "The server could not do that." }, 500);
        });

        app.get("/api/reviews", async (context) =>
            context.json({ activeReviewId: this.handlers.getReview()?.id, reviews: await this.handlers.getReviews() }),
        );

        app.get("/api/reviews/:id", async (context) => {
            const review = await this.handlers.getReviewById(context.req.param("id"));
            if (review === undefined) return context.json({ error: "Review not found" }, 404);
            return context.json({
                isActive: this.handlers.getReview()?.id === review.id,
                review,
                settings: await this.handlers.getSettings(),
            });
        });

        app.get("/api/review", async (context) => {
            const review = this.handlers.getReview();
            if (review === undefined) return context.json({ error: "No active review" }, 404);
            return context.json({ isActive: true, review, settings: await this.handlers.getSettings() });
        });

        app.post("/api/comments", async (context) => {
            await this.handlers.submitComments(parseSubmittedComments(await readJson(context)), "review");
            this.publish("review-updated");
            return context.json({ ok: true });
        });

        app.post("/api/ask", async (context) => {
            await this.handlers.submitComments(parseSubmittedComments(await readJson(context)), "ask");
            this.publish("review-updated");
            return context.json({ ok: true });
        });

        // Approval. There is no route that approves because the page asked: each of these checks something the agent
        // cannot supply (a passkey signature) or waits for the user in Pi.
        app.post("/api/approve/options", (context) => context.json(approval.approvalOptions()));
        app.post("/api/approve/passkey", async (context) =>
            context.json(await approval.approveWithPasskey(await readJson(context))),
        );
        app.post("/api/approve/page", async (context) => context.json(await approval.approveInPage()));

        app.get("/api/passkeys", (context) => context.json(approval.passkeys()));
        app.post("/api/passkeys/options", (context) => context.json(approval.registrationOptions()));
        app.post("/api/passkeys", async (context) =>
            context.json({ ok: true, passkey: await approval.register(await readJson(context)) }),
        );
        app.delete("/api/passkeys/:fingerprint", async (context) => {
            const result = await approval.removePasskey(context.req.param("fingerprint"));
            return context.json(result, result.ok ? 200 : 409);
        });

        app.get("/api/settings", async (context) => context.json(await this.handlers.getSettings()));

        app.patch("/api/settings", async (context) => {
            await this.handlers.updateSettings(parseSettingsUpdate(await readJson(context)));
            this.publish("review-updated");
            return context.json({ ok: true });
        });

        app.get("/api/events", () => this.createEventsResponse());

        app.get("/*", (context) => readStaticAsset(context.req.path));

        return app;
    }

    private createEventsResponse(): Response {
        let client: ReadableStreamDefaultController<string> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<string>({
            start: (controller): void => {
                client = controller;
                this.clients.add(controller);
                controller.enqueue("event: connected\ndata: {}\n\n");
                heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(": heartbeat\n\n");
                    } catch {
                        this.clients.delete(controller);
                        if (heartbeat !== undefined) clearInterval(heartbeat);
                    }
                }, 15000);
            },
            cancel: (): void => {
                if (client !== undefined) this.clients.delete(client);
                if (heartbeat !== undefined) clearInterval(heartbeat);
            },
        });

        return new Response(stream.pipeThrough(new TextEncoderStream()), {
            headers: {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
            },
        });
    }
}

function readCookie(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? "").split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) return value.join("=");
    }
    return undefined;
}

function sameSecret(given: string | undefined, secret: string): boolean {
    if (given === undefined) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** The request's JSON body; a body that is not JSON is the caller's mistake, answered 400. */
async function readJson(context: Context): Promise<unknown> {
    try {
        return await context.req.json();
    } catch {
        throw new ApprovalError(400, "The request body is not JSON.");
    }
}

/**
 * Sent with every response. The policy lets a page load only its own files and talk to nobody but this server; the rest
 * keep a browser from guessing a type, caching what is private, or sending the link on as a referrer.
 */
const SECURITY_HEADERS: Record<string, string> = {
    "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
};

async function readStaticAsset(requestPath: string): Promise<Response> {
    const webRoot = getWebRoot();
    let relativePath: string;
    try {
        relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
    } catch {
        return new Response("Not found", { status: 404 });
    }
    const filePath = path.join(webRoot, relativePath);
    if (isOutsideDirectory(filePath, webRoot)) return new Response("Not found", { status: 404 });
    try {
        return new Response(await readFile(filePath), { headers: getStaticAssetHeaders(filePath) });
    } catch {
        // A path the page's router knows (a review's own address) gets the page, so a reload keeps the place.
        try {
            return new Response(await readFile(path.join(webRoot, "index.html")), {
                headers: getStaticAssetHeaders("index.html"),
            });
        } catch {
            return new Response("The review page is not built: run `npm --prefix plugins/jig-review/web run build`.", {
                status: 500,
            });
        }
    }
}

function getWebRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
}

function parseSettingsUpdate(body: unknown): Partial<ReviewSettings> {
    if (!isRecord(body)) return {};
    const settings: Partial<ReviewSettings> = {};
    if (typeof body.autoAskReview === "boolean") settings.autoAskReview = body.autoAskReview;
    if (typeof body.autoOpenBrowser === "boolean") settings.autoOpenBrowser = body.autoOpenBrowser;
    if (body.diffView === "split" || body.diffView === "unified") settings.diffView = body.diffView;
    return settings;
}

function isOutsideDirectory(filePath: string, directory: string): boolean {
    const relativePath = path.relative(directory, filePath);
    return relativePath.startsWith("..") || path.isAbsolute(relativePath);
}

function parseSubmittedComments(body: unknown): SubmittedCommentInput[] {
    if (!isRecord(body) || !Array.isArray(body.comments)) return [];
    return body.comments.flatMap(parseSubmittedComment);
}

function parseSubmittedComment(value: unknown): SubmittedCommentInput[] {
    if (!isRecord(value) || typeof value.body !== "string") return [];
    const body = value.body.trim();
    if (body.length === 0) return [];
    const comment: SubmittedCommentInput = { body };
    if (typeof value.filePath === "string" && value.filePath.length > 0) comment.filePath = value.filePath;
    if (typeof value.line === "number" && Number.isFinite(value.line)) comment.line = value.line;
    if (value.side === "old" || value.side === "new") comment.side = value.side;
    return [comment];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getStaticAssetHeaders(filePath: string): Record<string, string> {
    return {
        "Cache-Control": "no-store",
        "Content-Type": getContentType(filePath),
    };
}

function getContentType(filePath: string): string {
    if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
    if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
    return "application/octet-stream";
}
