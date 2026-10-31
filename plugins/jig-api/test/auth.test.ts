// The five ways to sign in, and what goes on the wire for each: no sign-in, a bearer token, a company sign-in service, a
// company transport, and the OAuth password grant with its token cache. Also what never appears in a result or an error.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "../../jig-core/src/contract.ts";
import { closedPort } from "./support/fake-api.ts";
import type { FakeApi, Recorded } from "./support/fake-api.ts";
import {
    CLIENT_SECRET,
    CLIENT_SECRET_REFERENCE,
    ok,
    PASSWORD,
    PASSWORD_REFERENCE,
    SECRET,
    SECRET_REFERENCE,
    setupHarness,
    USER,
    USER_REFERENCE,
} from "./support/harness.ts";
import type { CallResult, Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

const GET = { method: "GET", path: "/v1/me" };
const POST = { method: "POST", path: "/v1/items", body: { name: "Zed" } };
const last = (server: FakeApi = h.api): Recorded => {
    const request = server.requests.at(-1);
    assert.ok(request, "the server received a request");
    return request;
};
const form = (request: Recorded): Record<string, string> => Object.fromEntries(new URLSearchParams(request.body));
const basic = (pair: string): string => `Basic ${Buffer.from(pair).toString("base64")}`;

/** A transport that forwards to the fake API as a local sign-in proxy would, adding the session it holds. */
function proxy(session: Record<string, string>, seen: TransportRequest[] = []): Transport {
    return {
        async request(request, signal) {
            seen.push(request);
            const response = await fetch(request.url, {
                method: request.method,
                headers: { ...request.headers, ...session },
                ...(request.body === undefined ? {} : { body: request.body }),
                ...(signal === undefined ? {} : { signal }),
            });
            return {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: await response.text(),
            };
        },
    };
}

/** A transport that answers with the given response whatever it is asked. */
const answering = (response: TransportResponse): Transport => ({ request: async () => response });

describe("no sign-in", () => {
    test("the tool adds no authentication, and says what it accepts and who it is", async () => {
        ok(await h.call(GET));
        const request = last();
        assert.equal(request.method, "GET");
        assert.equal(request.target, "/v1/me");
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers.accept, "application/json, text/plain, */*");
        assert.equal(request.headers["user-agent"], "jig-api");
        assert.equal(request.headers["content-type"], undefined, "no body, no content type");
        assert.deepEqual([h.jig.secretCalls, h.jig.signInCalls, h.jig.transportCalls], [[], [], []]);
    });

    test("a body is sent as JSON text, once, with its content type", async () => {
        ok(
            await h.call({
                method: "PUT",
                path: "/v1/items/7?dryRun=true",
                body: { name: "Zed", tags: ["a", "ü"], n: 12345678901234 },
            }),
        );
        const request = last();
        assert.equal(request.method, "PUT");
        assert.equal(request.target, "/v1/items/7?dryRun=true");
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.body, '{"name":"Zed","tags":["a","ü"],"n":12345678901234}');
        assert.equal(h.api.requests.length, 1);
    });

    test("every method is sent as itself", async () => {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
            ok(await h.call({ method, path: "/v1/x" }, { ask: false }));
        assert.deepEqual(
            h.api.requests.map((request) => request.method),
            ["GET", "POST", "PUT", "PATCH", "DELETE"],
        );
    });

    test("the headers the caller gives are sent, and replace the tool's own of the same name", async () => {
        ok(
            await h.call({
                ...POST,
                headers: { "X-Request-Id": "t-1", accept: "text/csv", "Content-Type": "application/merge-patch+json" },
            }),
        );
        const request = last();
        assert.equal(request.headers["x-request-id"], "t-1");
        assert.equal(request.headers.accept, "text/csv");
        assert.equal(request.headers["content-type"], "application/merge-patch+json");
    });

    test("an address with a path and a query is sent as it is", async () => {
        ok(await h.call({ method: "GET", path: "/v2/accounts/1?x=2" }));
        assert.equal(last().target, "/v2/accounts/1?x=2");
    });
});

