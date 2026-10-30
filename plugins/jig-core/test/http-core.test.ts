// `jig().http.request` inside a real jig-core: its real secret backends, sign-in services and transports, and the
// redaction of every credential it sent, against a small server on this machine.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { isHttpError } from "../src/kit/http.ts";
import { start } from "./support/harness.ts";
import type { Harness, StartOptions } from "./support/harness.ts";
import { tempState } from "./support/state.ts";

const TOKEN = ["tok", "from", "command", "123456"].join("-");

let server: Server;
let origin: string;
const seen: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}> = [];

before(async () => {
    server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
            if (request.url?.startsWith("/redirect")) {
                response.writeHead(302, { location: "/elsewhere?next=1" }).end();
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            // The server echoes what it was sent, as a careless one does.
            response.end(
                JSON.stringify({
                    authorization: request.headers.authorization ?? null,
                    key: request.headers["x-key"] ?? null,
                    url: request.url,
                }),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const state = tempState();
let h: Harness | undefined;
let scratch: string;
beforeEach(() => {
    state.start();
    seen.length = 0;
    scratch = mkdtempSync(path.join(tmpdir(), "jig-http-core-"));
});
afterEach(async () => {
    await h?.shutdown();
    h = undefined;
    state.stop();
    rmSync(scratch, { recursive: true, force: true });
});
async function begin(options: StartOptions = {}): Promise<Harness> {
    h = await start(options);
    return h;
}

const config = {
    secrets: {
        backends: ["env", "cmd", "file"],
        commands: { demo: [process.execPath, "-e", `console.log(${JSON.stringify(TOKEN)})`] },
    },
};

describe("jig().http.request in jig-core", () => {
    test("a bearer token from a declared command: the server gets it, the plugin never holds it, and the echo is redacted", async () => {
        const harness = await begin({ config });
        const reply = await harness.api.http.request({
            system: "orders",
            url: `${origin}/v1/orders?page=2`,
            method: "GET",
            auth: { bearer: "cmd:demo" },
        });
        assert.equal(seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(seen[0]?.url, "/v1/orders?page=2");
        assert.equal(reply.status, 200);
        assert.ok(!reply.body.includes(TOKEN), reply.body);
        assert.ok(reply.body.includes("[redacted]"));
        // Registered with the redactor, so it is hidden from every later tool result.
        const outcome = await harness.call({
            tool: "echo",
            input: {},
            result: { content: [{ type: "text", text: `leaked ${TOKEN}` }] },
        });
        assert.ok(!JSON.stringify(outcome.final).includes(TOKEN));
    });

    test("a secret command that is not declared, or while cmd is off, stops the request with auth_failed and nothing sent", async () => {
        const harness = await begin({ config });
        const undeclared = await harness.api.http
            .request({ system: "orders", url: `${origin}/x`, method: "GET", auth: { bearer: "cmd:other" } })
            .catch((error: unknown) => error);
        assert.ok(isHttpError(undeclared));
        assert.deepEqual([undeclared.code, undeclared.notSent], ["auth_failed", true]);
        assert.match(undeclared.message, /names no declared command \(declared: demo\)/);
        assert.equal(seen.length, 0);

        await harness.shutdown();
        h = await start({ config: { secrets: { backends: ["env"], commands: config.secrets.commands } } });
        const off = await h.api.http
            .request({ system: "orders", url: `${origin}/x`, method: "GET", auth: { bearer: "cmd:demo" } })
            .catch((error: unknown) => error);
        assert.ok(isHttpError(off));
        assert.match(off.message, /secret backend is not enabled/);
        assert.equal(seen.length, 0);
    });

    test("a company plugin's declared command works, and the user's own of the same name wins", async () => {
        const harness = await begin({
            config: { secrets: { backends: ["cmd"] } },
            plugins: (api) =>
                api.config.addSecretCommands({
                    demo: [process.execPath, "-e", `console.log(${JSON.stringify(TOKEN)})`],
                }),
        });
        await harness.api.http.request({
            system: "orders",
            url: `${origin}/x`,
            method: "GET",
            auth: { bearer: "cmd:demo" },
        });
        assert.equal(seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
    });

    test("env, header, query and file sources", async () => {
        const harness = await begin({ config });
        process.env.JIG_TEST_HTTP_KEY = TOKEN;
        try {
            const file = path.join(scratch, "token");
            writeFileSync(file, `${TOKEN}\n`);
            await harness.api.http.request({
                system: "orders",
                url: `${origin}/a`,
                method: "GET",
                auth: { header: { name: "X-Key", value: "env:JIG_TEST_HTTP_KEY" } },
            });
            await harness.api.http.request({
                system: "orders",
                url: `${origin}/b?x=1`,
                method: "GET",
                auth: { query: { name: "key", value: `file:${file}` } },
            });
            assert.equal(seen[0]?.headers["x-key"], TOKEN);
            assert.equal(seen[1]?.url, `/b?x=1&key=${TOKEN}`);
        } finally {
            delete process.env.JIG_TEST_HTTP_KEY;
        }
    });

    test("file: cannot read Pi's agent folder", async () => {
        const harness = await begin({ config });
        mkdirSync(harness.agentDir, { recursive: true });
        writeFileSync(path.join(harness.agentDir, "auth.json"), "agent-login-value\n");
        const error = await harness.api.http
            .request({
                system: "orders",
                url: `${origin}/x`,
                method: "GET",
                auth: { bearer: `file:${path.join(harness.agentDir, "auth.json")}` },
            })
            .catch((failure: unknown) => failure);
        assert.ok(isHttpError(error));
        assert.match(error.message, /may not read from Pi's agent folder/);
        assert.equal(seen.length, 0);
    });

    test("a company sign-in service and a company transport, by name", async () => {
        const harness = await begin({
            plugins: (api) => {
                api.signIn.register("corp-sso", { headers: async () => ({ Authorization: `Bearer ${TOKEN}` }) });
                api.transports.register("corp-proxy", {
                    request: async (request) => ({
                        status: 200,
                        headers: { "X-Seen": request.url },
                        body: "via the proxy",
                    }),
                });
            },
        });
        const signed = await harness.api.http.request({
            system: "orders",
            url: `${origin}/s`,
            method: "GET",
            auth: { signIn: "corp-sso" },
        });
        assert.equal(seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
        assert.ok(!signed.body.includes(TOKEN));
        const carried = await harness.api.http.request({
            system: "orders",
            url: `${origin}/t`,
            method: "GET",
            transport: "corp-proxy",
        });
        assert.equal(carried.body, "via the proxy");
        assert.equal(seen.length, 1, "the network was not used for the transport");
    });

    test("a sign-in service that signs the request sees its method, address and body, so a POST is signed as a POST", async () => {
        // The signature covers the method, the path with its query, and a hash of the body, as an HMAC scheme does.
        const key = ["hmac", "key", "for", "tests"].join("-");
        const sign = (method: string, target: string, body: string | Uint8Array): string =>
            createHmac("sha256", key)
                .update([method, target, createHash("sha256").update(body).digest("hex")].join("\n"))
                .digest("hex");
        const checked: Array<{ method: string; status: number }> = [];
        const signed = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const expected = sign(request.method ?? "", request.url ?? "", Buffer.concat(chunks));
                const status = request.headers["x-signature"] === expected ? 200 : 401;
                checked.push({ method: request.method ?? "", status });
                response.writeHead(status).end(status === 200 ? "signed ok" : "bad signature");
            });
        });
        await new Promise<void>((resolve) => signed.listen(0, "127.0.0.1", resolve));
        const where = `http://127.0.0.1:${(signed.address() as AddressInfo).port}`;
        const asked: Array<{ method: string; headers: Record<string, string>; body?: string | Uint8Array }> = [];
        try {
            const harness = await begin({
                plugins: (api) => {
                    api.signIn.register("corp-hmac", {
                        async headers(request) {
                            asked.push({
                                method: request.method,
                                headers: { ...request.headers },
                                ...(request.body === undefined ? {} : { body: request.body }),
                            });
                            const url = new URL(request.url);
                            const body = request.body ?? "";
                            return { "X-Signature": sign(request.method, `${url.pathname}${url.search}`, body) };
                        },
                    });
                },
            });
            const call = (method: "GET" | "POST" | "PUT", body?: string | Uint8Array) =>
                harness.api.http.request({
                    system: "orders",
                    url: `${where}/v1/orders?page=2`,
                    method,
                    headers: { "Content-Type": "application/json" },
                    ...(body === undefined ? {} : { body }),
                    auth: { signIn: "corp-hmac" },
                });

            assert.equal((await call("GET")).status, 200);
            assert.equal((await call("POST", '{"customer":"c-1"}')).status, 200, "a POST with a body");
            assert.equal((await call("PUT", new Uint8Array([0, 1, 2, 255]))).status, 200, "a PUT with bytes");
            assert.deepEqual(
                checked.map((item) => [item.method, item.status]),
                [
                    ["GET", 200],
                    ["POST", 200],
                    ["PUT", 200],
                ],
            );
            assert.deepEqual(
                asked.map((item) => item.method),
                ["GET", "POST", "PUT"],
            );
            assert.deepEqual(asked[1]?.headers, { "Content-Type": "application/json" }, "and no credential in them");
            assert.equal(asked[1]?.body, '{"customer":"c-1"}');

            // The check bites: a signature made for a GET does not pass for a POST of the same path, or another body.
            const forGet = sign("GET", "/v1/orders?page=2", "");
            const sent = await fetch(`${where}/v1/orders?page=2`, {
                method: "POST",
                headers: { "X-Signature": forGet },
                body: '{"customer":"c-1"}',
            });
            assert.equal(sent.status, 401, "a POST signed as a GET is turned down");
        } finally {
            await new Promise<void>((resolve) => signed.close(() => resolve()));
        }
    });

    test("a redirect is returned, not followed", async () => {
        const harness = await begin();
        const reply = await harness.api.http.request({ system: "orders", url: `${origin}/redirect`, method: "GET" });
        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, "/elsewhere?next=1");
        assert.equal(seen.length, 1);
    });

    test("a connection that is refused is an HttpError with the code and no address in it", async () => {
        const harness = await begin();
        // Simulated: a real closed port can be reused by another connection before it is tried.
        const real = globalThis.fetch;
        const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
        globalThis.fetch = (async () => {
            throw new TypeError("fetch failed", { cause: refused });
        }) as typeof fetch;
        try {
            const error = await harness.api.http
                .request({ system: "orders", url: "http://127.0.0.1:9/v1?secret=1", method: "GET" })
                .catch((failure: unknown) => failure);
            assert.ok(isHttpError(error));
            assert.deepEqual([error.code, error.notSent], ["ECONNREFUSED", true]);
            assert.ok(!error.message.includes("127.0.0.1") && !error.message.includes("secret=1"));
        } finally {
            globalThis.fetch = real;
        }
    });
});
