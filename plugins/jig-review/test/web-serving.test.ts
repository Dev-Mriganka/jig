// The server must serve the committed web/dist build, and answer every API route that build calls.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { PACKAGE_ROOT } from "../web/scripts/manifest.ts";
import { openReview, request } from "./support/harness.ts";
import type { ReviewSession } from "./support/harness.ts";

const dist = path.join(PACKAGE_ROOT, "dist");
let session: ReviewSession;

before(async () => {
    session = await openReview();
});
after(async () => {
    await session.close();
});

const get = (route: string) => request(session.base, route, { cookie: session.cookie });

test("the index and every asset it loads are served as they were built", async () => {
    const index = await get("/");
    assert.equal(index.status, 200);
    assert.match(String(index.headers["content-type"]), /^text\/html/);
    assert.equal(index.body, readFileSync(path.join(dist, "index.html"), "utf8"));

    const assets = [...index.body.matchAll(/\b(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
    assert.equal(assets.length, 2, "one script and one stylesheet");
    for (const asset of assets) {
        const served = await get(asset);
        assert.equal(served.status, 200, asset);
        assert.match(String(served.headers["content-type"]), asset.endsWith(".js") ? /^text\/javascript/ : /^text\/css/);
        assert.equal(served.body, readFileSync(path.join(dist, asset), "utf8"), `${asset} is the built file`);
    }
});

test("a deep link into the app gets the index, so a reload keeps the page", async () => {
    for (const route of ["/review/2026-01-01T00-00-00Z/files", "/settings", "/reviews"]) {
        const deep = await get(route);
        assert.equal(deep.status, 200, route);
        assert.equal(deep.body, readFileSync(path.join(dist, "index.html"), "utf8"), route);
    }
});

test("files outside dist are not served", async () => {
    for (const route of ["/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/package.json"]) {
        const res = await get(route);
        assert.ok(!res.body.includes('"name": "jig"'), `${route} must not reach package.json`);
    }
});

test("the page and its assets need the session cookie like everything else", async () => {
    assert.equal((await request(session.base, "/")).status, 403);
    assert.equal((await request(session.base, "/assets/anything.js")).status, 403);
});

test("every API route the built page calls is answered by the server", async () => {
    const script = readdirSync(path.join(dist, "assets")).find((name) => name.endsWith(".js"))!;
    const called = new Set(readFileSync(path.join(dist, "assets", script), "utf8").match(/\/api\/[a-z]+(?:\/[a-z]+)?/g));
    assert.deepEqual(
        [...called].sort(),
        [
            "/api/approve/options",
            "/api/approve/page",
            "/api/approve/passkey",
            "/api/ask",
            "/api/comments",
            "/api/events",
            "/api/passkeys",
            "/api/passkeys/options",
            "/api/reviews",
            "/api/settings",
        ],
        "the page's API surface changed: update the server and this test together",
    );

    const id = String(session.records()[0]!.id);
    const json = (res: Awaited<ReturnType<typeof get>>) => {
        assert.match(String(res.headers["content-type"]), /^application\/json/);
        return JSON.parse(res.body) as Record<string, unknown>;
    };

    const list = await get("/api/reviews");
    assert.equal(list.status, 200);
    assert.equal((json(list).reviews as unknown[]).length, 1);
    const detail = await get(`/api/reviews/${encodeURIComponent(id)}`);
    assert.equal(detail.status, 200);
    assert.equal(json(detail).isActive, true);
    assert.deepEqual(json(await get("/api/settings")), { autoAskReview: false, autoOpenBrowser: false, diffView: "split" });
    assert.equal((await request(session.base, "/api/settings", { method: "PATCH", cookie: session.cookie, body: { diffView: "unified" } })).status, 200);
    assert.equal(json(await get("/api/settings")).diffView, "unified");
    assert.deepEqual(json(await get("/api/passkeys")), { passkeys: [], problems: [] });
    assert.equal((await session.post("/api/ask", { comments: [{ body: "why?", filePath: "orders-api/Service.java", line: 2, side: "new" }] })).status, 200);
    assert.equal((await session.post("/api/comments", { comments: [{ body: "General note" }] })).status, 200);
    assert.equal(session.host.sent.length, 2, "both reached the agent as follow-up messages");
    // Waiting for the agent: the review cannot be approved, whichever way the page asks.
    assert.equal((await session.post("/api/approve/options")).status, 409);
    assert.equal((await session.post("/api/approve/page")).status, 409);

    // The event stream stays open: read its first bytes, then hang up.
    const url = new URL(session.base);
    const first = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: url.port, path: "/api/events", headers: { host: url.host, cookie: session.cookie } }, (res) => {
            assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
            res.once("data", (chunk) => {
                req.destroy();
                resolve(String(chunk));
            });
        });
        req.on("error", reject);
    });
    assert.match(first, /^event: connected/);
});