describe("a bearer token", () => {
    beforeEach(() => h.configure(h.section({ bearer: SECRET_REFERENCE })));

    test("is sent as a Bearer token on a read and on a write", async () => {
        ok(await h.call(GET));
        ok(await h.call(POST));
        assert.deepEqual(
            h.api.requests.map((request) => request.headers.authorization),
            [`Bearer ${SECRET}`, `Bearer ${SECRET}`],
        );
    });

    test("is resolved for every call and kept by none: jig-core owns the secret", async () => {
        ok(await h.call(GET));
        ok(await h.call(GET));
        assert.deepEqual(h.jig.secretCalls, [SECRET_REFERENCE, SECRET_REFERENCE]);
    });

    test("a secret that cannot be read stops the call before anything is sent", async () => {
        h.jig.secrets.clear();
        const result = await h.call(GET);
        assert.equal(
            result.error?.message,
            "api call GET /v1/me: could not sign in (the secret could not be read: no such entry). Nothing was sent.",
        );
        assert.equal(h.api.requests.length, 0);
        const write = await h.call(POST, { ask: false });
        assert.match(write.error?.message ?? "", /Nothing was sent\.$/);
        assert.doesNotMatch(write.error?.message ?? "", /unknown/);
        assert.equal(h.api.requests.length, 0);
    });

    test("a secret with a character a header cannot hold stops the call, and the error does not repeat it", async () => {
        h.jig.secrets.set(SECRET_REFERENCE, "bad-token\r\nX-Injected: 1");
        const result = await h.call(GET);
        assert.equal(
            result.error?.message,
            "api call GET /v1/me: a header holds a character that cannot be sent. Nothing was sent.",
        );
        assert.equal(h.api.requests.length, 0);
    });

    test("a 401 is an answer: the token is not replaced and the call is not sent again", async () => {
        h.api.respond = () => ({ status: 401, body: '{"error":"bad token"}' });
        const result = await h.call(POST, { ask: false });
        assert.match(ok(result), /-> HTTP 401 Unauthorized/);
        assert.equal(h.api.requests.length, 1);
    });
});

describe("a company sign-in service", () => {
    beforeEach(() => {
        h.configure(h.section({ signIn: "company-sso" }));
        h.jig.signIn.set("company-sso", () => ({ "X-Sso-Session": "sess-4711-abcdef", Cookie: "sso=abc-12345678" }));
    });

    test("is asked for the headers of every request, by name, with the system and the full address", async () => {
        ok(await h.call({ method: "GET", path: "/v1/me?x=1" }));
        ok(await h.call(POST, { ask: false }));
        assert.deepEqual(
            h.jig.signInCalls.map(({ name, request }) => ({
                name,
                system: request.system,
                url: request.url,
                method: request.method,
            })),
            [
                { name: "company-sso", system: "api:base", url: `${h.api.origin}/v1/me?x=1`, method: "GET" },
                { name: "company-sso", system: "api:base", url: `${h.api.origin}/v1/items`, method: "POST" },
            ],
            "and the method it will be sent with, so that a service can sign a POST as a POST",
        );
        assert.deepEqual(JSON.parse(String(h.jig.signInCalls[1]?.request.body)), POST.body, "with the body");
        assert.deepEqual(h.jig.secretCalls, [], "no secret is involved");
    });

    test("its headers are sent, and the tool adds no authentication of its own", async () => {
        ok(await h.call({ ...GET, headers: { "X-Request-Id": "t-1" } }));
        const request = last();
        assert.equal(request.headers["x-sso-session"], "sess-4711-abcdef");
        assert.equal(request.headers.cookie, "sso=abc-12345678");
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers["x-request-id"], "t-1");
    });

    test("an async service works, and its headers replace the tool's own of the same name", async () => {
        h.jig.signIn.set("company-sso", async () => ({ Accept: "application/vnd.company+json" }));
        ok(await h.call(GET));
        assert.equal(last().headers.accept, "application/vnd.company+json");
    });

    test("a header the sign-in sets cannot also be given, in any case, and nothing is sent", async () => {
        h.jig.signIn.set("company-sso", () => ({ "X-Sso-Session": "sess-4711-abcdef", "X-Tenant": "acme-corp" }));
        for (const name of ["X-Sso-Session", "x-sso-session", "X-TENANT"]) {
            const result = await h.call({ ...GET, headers: { [name]: "mine" } });
            assert.match(
                result.error?.message ?? "",
                /^api call GET \/v1\/me: header (X-Sso-Session|X-Tenant) is set by the sign-in, so the request cannot have it too\. Nothing was sent\.$/,
            );
        }
        const write = await h.call({ ...POST, headers: { "x-sso-session": "mine" } });
        assert.match(write.error?.message ?? "", /Nothing was sent\.$/);
        assert.equal(h.api.requests.length, 0);
        ok(await h.call({ ...GET, headers: { "X-Other": "fine" } }));
        assert.equal(last().headers["x-other"], "fine");
    });

    test("an unknown service stops the call before anything is sent", async () => {
        h.configure(h.section({ signIn: "no-such-service" }));
        const result = await h.call(GET);
        assert.equal(
            result.error?.message,
            'api call GET /v1/me: could not sign in (no sign-in service is named "no-such-service"). Nothing was sent.',
        );
        assert.equal(h.api.requests.length, 0);
    });

    test("a service that fails stops the call too, for a write as for a read", async () => {
        h.jig.signIn.set("company-sso", () => {
            throw new Error("the session has expired");
        });
        const read = await h.call(GET);
        assert.equal(
            read.error?.message,
            'api call GET /v1/me: could not sign in (sign-in service "company-sso" failed: the session has expired). Nothing was sent.',
        );
        const write = await h.call(POST);
        assert.match(write.error?.message ?? "", /the session has expired\)\. Nothing was sent\.$/);
        assert.equal(h.api.requests.length, 0);
    });
});

