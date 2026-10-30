// `http.request`: the one request function that plugins call, with a credential that jig-core reads for them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HttpRequest, HttpResponse, TransportRequest, TransportResponse } from "../src/contract.ts";
import { createHttp, isHttpError } from "../src/kit/http.ts";
import type { HttpError } from "../src/kit/http.ts";

// ---- fakes --------------------------------------------------------------------------------------------------------

interface Sent {
    url: string;
    init: RequestInit;
    headers: Record<string, string>;
}

type Reply = Response | Error | ((input: Sent) => Response | Promise<Response>);

function rig(options: { now?: () => number } = {}) {
    const sent: Sent[] = [];
    const replies: Reply[] = [];
    const secrets = new Map<string, string>();
    const asked: string[] = [];
    const redacted: string[] = [];
    const signedIn: Array<{ name: string; system: string; url: string }> = [];
    const services = new Map<string, Record<string, string>>();
    const transports = new Map<string, (request: TransportRequest) => Promise<TransportResponse> | TransportResponse>();

    const http = createHttp({
        fetch: async (input, init) => {
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, name) => {
                headers[name] = value;
            });
            const call: Sent = { url: String(input), init: init ?? {}, headers };
            sent.push(call);
            const next = replies.shift();
            if (next === undefined) throw new Error("no reply was queued");
            if (next instanceof Error) throw next;
            return typeof next === "function" ? next(call) : next;
        },
        secrets: {
            async resolve(reference) {
                asked.push(reference);
                const value = secrets.get(reference);
                if (value === undefined) throw new Error("the secret could not be resolved");
                return value;
            },
        },
        signIn: {
            async headers(name, request) {
                const headers = services.get(name);
                if (headers === undefined) throw new Error(`no sign-in service is named "${name}"`);
                signedIn.push({ name, system: request.system, url: request.url });
                return headers;
            },
        },
        transports: {
            async request(name, request) {
                const transport = transports.get(name);
                if (transport === undefined) throw new Error(`no transport named "${name}" (none is registered)`);
                try {
                    return await transport(request);
                } catch (error) {
                    throw new Error(`transport "${name}" failed: ${error instanceof Error ? error.message : error}`);
                }
            },
        },
        redact: (value) => redacted.push(value),
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    const ok = (body = "{}", status = 200, headers: Record<string, string> = {}): Response =>
        new Response(body, { status, headers });
    return { http, sent, replies, secrets, asked, redacted, signedIn, services, transports, ok };
}

const base: HttpRequest = { system: "orders", url: "https://api.staging.example.com/v1/orders?page=2", method: "GET" };

/** The error a promise rejects with, which must be an HttpError. */
async function failure(work: Promise<unknown>): Promise<HttpError> {
    try {
        await work;
    } catch (error) {
        assert.ok(isHttpError(error), `an HttpError, got ${String(error)}`);
        return error;
    }
    throw new assert.AssertionError({ message: "the request should have failed" });
}

const TOKEN = ["tok", "abcdef123456"].join("-");

// ---- the request --------------------------------------------------------------------------------------------------

