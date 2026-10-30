// The server's own security, with no review behind it: who may talk to it, and what it refuses.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ApprovalService } from "../src/approval.ts";
import { PasskeyStore } from "../src/passkey/store.ts";
import { ReviewServer } from "../src/server.ts";

let server: ReviewServer;
let base = "";
let link = "";
let port = 0;
let dir = "";
const submitted: string[] = [];
const asked: string[] = [];

before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "jig-review-server-"));
    const approval = new ApprovalService(
        {
            current: () => undefined,
            ask: async (title) => {
                asked.push(title);
                return "yes";
            },
            pageApproved: async () => {},
            pageDeclined: async () => {},
            approved: async () => {},
            changed: () => {},
        },
        new PasskeyStore(path.join(dir, "passkeys.json")),
        () => server.origins(),
    );
    server = new ReviewServer({
        getReview: () => undefined,
        getReviewById: async () => undefined,
        getReviews: async () => [],
        getSettings: async () => ({ autoAskReview: false, autoOpenBrowser: false, diffView: "split" }),
        submitComments: async (comments) => {
            submitted.push(...comments.map((c) => c.body));
        },
        updateSettings: async () => {},
        approval,
    });
    base = await server.start();
    port = Number(new URL(base).port);
    link = server.authorize(`${base}/review/r1/files`);
});
after(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
});

/** Raw HTTP, so the test controls Host and Origin like an attacker could. */
function request(
    pathAndQuery: string,
    options: { method?: string; host?: string; cookie?: string; origin?: string; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                // A fresh connection each time: the server may answer a big body early and close that one.
                agent: false,
                path: pathAndQuery,
                method: options.method ?? "GET",
                headers: {
                    host: options.host ?? `localhost:${port}`,
                    ...(options.cookie ? { cookie: options.cookie } : {}),
                    ...(options.origin ? { origin: options.origin } : {}),
                    ...(options.body ? { "content-type": "application/json" } : {}),
                },
            },
            (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
            },
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function cookie(): Promise<string> {
    const url = new URL(link);
    const res = await request(`${url.pathname}${url.search}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/review/r1/files", "the secret leaves the address bar");
    const set = String(res.headers["set-cookie"]);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    return set.split(";")[0]!;
}

const ROUTES: Array<[string, string]> = [
    ["GET", "/"],
    ["GET", "/api/reviews"],
    ["GET", "/api/review"],
    ["GET", "/api/events"],
    ["GET", "/api/passkeys"],
    ["POST", "/api/approve/options"],
    ["POST", "/api/approve/passkey"],
    ["POST", "/api/approve/page"],
    ["POST", "/api/passkeys/options"],
    ["POST", "/api/passkeys"],
    ["DELETE", `/api/passkeys/${"a".repeat(64)}`],
    ["PATCH", "/api/settings"],
    ["POST", "/api/ask"],
    ["POST", "/api/comments"],
];

test("the link is for localhost on this server's own random port, and carries the secret once", () => {
    const url = new URL(link);
    assert.equal(url.hostname, "localhost", "a passkey's relying party id cannot be an IP address");
    assert.equal(Number(url.port), port);
    assert.ok(port > 0);
    assert.match(url.search, /^\?k=[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(server.origins(), [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
});

test("it listens on 127.0.0.1 only", async () => {
    // Reachable by its loopback address; the server was started with that host, so no other interface answers.
    assert.equal((await request("/", { host: `127.0.0.1:${port}` })).status, 403, "reachable, and refused without the cookie");
    const node = (server as unknown as { server: http.Server }).server;
    assert.deepEqual({ address: (node.address() as { address: string }).address, family: (node.address() as { family: string }).family }, { address: "127.0.0.1", family: "IPv4" });
});

test("without the session cookie every route is refused, writes included", async () => {
    for (const [method, route] of ROUTES) {
        const body = method === "POST" || method === "PATCH" ? "{}" : undefined;
        assert.equal((await request(route, { method, body, origin: `http://localhost:${port}` })).status, 403, `${method} ${route}`);
    }
    assert.deepEqual(submitted, []);
    assert.deepEqual(asked, []);
});

test("a wrong secret is refused and sets no cookie", async () => {
    const res = await request("/review/r1/files?k=wrong");
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
});

test("a cookie of the right shape but another secret is refused", async () => {
    assert.equal((await request("/api/reviews", { cookie: "jig_review=wrong" })).status, 403);
    assert.equal((await request("/api/reviews", { cookie: "other=" + new URL(link).searchParams.get("k") })).status, 403, "a different cookie name");
});

test("the printed link gives this browser a cookie; then the API answers", async () => {
    const session = await cookie();
    const res = await request("/api/reviews", { cookie: session });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { reviews: [] });
});

test("a foreign Host is refused even with the cookie (DNS rebinding)", async () => {
    const session = await cookie();
    for (const host of ["attacker.example:80", `attacker.example:${port}`, "localhost", `localhost.attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`, "[::1]:" + port]) {
        assert.equal((await request("/api/reviews", { cookie: session, host })).status, 403, host);
    }
    assert.equal((await request("/api/reviews", { cookie: session, host: `localhost:${port}` })).status, 200);
    assert.equal((await request("/api/reviews", { cookie: session, host: `127.0.0.1:${port}` })).status, 200);
});

test("a foreign Host is refused before the link is even looked at", async () => {
    const url = new URL(link);
    const res = await request(`${url.pathname}${url.search}`, { host: "attacker.example" });
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
});