describe("a company transport", () => {
    let seen: TransportRequest[];
    beforeEach(() => {
        seen = [];
        h.configure(h.section({ transport: "company-proxy" }));
        h.jig.transports.set("company-proxy", proxy({ "x-proxy-session": "p-77" }, seen));
    });

    test("the whole request goes through it: the system, the method, the full address, the headers and the body", async () => {
        ok(await h.call({ ...POST, path: "/v1/items?x=1", headers: { "X-Trace": "t" } }));
        assert.equal(h.jig.transportCalls.length, 1);
        const [call] = h.jig.transportCalls;
        assert.equal(call?.name, "company-proxy");
        assert.deepEqual(call?.request, {
            system: "api:base",
            method: "POST",
            url: `${h.api.origin}/v1/items?x=1`,
            headers: {
                Accept: "application/json, text/plain, */*",
                "User-Agent": "jig-api",
                "Content-Type": "application/json",
                "X-Trace": "t",
            },
            body: '{"name":"Zed"}',
            maxBytes: 2 * 1024 * 1024,
            timeoutMs: 30_000,
        });
        // What the proxy forwarded is what the API saw: only what the proxy adds identifies the session.
        assert.equal(last().headers["x-proxy-session"], "p-77");
        assert.equal(last().body, '{"name":"Zed"}');
    });

    test("a read has no body in the request it sends", async () => {
        ok(await h.call(GET));
        assert.equal("body" in (h.jig.transportCalls[0]?.request ?? {}), false);
    });

    test("no authentication is added: no secret, no sign-in service, no header", async () => {
        ok(await h.call(POST));
        assert.deepEqual([h.jig.secretCalls, h.jig.signInCalls], [[], []]);
        const names = Object.keys(h.jig.transportCalls[0]?.request.headers ?? {}).map((name) => name.toLowerCase());
        assert.deepEqual(
            names.filter((name) => !["accept", "user-agent", "content-type"].includes(name)),
            [],
        );
    });

    test("the answer is read as an HTTP answer: the status, the headers and the body", async () => {
        h.jig.transports.set(
            "company-proxy",
            answering({
                status: 201,
                headers: { "Content-Type": "application/json", "X-Request-Id": "r-1", "Set-Cookie": "a=b" },
                body: '{"id":7}',
            }),
        );
        const text = ok(await h.call(POST));
        assert.match(text, /^POST .* -> HTTP 201 Created\n/);
        assert.match(text, /\ncontent-type: application\/json\nx-request-id: r-1\n\n\{\n {2}"id": 7\n\}$/);
        assert.doesNotMatch(text, /set-cookie|a=b/i);
        assert.equal(h.api.requests.length, 0, "the tool did not call the network itself");
    });

    test("a non-2xx answer is a result, and a redirect is not followed", async () => {
        h.jig.transports.set("company-proxy", answering({ status: 404, headers: {}, body: '{"error":"not found"}' }));
        assert.match(ok(await h.call(GET)), /-> HTTP 404 Not Found[\s\S]*"error": "not found"/);
        h.jig.transports.set(
            "company-proxy",
            answering({ status: 302, headers: { Location: "https://sso.example.test/login" }, body: "" }),
        );
        const redirected = ok(await h.call(GET));
        assert.match(redirected, /-> HTTP 302 Found/);
        assert.match(redirected, /\nlocation: https:\/\/sso\.example\.test\/login\n/);
        assert.equal(h.jig.transportCalls.length, 2, "one request each, nothing followed");
    });

    test("an error from the transport is reported in its own words, and says the outcome is unknown for a write", async () => {
        h.jig.transports.set("company-proxy", {
            request: async () => {
                throw new Error("the proxy is not running");
            },
        });
        const read = await h.call(GET);
        assert.equal(
            read.error?.message,
            'api call GET /v1/me: no answer (transport "company-proxy" failed: the proxy is not running). A GET changes nothing, so it can be sent again.',
        );
        const write = await h.call(POST);
        assert.equal(
            write.error?.message,
            'api call POST /v1/items: no answer (transport "company-proxy" failed: the proxy is not running). ' +
                "The outcome is unknown: the server may have carried it out. It was not sent again. Check with a GET before trying again.",
        );
        assert.equal(h.jig.transportCalls.length, 2, "never sent again");
    });

    test("a name no company plugin registered means nothing was sent", async () => {
        h.configure(h.section({ transport: "missing-proxy" }));
        const result = await h.call(POST);
        assert.equal(
            result.error?.message,
            'api call POST /v1/items: no transport named "missing-proxy" (none is registered); a company plugin registers it. Nothing was sent.',
        );
    });

    test("an answer that is larger than the limit is cut", async () => {
        h.jig.transports.set(
            "company-proxy",
            answering({ status: 200, headers: {}, body: "x".repeat(2 * 1024 * 1024 + 500) }),
        );
        const text = ok(await h.call(GET));
        assert.match(text, /\[the answer was cut at 2097152 bytes\]$/);
    });
});