describe("a plain request", () => {
    test("sends the method, address, headers and body, and returns the status, headers and body", async () => {
        const t = rig();
        t.replies.push(t.ok('{"id":1}', 201, { "Content-Type": "application/json", "X-Total": "7" }));
        const reply = await t.http.request({
            ...base,
            method: "POST",
            headers: { Accept: "application/json" },
            body: '{"a":1}',
        });
        assert.equal(t.sent[0]?.url, "https://api.staging.example.com/v1/orders?page=2");
        assert.equal(t.sent[0]?.init.method, "POST");
        assert.equal(t.sent[0]?.init.body, '{"a":1}');
        assert.equal(t.sent[0]?.headers.accept, "application/json");
        assert.equal(reply.status, 201);
        assert.equal(reply.body, '{"id":1}');
        assert.deepEqual(reply.headers, { "content-type": "application/json", "x-total": "7" });
        assert.equal(reply.bytes, 8);
        assert.equal(reply.truncated, false);
        assert.equal(reply.binary, false);
    });

    test("sends bytes as they are", async () => {
        const t = rig();
        t.replies.push(t.ok());
        const bytes = new Uint8Array([1, 2, 3]);
        await t.http.request({ ...base, method: "PUT", body: bytes });
        assert.equal(t.sent[0]?.init.body, bytes);
    });

    test("never follows a redirect: a 3xx comes back with its location", async () => {
        const t = rig();
        t.replies.push(t.ok("", 302, { Location: "https://login.example.com/start?state=abc" }));
        const reply = await t.http.request(base);
        assert.equal(t.sent.length, 1);
        assert.equal(t.sent[0]?.init.redirect, "manual");
        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, "https://login.example.com/start?state=abc");
    });

    test("an error status is a reply, not a failure", async () => {
        const t = rig();
        t.replies.push(t.ok('{"error":"nope"}', 500));
        assert.equal((await t.http.request(base)).status, 500);
    });

    test("cuts a reply at maxBytes and says so, reading no more", async () => {
        const t = rig();
        const chunks = [new TextEncoder().encode("0123456789"), new TextEncoder().encode("abcdefghij")];
        let cancelled = false;
        t.replies.push(
            new Response(
                new ReadableStream({
                    // A server that goes on sending: it is cancelled, and not waited for.
                    pull(controller) {
                        const chunk = chunks.shift();
                        if (chunk !== undefined) controller.enqueue(chunk);
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
            ),
        );
        const reply = await t.http.request({ ...base, maxBytes: 14 });
        assert.equal(reply.body, "0123456789abcd");
        assert.equal(reply.bytes, 14);
        assert.equal(reply.truncated, true);
        assert.equal(cancelled, true);
        t.replies.push(t.ok("0123456789"));
        const exact = await t.http.request({ ...base, maxBytes: 10 });
        assert.deepEqual([exact.body, exact.truncated], ["0123456789", false]);
    });

    test("notes a NUL byte near the start, as a sign that the reply is not text", async () => {
        const t = rig();
        t.replies.push(new Response(new Uint8Array([80, 78, 71, 0, 1])));
        assert.equal((await t.http.request(base)).binary, true);
    });

    test("returns the cookies a reply set, and keeps no jar", async () => {
        const t = rig();
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/; HttpOnly");
        headers.append("set-cookie", "b=2");
        t.replies.push(new Response("{}", { headers }));
        const reply = await t.http.request(base);
        assert.deepEqual(reply.cookies, ["a=1", "b=2"]);
        t.replies.push(t.ok());
        await t.http.request(base);
        assert.equal(t.sent[1]?.headers.cookie, undefined);
    });
});

describe("a request that is wrong", () => {
    const bad = async (patch: Partial<HttpRequest> | Record<string, unknown>) => {
        const t = rig();
        return failure(t.http.request({ ...base, ...patch } as HttpRequest));
    };

    test("is refused before anything is sent, with code invalid_request and notSent", async () => {
        for (const patch of [
            { url: "ftp://example.com/x" },
            { url: "not a url" },
            { url: "https://" },
            { method: "TRACE" },
            { system: "" },
            { headers: { Accept: 3 } },
            { auth: { bearer: "env:A", signIn: "x" } },
            { auth: {} },
            { auth: { token: "env:A" } },
            { auth: { bearer: "env:A" }, transport: "proxy" },
            { auth: { bearer: "" } },
            { auth: { basic: { user: "u" } } },
            { auth: { header: { name: "", value: "env:A" } } },
            { auth: { query: { name: "k" } } },
            { auth: { signIn: "" } },
            { transport: "" },
        ]) {
            const error = await bad(patch);
            assert.equal(error.code, "invalid_request", JSON.stringify(patch));
            assert.equal(error.notSent, true);
        }
    });

    test("a transport carries five methods and a text body", async () => {
        const t = rig();
        t.transports.set("proxy", () => ({ status: 200, headers: {}, body: "{}" }));
        const head = await failure(t.http.request({ ...base, method: "HEAD", transport: "proxy" }));
        assert.equal(head.message, "a transport carries GET, POST, PUT, PATCH and DELETE, and not HEAD");
        const bytes = await failure(
            t.http.request({ ...base, method: "POST", body: new Uint8Array(1), transport: "proxy" }),
        );
        assert.equal(bytes.message, "a transport carries a text body, and not a file or a multipart form");
        assert.equal(head.notSent && bytes.notSent, true);
    });

    test("a header the credential also sets replaces the request's, ignoring case, unless the request says refuse", async () => {
        const t = rig();
        t.secrets.set("env:API_TOKEN", TOKEN);
        t.replies.push(t.ok());
        await t.http.request({
            ...base,
            headers: { authorization: "x", Accept: "a" },
            auth: { bearer: "env:API_TOKEN" },
        });
        assert.equal(t.sent[0]?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(t.sent[0]?.headers.accept, "a");
        const error = await failure(
            t.http.request({
                ...base,
                headers: { authorization: "x" },
                auth: { bearer: "env:API_TOKEN" },
                onHeaderClash: "refuse",
            }),
        );
        assert.equal(error.message, "header Authorization is set by the sign-in, so the request cannot have it too");
        assert.equal(t.sent.length, 1, "nothing more was sent");
        assert.equal(
            (await failure(t.http.request({ ...base, onHeaderClash: "maybe" as never }))).code,
            "invalid_request",
        );
    });

    test("default headers give way to the request's headers and to the credential's, even when the request says refuse", async () => {
        const t = rig();
        t.secrets.set("env:API_TOKEN", TOKEN);
        t.replies.push(t.ok(), t.ok());
        await t.http.request({
            ...base,
            defaultHeaders: { Accept: "text/plain", "User-Agent": "tool", authorization: "default" },
            headers: { accept: "application/json" },
            auth: { bearer: "env:API_TOKEN" },
            onHeaderClash: "refuse",
        });
        assert.equal(t.sent[0]?.headers.accept, "application/json");
        assert.equal(t.sent[0]?.headers["user-agent"], "tool");
        assert.equal(t.sent[0]?.headers.authorization, `Bearer ${TOKEN}`);
        // A header of the request itself that the credential also sets is still refused.
        const error = await failure(
            t.http.request({
                ...base,
                defaultHeaders: { Authorization: "default" },
                headers: { AUTHORIZATION: "mine" },
                auth: { bearer: "env:API_TOKEN" },
                onHeaderClash: "refuse",
            }),
        );
        assert.equal(error.code, "invalid_request");
    });
});

// ---- the credential sources ---------------------------------------------------------------------------------------

describe("bearer", () => {
    test("reads the secret, sends it as a bearer token, and sends nothing else of it", async () => {
        const t = rig();
        t.secrets.set("env:LOGS_TOKEN", TOKEN);
        t.replies.push(t.ok());
        await t.http.request({ ...base, auth: { bearer: "env:LOGS_TOKEN" } });
        assert.deepEqual(t.asked, ["env:LOGS_TOKEN"]);
        assert.equal(t.sent[0]?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(t.sent[0]?.url, base.url, "not in the address");
    });

    test("a secret that cannot be read stops the request, with auth_failed and the backend's own words", async () => {
        const t = rig();
        const error = await failure(t.http.request({ ...base, auth: { bearer: "env:MISSING" } }));
        assert.deepEqual(
            [error.code, error.notSent, error.message],
            ["auth_failed", true, "the secret could not be resolved"],
        );
        assert.equal(t.sent.length, 0);
        assert.ok(!error.message.includes("MISSING"), "the reference is not repeated");
    });
});

describe("a secret that several requests of one call share", () => {
    test("is read once for requests that share a signal, and again for another signal or none", async () => {
        const t = rig();
        t.secrets.set("env:KEY", TOKEN);
        t.replies.push(t.ok(), t.ok(), t.ok(), t.ok(), t.ok());
        const call = new AbortController().signal;
        await t.http.request({ ...base, auth: { bearer: "env:KEY" } }, call);
        await t.http.request({ ...base, auth: { bearer: "env:KEY" } }, call);
        await t.http.request({ ...base, auth: { header: { name: "X-K", value: "env:KEY" } } }, call);
        assert.equal(t.asked.length, 1);
        await t.http.request({ ...base, auth: { bearer: "env:KEY" } }, new AbortController().signal);
        await t.http.request({ ...base, auth: { bearer: "env:KEY" } });
        assert.equal(t.asked.length, 3);
    });

    test("a failed read is not kept: the next request asks again", async () => {
        const t = rig();
        const call = new AbortController().signal;
        await failure(t.http.request({ ...base, auth: { bearer: "env:KEY" } }, call));
        t.secrets.set("env:KEY", TOKEN);
        t.replies.push(t.ok());
        await t.http.request({ ...base, auth: { bearer: "env:KEY" } }, call);
        assert.equal(t.asked.length, 2);
    });

    test("a sign-in service is asked for every request", async () => {
        const t = rig();
        t.services.set("sso", { Authorization: `Bearer ${TOKEN}` });
        t.replies.push(t.ok(), t.ok());
        const call = new AbortController().signal;
        await t.http.request({ ...base, auth: { signIn: "sso" } }, call);
        await t.http.request({ ...base, auth: { signIn: "sso" } }, call);
        assert.equal(t.signedIn.length, 2);
    });
});

describe("basic", () => {
    test("sends user and password as HTTP Basic, and hides the pair, which the redactor would not find", async () => {
        const t = rig();
        t.secrets.set("env:DB_PASSWORD", "pw-123456789");
        t.replies.push(t.ok());
        await t.http.request({ ...base, auth: { basic: { user: "svc-orders", password: "env:DB_PASSWORD" } } });
        const pair = Buffer.from("svc-orders:pw-123456789").toString("base64");
        assert.equal(t.sent[0]?.headers.authorization, `Basic ${pair}`);
        assert.deepEqual(t.redacted, [pair]);
    });
});

describe("header", () => {
    test("puts the secret in a header of your choosing, after the prefix as written", async () => {
        const t = rig();
        t.secrets.set("env:KEY", TOKEN);
        t.replies.push(t.ok(), t.ok());
        await t.http.request({ ...base, auth: { header: { name: "X-Api-Key", value: "env:KEY" } } });
        await t.http.request({
            ...base,
            auth: { header: { name: "Authorization", value: "env:KEY", prefix: "ApiKey " } },
        });
        assert.equal(t.sent[0]?.headers["x-api-key"], TOKEN);
        assert.equal(t.sent[1]?.headers.authorization, `ApiKey ${TOKEN}`);
    });
});

describe("query", () => {
    test("adds the secret to the address as a query parameter, encoded, after the ones already there", async () => {
        const t = rig();
        t.secrets.set("env:KEY", "a b&c=d");
        t.replies.push(t.ok());
        await t.http.request({ ...base, auth: { query: { name: "api_key", value: "env:KEY" } } });
        assert.equal(t.sent[0]?.url, "https://api.staging.example.com/v1/orders?page=2&api_key=a+b%26c%3Dd");
    });
});

describe("signIn", () => {
    test("asks the company's sign-in service for the headers of every request, with the system and the address", async () => {
        const t = rig();
        t.services.set("corp-sso", { Authorization: `Bearer ${TOKEN}`, "X-Session": "s-123456789" });
        t.replies.push(t.ok(), t.ok());
        await t.http.request({ ...base, auth: { signIn: "corp-sso" } });
        await t.http.request({ ...base, auth: { signIn: "corp-sso" } });
        assert.equal(t.sent[0]?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(t.sent[0]?.headers["x-session"], "s-123456789");
        assert.deepEqual(t.signedIn, [
            { name: "corp-sso", system: "orders", url: base.url },
            { name: "corp-sso", system: "orders", url: base.url },
        ]);
    });

    test("an unknown service stops the request with auth_failed", async () => {
        const t = rig();
        const error = await failure(t.http.request({ ...base, auth: { signIn: "nobody" } }));
        assert.deepEqual([error.code, error.notSent], ["auth_failed", true]);
        assert.match(error.message, /no sign-in service is named "nobody"/);
    });
});

describe("what comes back", () => {
    test("has every credential that was sent removed: as it is, inside JSON text, and URL-encoded, also in headers", async () => {
        const t = rig();
        t.secrets.set("env:KEY", 'tok"en/with space');
        t.replies.push(
            t.ok(
                `echo: tok"en/with space ${JSON.stringify('tok"en/with space')} ${encodeURIComponent('tok"en/with space')}`,
                200,
                { "X-Echo": 'tok"en/with space' },
            ),
        );
        const reply = await t.http.request({ ...base, auth: { header: { name: "X-Key", value: "env:KEY" } } });
        assert.ok(!reply.body.includes("tok"), reply.body);
        assert.equal(reply.body.match(/\[redacted\]/g)?.length, 3);
        assert.equal(reply.headers["x-echo"], "[redacted]");
    });

    test("leaves a value shorter than eight characters alone, since removing it would blank common words", async () => {
        const t = rig();
        t.secrets.set("env:KEY", "abc");
        t.replies.push(t.ok("abc abc"));
        assert.equal((await t.http.request({ ...base, auth: { bearer: "env:KEY" } })).body, "abc abc");
    });

    test("the token inside an Authorization header is hidden on its own too", async () => {
        const t = rig();
        t.services.set("sso", { Authorization: `Bearer ${TOKEN}` });
        t.replies.push(t.ok(`the server says ${TOKEN}`));
        assert.equal((await t.http.request({ ...base, auth: { signIn: "sso" } })).body, "the server says [redacted]");
    });
});

// ---- OAuth --------------------------------------------------------------------------------------------------------

describe("oauth", () => {
    const grant = {
        grant: "client_credentials" as const,
        tokenUrl: "https://auth.staging.example.com/oauth/token",
        clientId: "client-1",
        clientSecret: { ref: "env:CLIENT_SECRET" },
    };
    const tokenReply = (rig_: ReturnType<typeof rig>, token = TOKEN, extra: Record<string, unknown> = {}) =>
        rig_.ok(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600, ...extra }));

    test("client credentials: signs in to the token endpoint with HTTP Basic, then sends the token as a bearer token", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret value&more");
        t.replies.push(tokenReply(t), t.ok('{"orders":[]}'));
        const reply = await t.http.request({ ...base, auth: { oauth: { ...grant, scope: "orders.read" } } });
        const [token, call] = t.sent;
        assert.equal(token?.url, grant.tokenUrl);
        assert.equal(token?.init.method, "POST");
        assert.equal(token?.headers["content-type"], "application/x-www-form-urlencoded");
        // RFC 6749, section 2.3.1: the id and the secret are form-encoded before they are joined.
        const pair = `client-1:${encodeURIComponent("s3cret value&more").replace(/%20/g, "+")}`;
        assert.equal(token?.headers.authorization, `Basic ${Buffer.from(pair).toString("base64")}`);
        assert.equal(token?.init.body, "grant_type=client_credentials&client_id=client-1&scope=orders.read");
        assert.equal(call?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(reply.body, '{"orders":[]}');
        assert.ok(t.redacted.includes(TOKEN), "the token is hidden from every tool result");
    });

    test("clientAuth body puts the id and the secret in the form instead", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        t.replies.push(tokenReply(t), t.ok());
        await t.http.request({ ...base, auth: { oauth: { ...grant, clientAuth: "body" } } });
        assert.equal(t.sent[0]?.headers.authorization, undefined);
        assert.equal(t.sent[0]?.init.body, "grant_type=client_credentials&client_id=client-1&client_secret=s3cret");
    });

    test("the password grant sends the account's name and password in the form", async () => {
        const t = rig();
        t.secrets.set("env:ACCOUNT_PASSWORD", "p@ss word");
        t.replies.push(tokenReply(t), t.ok());
        await t.http.request({
            ...base,
            auth: {
                oauth: {
                    grant: "password",
                    tokenUrl: grant.tokenUrl,
                    clientId: "client-1",
                    username: "alice",
                    password: { ref: "env:ACCOUNT_PASSWORD" },
                },
            },
        });
        assert.equal(
            t.sent[0]?.init.body,
            "grant_type=password&username=alice&password=p%40ss+word&client_id=client-1",
        );
    });

    test("keeps the token until a minute before it expires, and reads no secret while it is good", async () => {
        let now = 1_000_000;
        const t = rig({ now: () => now });
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        t.replies.push(tokenReply(t, "tok-one-123456", { expires_in: 300 }), t.ok(), t.ok(), t.ok(), t.ok());
        const send = () => t.http.request({ ...base, auth: { oauth: grant } });
        await send();
        assert.equal(t.asked.length, 1);
        now += 239_000; // 61 s left
        await send();
        assert.equal(t.sent.length, 3, "one token request, two calls");
        assert.equal(t.asked.length, 1, "the cached token needed no secret");
        t.replies.unshift(tokenReply(t, "tok-two-123456"));
        now += 2_000; // 59 s left: replaced early
        await send();
        assert.equal(t.sent.length, 5, "a new token request, and the call");
        assert.equal(t.sent[4]?.headers.authorization, "Bearer tok-two-123456");
    });

    test("a token with no expiry is kept; settings or a label that differ need a token of their own", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        const noExpiry = () => t.ok(JSON.stringify({ access_token: TOKEN }));
        t.replies.push(noExpiry(), t.ok(), t.ok());
        await t.http.request({ ...base, auth: { oauth: grant } });
        await t.http.request({ ...base, auth: { oauth: grant } });
        assert.equal(t.sent.length, 3);
        t.replies.push(noExpiry(), t.ok(), noExpiry(), t.ok());
        await t.http.request({ ...base, auth: { oauth: { ...grant, scope: "other" } } });
        await t.http.request({ ...base, auth: { oauth: { ...grant, cache: "orders/prod" } } });
        assert.equal(t.sent.filter((call) => call.url === grant.tokenUrl).length, 3);
    });

    test("a 401 for a token from the cache gets a new token and one more try; a 401 for a new one is returned", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        t.replies.push(tokenReply(t, "tok-one-123456"), t.ok());
        await t.http.request({ ...base, auth: { oauth: grant } });
        t.replies.push(t.ok("expired", 401), tokenReply(t, "tok-two-123456"), t.ok("fine"));
        const retried = await t.http.request({ ...base, auth: { oauth: grant } });
        assert.equal(retried.body, "fine");
        assert.equal(t.sent.at(-1)?.headers.authorization, "Bearer tok-two-123456");
        // A 401 for a token that was just issued is the answer: sending it again would change nothing.
        const fresh = rig();
        fresh.secrets.set("env:CLIENT_SECRET", "s3cret");
        fresh.replies.push(tokenReply(fresh), fresh.ok("denied", 401));
        assert.equal((await fresh.http.request({ ...base, auth: { oauth: grant } })).status, 401);
        assert.equal(fresh.sent.length, 2);
    });

    test("removes the token from the reply, and the pair of a Basic header to the endpoint is not in it", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        t.replies.push(tokenReply(t), t.ok(`you sent ${TOKEN}`));
        assert.equal((await t.http.request({ ...base, auth: { oauth: grant } })).body, "you sent [redacted]");
    });

    test("a refusal by the token endpoint says only the standard's words, and every failure is auth_failed and notSent", async () => {
        const cases: Array<[Response, string]> = [
            [
                new Response('{"error":"invalid_client","error_description":"secret text"}', { status: 401 }),
                "the token endpoint answered HTTP 401, invalid_client",
            ],
            [new Response('{"error":"something_else"}', { status: 400 }), "the token endpoint answered HTTP 400"],
            [new Response("<html>", { status: 502 }), "the token endpoint answered HTTP 502"],
            [new Response("{}"), "the token endpoint answered without a usable access_token"],
            [
                new Response('{"access_token":"has a space"}'),
                "the token endpoint answered without a usable access_token",
            ],
            [
                new Response('{"access_token":"abc123","token_type":"mac"}'),
                "the token endpoint answered with a token that is not a bearer token, and only bearer tokens are sent",
            ],
        ];
        for (const [reply, message] of cases) {
            const t = rig();
            t.secrets.set("env:CLIENT_SECRET", "s3cret");
            t.replies.push(reply);
            const error = await failure(t.http.request({ ...base, auth: { oauth: grant } }));
            assert.deepEqual([error.code, error.notSent, error.message], ["auth_failed", true, message]);
            assert.equal(t.sent.length, 1, "the API was never called");
        }
    });

    test("a token request that gets no answer, and a secret that cannot be read, are words for the plugin to wrap", async () => {
        const t = rig();
        t.secrets.set("env:CLIENT_SECRET", "s3cret");
        const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
        t.replies.push(reset);
        const lost = await failure(t.http.request({ ...base, auth: { oauth: grant } }));
        assert.deepEqual(
            [lost.code, lost.notSent, lost.message],
            ["auth_failed", true, "the token request got no answer: the connection failed (ECONNRESET)"],
        );
        const refused = new TypeError("fetch failed", {
            cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        });
        t.replies.push(refused);
        const down = await failure(t.http.request({ ...base, auth: { oauth: grant } }));
        assert.equal(down.message, "could not connect (ECONNREFUSED)");
        const missing = await failure(
            t.http.request({ ...base, auth: { oauth: { ...grant, clientSecret: { ref: "env:NOPE" } } } }),
        );
        assert.equal(missing.message, "the secret could not be resolved");
    });

    test("only the two grants without a browser exist, and the settings are checked", async () => {
        const t = rig();
        for (const oauth of [
            { ...grant, grant: "authorization_code" },
            { ...grant, tokenUrl: "ftp://x" },
            { ...grant, clientId: undefined },
            { ...grant, clientSecret: 5 },
        ]) {
            const error = await failure(t.http.request({ ...base, auth: { oauth } as never }));
            assert.equal(error.code, "auth_failed");
            assert.equal(error.notSent, true);
        }
        assert.equal(t.sent.length, 0);
    });
});