test("writes need a same-origin page: another site's post is refused, on every write route", async () => {
    const session = await cookie();
    const body = JSON.stringify({ comments: [{ body: "please delete everything" }] });
    for (const [method, route] of ROUTES.filter(([m]) => m !== "GET")) {
        for (const origin of ["https://evil.example", "http://evil.example", `http://localhost:${port + 1}`, `https://localhost:${port}`, "null"]) {
            const sent = method === "POST" || method === "PATCH" ? body : undefined;
            assert.equal((await request(route, { method, cookie: session, origin, body: sent })).status, 403, `${method} ${route} from ${origin}`);
        }
    }
    assert.deepEqual(submitted, []);
    assert.deepEqual(asked, [], "a refused page's request never reached a question in Pi");
    assert.equal((await request("/api/ask", { method: "POST", cookie: session, origin: `http://127.0.0.1:${port}`, body: JSON.stringify({ comments: [{ body: "fix the null check" }] }) })).status, 200);
    assert.equal((await request("/api/ask", { method: "POST", cookie: session, origin: `http://localhost:${port}`, body: JSON.stringify({ comments: [{ body: "and the other one" }] }) })).status, 200);
    assert.deepEqual(submitted, ["fix the null check", "and the other one"]);
});

test("a request body that is not JSON is a 400, and one that is too big is a 413", async () => {
    const session = await cookie();
    const origin = `http://localhost:${port}`;
    assert.equal((await request("/api/ask", { method: "POST", cookie: session, origin, body: "{ no" })).status, 400);
    assert.equal((await request("/api/passkeys", { method: "POST", cookie: session, origin, body: "{ no" })).status, 400);
    // The server may answer 413 and hang up before the client has sent it all: either way the body was not taken.
    const big = JSON.stringify({ comments: [{ body: "x".repeat(1024 * 1024 + 1024) }] });
    const outcome = await request("/api/ask", { method: "POST", cookie: session, origin, body: big }).then(
        (response) => response.status,
        (error: NodeJS.ErrnoException) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? 413 : Promise.reject(error)),
    );
    assert.equal(outcome, 413);
    assert.ok(!submitted.some((body) => body.length > 1000));
});

test("responses are not cached, are not sniffed and send no referrer; the page carries a policy that blocks other origins", async () => {
    const session = await cookie();
    const api = await request("/api/reviews", { cookie: session });
    assert.equal(api.headers["cache-control"], "no-store");
    assert.equal(api.headers["x-content-type-options"], "nosniff");
    assert.equal(api.headers["referrer-policy"], "no-referrer");
    // A file and the event stream are built by their handlers, and carry the same headers.
    const page = await request("/", { cookie: session });
    for (const header of ["x-content-type-options", "referrer-policy", "content-security-policy"]) assert.ok(page.headers[header], `the page has ${header}`);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const policy = String(page.headers["content-security-policy"]);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /form-action 'none'/);
    assert.doesNotMatch(policy, /https?:\/\//, "no other origin is allowed");
});

test("a path that leaves the page's folder is not served", async () => {
    const session = await cookie();
    for (const route of ["/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/package.json", "/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json"]) {
        const res = await request(route, { cookie: session });
        assert.ok(!res.body.includes('"name": "jig"'), `${route} must not reach package.json`);
        assert.ok(!res.body.includes('"hono"'), route);
    }
});

test("a handler that refuses answers with the reason as JSON, and nothing else", async () => {
    const session = await cookie();
    const res = await request("/api/approve/options", { method: "POST", cookie: session, origin: `http://localhost:${port}` });
    assert.equal(res.status, 409, "no review is open: the approval service says so");
    assert.deepEqual(JSON.parse(res.body), { error: "No review is open." });
});

test("stopping closes the port, even with an event stream open", async () => {
    const other = new ReviewServer((server as unknown as { handlers: ConstructorParameters<typeof ReviewServer>[0] }).handlers);
    const otherBase = await other.start();
    const otherPort = Number(new URL(otherBase).port);
    const secretLink = other.authorize(otherBase);
    const url = new URL(secretLink);
    const visit = await new Promise<string>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: otherPort, path: `/?k=${url.searchParams.get("k")}`, headers: { host: `localhost:${otherPort}` } }, (res) => {
            res.resume();
            resolve(String(res.headers["set-cookie"]).split(";")[0]!);
        }).on("error", reject);
    });
    const stream = http.get({ host: "127.0.0.1", port: otherPort, path: "/api/events", headers: { host: `localhost:${otherPort}`, cookie: visit } });
    stream.on("error", () => {});
    await new Promise((resolve) => stream.once("response", resolve));
    other.stop();
    await assert.rejects(
        new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: otherPort, path: "/", agent: false }, resolve).on("error", reject);
        }),
        /ECONNREFUSED|ECONNRESET/,
    );
});

test("the event stream carries the security headers too, and starts with its first event", async () => {
    const session = await cookie();
    const first = await new Promise<{ headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/api/events", agent: false, headers: { host: `localhost:${port}`, cookie: session } }, (res) => {
            res.once("data", (chunk) => {
                req.destroy();
                resolve({ headers: res.headers, text: String(chunk) });
            });
        });
        req.on("error", reject);
    });
    assert.match(String(first.headers["content-type"]), /^text\/event-stream/);
    assert.equal(first.headers["x-content-type-options"], "nosniff");
    assert.match(String(first.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(first.text, /^event: connected/);
});