describe("the OAuth password grant", () => {
    beforeEach(() => h.configure(h.section({ oauthPassword: h.oauth() })));

    test("signs in with a form post, with Basic client credentials, and sends the access token as a Bearer token", async () => {
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 1);
        const login = last(h.auth);
        assert.equal(login.method, "POST");
        assert.equal(login.path, "/oauth/token");
        assert.equal(login.headers["content-type"], "application/x-www-form-urlencoded");
        assert.equal(login.headers.accept, "application/json");
        assert.equal(login.headers.authorization, basic(`portal:${CLIENT_SECRET}`));
        assert.deepEqual(form(login), {
            grant_type: "password",
            username: USER,
            password: PASSWORD,
            client_id: "portal",
        });
        assert.equal(last().headers.authorization, `Bearer ${h.issued[0]}`);
        assert.deepEqual(
            h.jig.secretCalls.sort(),
            [CLIENT_SECRET_REFERENCE, PASSWORD_REFERENCE, USER_REFERENCE].sort(),
        );
    });

    test("a client without a secret sends only its id, in the form, and no Basic header", async () => {
        const { clientSecret: _none, ...open } = h.oauth();
        h.configure(h.section({ oauthPassword: open }));
        ok(await h.call(GET));
        const login = last(h.auth);
        assert.equal(login.headers.authorization, undefined);
        assert.equal(form(login).client_id, "portal");
        assert.ok(!h.jig.secretCalls.includes(CLIENT_SECRET_REFERENCE));
    });

    test("a scope is sent, and the id and secret are form-encoded before they are joined", async () => {
        h.configure(h.section({ oauthPassword: h.oauth({ scope: "read write", clientId: "my portal" }) }));
        h.jig.secrets.set(CLIENT_SECRET_REFERENCE, "se cret&=%");
        ok(await h.call(GET));
        const login = last(h.auth);
        assert.equal(form(login).scope, "read write");
        assert.equal(login.headers.authorization, basic("my+portal:se+cret%26%3D%25"));
    });

    test("the token is kept: later calls reuse it and do not resolve the secrets again", async () => {
        ok(await h.call(GET));
        ok(await h.call(POST));
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 1);
        assert.equal(h.jig.secretCalls.length, 3, "the three references, once");
        assert.deepEqual(
            h.api.requests.map((request) => request.headers.authorization),
            Array(3).fill(`Bearer ${h.issued[0]}`),
        );
    });

    test("the token is replaced 60 seconds before it expires, and not before", async () => {
        ok(await h.call(GET));
        h.clock.now += 3_539_999;
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 1, "one second short of the replacement time");
        h.clock.now += 1;
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 2, "at the replacement time");
        assert.deepEqual(
            h.api.requests.map((request) => request.headers.authorization),
            [h.issued[0], h.issued[0], h.issued[1]].map((token) => `Bearer ${token}`),
        );
    });

    test("a token that lives 60 seconds or less is never reused, and one that lives a little longer is reused a little", async () => {
        h.auth.respond = () => ({
            body: JSON.stringify({ access_token: `short-lived-${h.auth.requests.length}`, expires_in: 60 }),
        });
        ok(await h.call(GET));
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 2);
        h.auth.respond = () => ({
            body: JSON.stringify({ access_token: `longer-${h.auth.requests.length}`, expires_in: 62 }),
        });
        ok(await h.call(GET));
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 3, "kept for two seconds");
        h.clock.now += 2_000;
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 4);
    });

    test("expires_in may be text; without one, or with nonsense, the token is kept until a 401 says otherwise", async () => {
        h.auth.respond = () => ({
            body: JSON.stringify({ access_token: `text-${h.auth.requests.length}`, expires_in: "3600" }),
        });
        ok(await h.call(GET));
        h.clock.now += 3_540_000;
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 2, "text 3600 is 3600 seconds");

        for (const expires of [undefined, "soon", -5, 0, null, {}]) {
            h.reset();
            h.configure(h.section({ oauthPassword: h.oauth() }));
            h.auth.respond = () => ({
                body: JSON.stringify({
                    access_token: `open-ended-${h.auth.requests.length}`,
                    ...(expires === undefined ? {} : { expires_in: expires }),
                }),
            });
            ok(await h.call(GET));
            h.clock.now += 10 * 365 * 24 * 3600 * 1000;
            ok(await h.call(GET));
            assert.equal(h.auth.requests.length, 1, `expires_in ${JSON.stringify(expires)}`);
        }
    });

    for (const write of [false, true]) {
        test(`a 401 for a kept token gets one new token and one repeat of the call${write ? ", a write too, because it was turned down before it ran" : ""}`, async () => {
            const call = write ? POST : GET;
            ok(await h.call(call, { ask: false }));
            const stale = h.issued[0];
            h.api.respond = (request) =>
                request.headers.authorization === `Bearer ${stale}`
                    ? { status: 401, body: '{"error":"expired"}' }
                    : { status: 200, body: '{"ok":true}' };
            const text = ok(await h.call(call, { ask: false }));
            assert.match(text, /-> HTTP 200 OK/);
            assert.doesNotMatch(text, /newly issued/);
            assert.equal(h.auth.requests.length, 2, "one new login");
            assert.deepEqual(
                h.api.requests.map((request) => request.headers.authorization),
                [stale, stale, h.issued[1]].map((token) => `Bearer ${token}`),
            );
            if (write)
                assert.deepEqual(
                    h.api.requests.map((request) => request.body),
                    Array(3).fill('{"name":"Zed"}'),
                );
            ok(await h.call(call, { ask: false }));
            assert.equal(h.auth.requests.length, 2, "the new token is kept");
        });
    }

    test("a 401 for a token that was just issued is the answer, with a note, and the call is not repeated", async () => {
        h.api.respond = () => ({ status: 401, body: '{"error":"no access"}' });
        const text = ok(await h.call(POST, { ask: false }));
        assert.match(text, /-> HTTP 401 Unauthorized/);
        assert.match(text, /\nThe server rejected a newly issued token: the account may lack access to this path\.\n/);
        assert.match(text, /"error": "no access"/);
        assert.equal(h.auth.requests.length, 1);
        assert.equal(h.api.requests.length, 1);
    });

    test("a 401 that stays after the one new token is the answer: no third try, no loop", async () => {
        ok(await h.call(GET));
        h.api.respond = () => ({ status: 401, body: "{}" });
        const text = ok(await h.call(GET));
        assert.match(text, /-> HTTP 401/);
        assert.match(text, /newly issued token/);
        assert.equal(h.auth.requests.length, 2);
        assert.equal(h.api.requests.length, 1 + 2);
    });

    test("only a 401 replaces a token: a 403 or a 500 does not", async () => {
        ok(await h.call(GET));
        for (const status of [403, 500, 404]) {
            h.api.respond = () => ({ status, body: "{}" });
            ok(await h.call(GET));
        }
        assert.equal(h.auth.requests.length, 1);
    });

    test("each collection and environment has its own token, and other sign-in settings need another token", async () => {
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 1);
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 1, "the same sign-in reuses the token");
        // Another environment of the same collection signs in again.
        const staging = h.section({ oauthPassword: h.oauth() });
        const other = JSON.parse(JSON.stringify(staging)) as Record<string, unknown>;
        const files = (staging.collections as { base: { environments: { Staging: string } } }).base.environments;
        (other.collections as { base: { environments: Record<string, string> } }).base.environments.Qa = files.Staging;
        (other.environments as Record<string, unknown>).Qa = "staging";
        h.configure(other);
        ok(await h.call({ ...GET, environment: "Qa" }));
        assert.equal(h.auth.requests.length, 2, "another environment has its own token");
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 2, "and the first one still has its");
        h.configure(h.section({ oauthPassword: h.oauth({ clientId: "another-client" }) }));
        ok(await h.call(GET));
        assert.equal(h.auth.requests.length, 3, "the settings changed");
        assert.equal(form(last(h.auth)).client_id, "another-client");
    });

    test("a failed sign-in keeps no token, so the next call tries again", async () => {
        h.auth.respond = () => ({ status: 503, body: "down" });
        const failed = await h.call(GET);
        assert.match(failed.error?.message ?? "", /could not sign in/);
        h.auth.respond = () => ({ body: JSON.stringify({ access_token: "recovered-token-1", expires_in: 3600 }) });
        ok(await h.call(GET));
        assert.equal(last().headers.authorization, "Bearer recovered-token-1");
    });
});