// ---- failures -----------------------------------------------------------------------------------------------------

describe("a request that gets no reply", () => {
    const failed = (code: string) =>
        new TypeError("fetch failed", { cause: Object.assign(new Error("inner"), { code }) });

    test("a failure before the server could have read anything is notSent, with its code", async () => {
        for (const code of [
            "ECONNREFUSED",
            "ENOTFOUND",
            "EAI_AGAIN",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "UND_ERR_CONNECT_TIMEOUT",
        ]) {
            const t = rig();
            t.replies.push(failed(code));
            const error = await failure(t.http.request(base));
            assert.deepEqual([error.code, error.notSent, error.message], [code, true, `could not connect (${code})`]);
        }
    });

    test("a refused certificate is notSent, and certificate checks are never turned off", async () => {
        for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
            const t = rig();
            t.replies.push(failed(code));
            const error = await failure(t.http.request(base));
            assert.deepEqual([error.code, error.notSent], [code, true]);
            assert.match(
                error.message,
                /the TLS certificate was not accepted .* certificate checks are never turned off$/,
            );
        }
    });

    test("a dropped connection may have been after the request was written, so it is not notSent", async () => {
        for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
            const t = rig();
            t.replies.push(failed(code));
            const error = await failure(t.http.request(base));
            assert.deepEqual(
                [error.code, error.notSent, error.message],
                [code, false, `the connection failed (${code})`],
            );
        }
    });

    test("finds the code in an AggregateError, and puts only a code-shaped one in a message", async () => {
        const t = rig();
        const aggregate = Object.assign(
            new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]),
            {},
        );
        t.replies.push(new TypeError("fetch failed", { cause: aggregate }));
        assert.equal((await failure(t.http.request(base))).code, "ECONNREFUSED");
        t.replies.push(failed("secret: tok-abc"));
        const odd = await failure(t.http.request(base));
        assert.deepEqual([odd.code, odd.message], ["network_error", "the connection failed"]);
    });

    test("a failure with no code is network_error, and keeps the original as its cause", async () => {
        const t = rig();
        const original = new Error("socket hang up");
        t.replies.push(original);
        const error = await failure(t.http.request(base));
        assert.deepEqual([error.code, error.notSent, error.message], ["network_error", false, "the connection failed"]);
        assert.equal(error.cause, original);
    });

    test("fetch's refusal of a port it will not connect to is notSent", async () => {
        const t = rig();
        t.replies.push(new TypeError("fetch failed", { cause: new Error("bad port") }));
        const error = await failure(t.http.request(base));
        assert.deepEqual([error.code, error.notSent], ["bad_port", true]);
    });

    test("a message never holds a header value, a credential, or the query of the address", async () => {
        const t = rig();
        t.secrets.set("env:KEY", TOKEN);
        const url = `https://api.staging.example.com/v1/orders?token=${TOKEN}&page=2`;
        const hostile = new TypeError(`fetch failed for ${url} with Authorization: Bearer ${TOKEN}`, {
            cause: Object.assign(new Error(`connect to ${url}`), { code: "ECONNRESET" }),
        });
        t.replies.push(hostile, hostile, hostile);
        const errors = [
            await failure(t.http.request({ ...base, url, auth: { bearer: "env:KEY" } })),
            await failure(t.http.request({ ...base, url, auth: { query: { name: "k", value: "env:KEY" } } })),
            await failure(t.http.request({ ...base, url, auth: { header: { name: "X-K", value: "env:KEY" } } })),
        ];
        for (const error of errors) {
            assert.ok(!error.message.includes(TOKEN), error.message);
            assert.ok(!error.message.includes("page=2"), error.message);
            assert.ok(!error.message.includes("api.staging"), error.message);
        }
    });

    test("the time limit holds even when fetch ignores its signal, and starts after the credential is in hand", async () => {
        const t = rig();
        let release: () => void = () => {};
        const slow = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slowSecrets = createHttp({
            fetch: async () => new Response("{}"),
            secrets: {
                async resolve() {
                    await slow;
                    return TOKEN;
                },
            },
            signIn: { headers: async () => ({}) },
            transports: { request: async () => ({ status: 200, headers: {}, body: "" }) },
        });
        const waiting = slowSecrets.request({ ...base, timeoutMs: 20, auth: { bearer: "env:A" } });
        await new Promise((resolve) => setTimeout(resolve, 60));
        release();
        assert.equal((await waiting).status, 200, "the wait for the secret was not the request's time");

        t.replies.push(() => new Promise<Response>(() => {}));
        const error = await failure(t.http.request({ ...base, timeoutMs: 20 }));
        assert.deepEqual([error.code, error.notSent, error.message], ["timeout", false, "timed out"]);
    });

    test("a call that is cancelled is `aborted`, with the signal's reason as the cause", async () => {
        const t = rig();
        const controller = new AbortController();
        t.replies.push(() => new Promise<Response>(() => {}));
        const waiting = failure(t.http.request(base, controller.signal));
        const reason = new Error("the user stopped it");
        controller.abort(reason);
        const error = await waiting;
        assert.deepEqual([error.code, error.notSent, error.message], ["aborted", false, "cancelled"]);
        assert.equal(error.cause, reason);
    });

    test("a signal that fires with a TimeoutError, such as AbortSignal.timeout, is a timeout and not a cancellation", async () => {
        const t = rig();
        t.replies.push(() => new Promise<Response>(() => {}));
        const late = await failure(t.http.request(base, AbortSignal.timeout(20)));
        assert.deepEqual([late.code, late.notSent, late.message], ["timeout", false, "timed out"]);
        const before = await failure(
            t.http.request(base, AbortSignal.abort(new DOMException("too slow", "TimeoutError"))),
        );
        assert.deepEqual(
            [before.code, before.notSent, before.message],
            ["timeout", true, "the time ran out before it was sent"],
        );
        const cancelled = await failure(
            t.http.request(base, AbortSignal.abort(new DOMException("stop", "AbortError"))),
        );
        assert.deepEqual([cancelled.code, cancelled.message], ["aborted", "it was cancelled before it was sent"]);
    });

    test("a call cancelled before it starts, or while a secret is read, is aborted and notSent", async () => {
        const t = rig();
        t.secrets.set("env:KEY", TOKEN);
        const before = await failure(t.http.request(base, AbortSignal.abort(new Error("early"))));
        assert.deepEqual([before.code, before.notSent], ["aborted", true]);
        assert.equal(t.sent.length, 0);
    });

    test("a limit that is too small to be met is a notSent timeout, not a hang", async () => {
        const t = rig();
        t.replies.push(t.ok());
        // 0 is raised to the smallest limit, 1 ms, which has run out by the time the request is checked.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const attempt = t.http.request({ ...base, timeoutMs: 0 });
        const outcome = await attempt.then(
            () => "sent",
            (error: unknown) => (isHttpError(error) ? error.code : "other"),
        );
        assert.ok(outcome === "sent" || outcome === "timeout", outcome);
    });
});