describe("when the OAuth sign-in fails", () => {
    beforeEach(() => h.configure(h.section({ oauthPassword: h.oauth() })));
    const failure = (result: CallResult): string => {
        assert.ok(result.error, `expected a failure, got: ${result.text}`);
        assert.equal(h.api.requests.length, 0, "nothing was sent to the API");
        return result.error.message;
    };

    test("a refusal is one line, with the standard error code and none of the endpoint's own words", async () => {
        h.auth.respond = () => ({
            status: 401,
            body: JSON.stringify({ error: "invalid_grant", error_description: `${USER} ${PASSWORD} is wrong` }),
        });
        const message = failure(await h.call(POST));
        assert.equal(
            message,
            "api call POST /v1/items: could not sign in (the token endpoint answered HTTP 401, invalid_grant). Nothing was sent.",
        );
        for (const secret of [USER, PASSWORD, CLIENT_SECRET]) assert.ok(!message.includes(secret));
    });

    test("an error code that is not in the standard is not repeated", async () => {
        h.auth.respond = () => ({ status: 400, body: JSON.stringify({ error: PASSWORD }) });
        assert.equal(
            failure(await h.call(GET)),
            "api call GET /v1/me: could not sign in (the token endpoint answered HTTP 400). Nothing was sent.",
        );
        h.auth.respond = () => ({ status: 500, body: "<html>oops</html>" });
        assert.equal(
            failure(await h.call(GET)),
            "api call GET /v1/me: could not sign in (the token endpoint answered HTTP 500). Nothing was sent.",
        );
    });

    test("an answer without a usable access token", async () => {
        for (const body of [
            "not json",
            "{}",
            "[]",
            '{"access_token":""}',
            '{"access_token":5}',
            '{"access_token":"has space"}',
            '{"access_token":"a\\nb"}',
            "null",
        ]) {
            h.auth.respond = () => ({ body });
            assert.equal(
                failure(await h.call(GET)),
                "api call GET /v1/me: could not sign in (the token endpoint answered without a usable access_token). Nothing was sent.",
                body,
            );
        }
        h.auth.respond = () => ({ body: JSON.stringify({ access_token: "T".repeat(70_000) }) });
        assert.match(failure(await h.call(GET)), /without a usable access_token/, "the answer is capped at 64 KiB");
    });

    test("a token that is not a bearer token is not sent", async () => {
        h.auth.respond = () => ({ body: JSON.stringify({ access_token: "abcdef123456", token_type: "mac" }) });
        assert.equal(
            failure(await h.call(GET)),
            "api call GET /v1/me: could not sign in (the token endpoint answered with a token that is not a bearer token, and only bearer tokens are sent). Nothing was sent.",
        );
        h.auth.respond = () => ({ body: JSON.stringify({ access_token: "abcdef123456", token_type: "bearer" }) });
        ok(await h.call(GET));
        assert.equal(last().headers.authorization, "Bearer abcdef123456");
    });

    test("secrets that cannot be read stop the sign-in before the endpoint is asked", async () => {
        h.jig.secrets.delete(PASSWORD_REFERENCE);
        assert.equal(
            failure(await h.call(GET)),
            "api call GET /v1/me: could not sign in (the secret could not be read: no such entry). Nothing was sent.",
        );
        assert.equal(h.auth.requests.length, 0);
    });

    test("an endpoint that cannot be reached means nothing went to the API, and the message does not say the outcome is unknown", async () => {
        h.configure(
            h.section({ oauthPassword: h.oauth({ tokenUrl: `http://127.0.0.1:${await closedPort()}/oauth/token` }) }),
        );
        // A refused connection is reported as ECONNREFUSED, or as ECONNRESET where a local forwarder answers for the port.
        const message = failure(await h.call(POST));
        assert.match(
            message,
            /^api call POST \/v1\/items: could not sign in \((could not connect \(ECONNREFUSED\)|the token request got no answer: the connection failed \(ECONNRESET\))\)\. Nothing was sent\.$/,
        );
        assert.doesNotMatch(message, /unknown/);
    });
});

describe("what never appears in a result or an error", () => {
    test("a token that the server echoes back is removed, from the headers and from the body, in any of its forms", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        h.auth.respond = () => ({
            body: JSON.stringify({ access_token: "tok/with+odd=chars&more", expires_in: 3600 }),
        });
        h.api.respond = (request) => {
            const token = (request.headers.authorization ?? "").slice("Bearer ".length);
            return {
                headers: { "x-request-id": token },
                body: JSON.stringify({
                    raw: token,
                    header: request.headers.authorization,
                    encoded: encodeURIComponent(token),
                    text: `token=${token}!`,
                }),
            };
        };
        const text = ok(await h.call(GET));
        assert.ok(!text.includes("tok/with+odd=chars&more"), text);
        assert.ok(!text.includes("tok%2Fwith"), text);
        assert.match(text, /\nx-request-id: \[redacted\]\n/);
        assert.match(text, /"header": "Bearer \[redacted\]"/);
        assert.match(text, /"text": "token=\[redacted\]!"/);
    });

    test("the account, its password and the client secret are not in a result, an error or a preview", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        h.api.respond = (request) => ({ body: JSON.stringify({ seen: request.headers }) });
        const outputs: string[] = [];
        const keep = (result: CallResult): void =>
            void outputs.push(
                result.text,
                result.error?.message ?? "",
                result.blocked ?? "",
                result.preview?.summary ?? "",
                result.preview?.body ?? "",
            );
        keep(await h.call(GET));
        keep(await h.call(POST));
        h.auth.respond = () => ({
            status: 401,
            body: JSON.stringify({
                error: "invalid_client",
                error_description: `${USER} ${PASSWORD} ${CLIENT_SECRET}`,
            }),
        });
        h.reset();
        h.configure(h.section({ oauthPassword: h.oauth() }));
        h.auth.respond = () => ({
            status: 401,
            body: JSON.stringify({
                error: "invalid_client",
                error_description: `${USER} ${PASSWORD} ${CLIENT_SECRET}`,
            }),
        });
        keep(await h.call(GET));
        keep(await h.call(POST));
        assert.ok(outputs.filter((output) => output !== "").length >= 6);
        const secrets = [
            USER,
            PASSWORD,
            CLIENT_SECRET,
            Buffer.from(`portal:${CLIENT_SECRET}`).toString("base64"),
            ...h.issued,
        ];
        for (const output of outputs)
            for (const secret of secrets)
                assert.ok(!output.includes(secret), `"${secret}" is in: ${output.slice(0, 160)}`);
    });

    test("whichever way a call signs in, no token or header value is in a result, an error or a preview", async () => {
        const sso = { "X-Sso-Session": "sess-4711-abcdef", Cookie: "sso=abc-12345678" };
        const modes: Array<[string, () => void, string[]]> = [
            ["bearer", () => h.configure(h.section({ bearer: SECRET_REFERENCE })), [SECRET]],
            [
                "signIn",
                () => {
                    h.configure(h.section({ signIn: "company-sso" }));
                    h.jig.signIn.set("company-sso", () => sso);
                },
                Object.values(sso),
            ],
            ["oauth", () => h.configure(h.section({ oauthPassword: h.oauth() })), [USER, PASSWORD, CLIENT_SECRET]],
        ];
        for (const [name, setUp, secrets] of modes) {
            h.reset();
            setUp();
            // A server that repeats everything it was sent, as a debugging endpoint does.
            const echo = (request: Recorded) => ({
                headers: { "x-request-id": request.headers.authorization ?? request.headers["x-sso-session"] ?? "-" },
                body: JSON.stringify({ headers: request.headers, body: request.body }),
            });
            h.api.respond = echo;
            const outputs: string[] = [];
            const keep = (result: CallResult): void =>
                void outputs.push(
                    result.text,
                    result.error?.message ?? "",
                    result.blocked ?? "",
                    result.preview?.summary ?? "",
                    result.preview?.body ?? "",
                );
            keep(await h.call(GET));
            keep(await h.call(POST));
            h.api.respond = () => ({ status: 500, body: "server error" });
            keep(await h.call(POST));
            h.api.respond = () => ({ status: 401, body: "{}" });
            keep(await h.call(GET));
            assert.ok(outputs.filter((output) => output !== "").length >= 8, name);
            const everything = [...secrets, ...h.issued, `Bearer ${SECRET}`];
            for (const output of outputs)
                for (const secret of everything)
                    assert.ok(!output.includes(secret), `${name}: "${secret}" is in: ${output.slice(0, 160)}`);
        }
    });

    test("a value too short to be removed without blanking ordinary words is left to jig-core", async () => {
        h.configure(h.section({ signIn: "company-sso" }));
        h.jig.signIn.set("company-sso", () => ({ "X-Mode": "1" }));
        h.api.respond = () => ({ body: '{"count":1,"page":1}' });
        assert.match(ok(await h.call(GET)), /"count": 1,\n {2}"page": 1/);
    });
});