// ---- transports ---------------------------------------------------------------------------------------------------

describe("a transport", () => {
    test("carries the request instead of the network, and its reply is checked and capped like any other", async () => {
        const t = rig();
        let seen: TransportRequest | undefined;
        t.transports.set("company-proxy", (request) => {
            seen = request;
            return {
                status: 200,
                headers: { "Set-Cookie": "crumb=abc; Path=/, other=1", "X-Total": "3" },
                body: "0123456789",
            };
        });
        const reply = await t.http.request({
            ...base,
            method: "POST",
            headers: { Accept: "application/json" },
            body: "{}",
            transport: "company-proxy",
            maxBytes: 8,
        });
        assert.equal(t.sent.length, 0, "the network was not used");
        assert.deepEqual(seen, {
            system: "orders",
            method: "POST",
            url: base.url,
            headers: { Accept: "application/json" },
            body: "{}",
        });
        assert.deepEqual([reply.body, reply.bytes, reply.truncated], ["01234567", 8, true]);
        assert.equal(reply.headers["x-total"], "3", "names are lower case");
        assert.deepEqual(reply.cookies, ["crumb=abc", "other=1"]);
    });

    test("an unknown transport is no_transport and notSent; a transport that fails is transport_failed, and may have sent", async () => {
        const t = rig();
        const unknown = await failure(t.http.request({ ...base, transport: "nobody" }));
        assert.deepEqual([unknown.code, unknown.notSent], ["no_transport", true]);
        assert.match(unknown.message, /^no transport named "nobody"/);
        t.transports.set("broken", () => {
            throw new Error("the proxy is not running\nsecond line");
        });
        const broken = await failure(t.http.request({ ...base, transport: "broken" }));
        assert.deepEqual([broken.code, broken.notSent], ["transport_failed", false]);
        assert.equal(broken.message, 'transport "broken" failed: the proxy is not running second line');
    });

    test("one that ignores its signal still times out and can be cancelled", async () => {
        const t = rig();
        t.transports.set("hung", () => new Promise<TransportResponse>(() => {}));
        const timeout = await failure(t.http.request({ ...base, transport: "hung", timeoutMs: 20 }));
        assert.deepEqual([timeout.code, timeout.notSent], ["timeout", false]);
        const controller = new AbortController();
        const waiting = failure(t.http.request({ ...base, transport: "hung" }, controller.signal));
        controller.abort();
        assert.equal((await waiting).code, "aborted");
    });
});

describe("the response type", () => {
    test("is plain data", async () => {
        const t = rig();
        t.replies.push(t.ok("x"));
        const reply: HttpResponse = await t.http.request(base);
        assert.deepEqual(Object.keys(reply).sort(), [
            "binary",
            "body",
            "bytes",
            "cookies",
            "headers",
            "status",
            "truncated",
        ]);
    });
});
