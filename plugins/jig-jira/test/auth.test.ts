// The four ways to sign in, and the request itself: what goes on the wire, what never appears in a result or an error, and how
// an answer is read the same way whichever way the request travelled.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "../../jig-core/src/contract.ts";
import { readJira } from "../src/config.ts";
import { createHttp, JiraError, LostReplyError, NotSentError, TIMEOUTS } from "../src/http.ts";
import type { FakeJira } from "./support/fake-jira.ts";
import { ok, setupHarness, SHORT_TIMEOUTS, SITE, TOKEN, TOKEN_REFERENCE } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness("cloud", SHORT_TIMEOUTS);
});
after(() => h.close());
beforeEach(() => h.reset());

const EMAIL = "jane@example.test";
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
const GET_ISSUE = { action: "get", key: "PROJ-1" };

/** A transport that forwards to the fake Jira as a local sign-in proxy would, adding the session it holds. */
function proxyTo(jira: FakeJira, session: Record<string, string>, seen: TransportRequest[] = []): Transport {
    return {
        async request(request, signal) {
            seen.push(request);
            const response = await fetch(request.url.replace(SITE, jira.origin), {
                method: request.method,
                headers: { ...request.headers, ...session },
                body: request.body,
                ...(signal === undefined ? {} : { signal }),
            });
            return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
        },
    };
}

/** A transport that answers with the given response whatever it is asked. */
const answering = (response: TransportResponse): Transport => ({ request: async () => response });


describe("a token for Jira Cloud: email and API token", () => {
    test("every request carries Basic authentication, and the token is resolved once for a call", async () => {
        h.jira.requireHeader = { name: "authorization", value: BASIC };
        ok(await h.call({ ...GET_ISSUE, include: ["Acceptance Criteria"] }));
        assert.ok(h.jira.requests.length >= 2, "more than one request");
        for (const request of h.jira.requests) {
            assert.equal(request.headers.authorization, BASIC);
            assert.equal(request.headers.accept, "application/json");
            assert.equal(request.headers["user-agent"], "jig-jira");
        }
        assert.deepEqual(h.jig.secretCalls, [TOKEN_REFERENCE], "the reference is resolved once, not once per request");
    });

    test("a write sends JSON and the same header", async () => {
        h.jira.requireHeader = { name: "authorization", value: BASIC };
        ok(await h.call({ action: "comment", key: "PROJ-1", text: "hi" }));
        const post = h.jira.requests.find((request) => request.method === "POST");
        assert.equal(post?.headers["content-type"], "application/json");
        assert.equal(post?.headers.authorization, BASIC);
        assert.deepEqual(post?.body, { body: "hi" });
    });

    test("a wrong or expired token is a 401 that says so, without repeating the token", async () => {
        h.jig.secrets.set(TOKEN_REFERENCE, "tok-expired");
        h.jira.requireHeader = { name: "authorization", value: BASIC };
        const result = await h.call(GET_ISSUE);
        assert.equal(result.error?.message, "Jira said 401 to GET /issue/PROJ-1: Unauthorized - Jira did not accept the sign-in; the token may have expired or be wrong");
    });

    test("a secret that cannot be read stops the call before anything is sent", async () => {
        h.jig.secrets.clear();
        const result = await h.call(GET_ISSUE);
        assert.equal(result.error?.message, "could not sign in to Jira: the secret could not be read: no such entry");
        assert.equal(h.jira.requests.length, 0);
    });
});

describe("a personal access token for Data Center", () => {
    test("is sent as a Bearer token", async () => {
        h.configure({ site: SITE, auth: { token: TOKEN_REFERENCE } });
        h.jira.requireHeader = { name: "authorization", value: `Bearer ${TOKEN}` };
        ok(await h.call(GET_ISSUE));
        assert.equal(h.jira.requests[0]?.headers.authorization, `Bearer ${TOKEN}`);
    });
});

describe("a company sign-in service", () => {
    beforeEach(() => {
        h.configure({ site: SITE, auth: { signIn: "company-sso" } });
        h.jig.signIn.set("company-sso", () => ({ "x-sso-session": "sess-4711", Cookie: "sso=abc" }));
        h.jira.requireHeader = { name: "x-sso-session", value: "sess-4711" };
    });

    test("is asked for the headers of every request, by name, with the system and the full address", async () => {
        ok(await h.call({ ...GET_ISSUE, include: ["Acceptance Criteria"] }));
        assert.ok(h.jira.requests.length >= 2);
        assert.equal(h.jig.signInCalls.length, h.jira.requests.length, "the service decides when a token has expired, so it is asked again each time");
        for (const call of h.jig.signInCalls) {
            assert.equal(call.name, "company-sso");
            assert.equal(call.request.system, "jira");
            assert.match(call.request.url, /^https:\/\/jira\.example\.test\/rest\/api\/2\//);
        }
        assert.deepEqual(h.jig.secretCalls, [], "no token is involved");
    });

    test("its headers are sent, and no header of the tool's own authentication is", async () => {
        ok(await h.call(GET_ISSUE));
        const [request] = h.jira.requests;
        assert.equal(request?.headers["x-sso-session"], "sess-4711");
        assert.equal(request?.headers.cookie, "sso=abc");
        assert.equal(request?.headers.authorization, undefined);
    });

    test("an unknown service stops the call before anything is sent", async () => {
        h.configure({ site: SITE, auth: { signIn: "no-such-service" } });
        const result = await h.call(GET_ISSUE);
        assert.equal(result.error?.message, 'could not sign in to Jira: no sign-in service is named "no-such-service"');
        assert.equal(h.jira.requests.length, 0);
    });

    test("a service that fails for the write itself means nothing was sent, and nothing is read afterwards", async () => {
        h.jig.signIn.set("company-sso", (request) => {
            if (request.url.endsWith("/comment")) throw new Error("the session has expired");
            return { "x-sso-session": "sess-4711" };
        });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" }, { ask: false });
        assert.equal(result.error?.message, "jira comment on PROJ-1: could not sign in to Jira: the session has expired. Nothing was sent.");
        assert.equal(h.jira.requests.filter((request) => request.method !== "GET").length, 0);
        assert.equal(h.jira.requests.filter((request) => request.path.endsWith("/comment")).length, 0, "no read of the comments either");
    });
});

describe("a company transport", () => {
    let seen: TransportRequest[];
    beforeEach(() => {
        seen = [];
        h.configure({ site: SITE, auth: { transport: "company-proxy" } });
        h.jig.transports.set("company-proxy", proxyTo(h.jira, { "x-proxy-session": "p-77" }, seen));
        h.jira.requireHeader = { name: "x-proxy-session", value: "p-77" };
    });

    test("every request goes through it, with the method, the full address and the body, and not through fetch's own sign-in", async () => {
        ok(await h.call(GET_ISSUE));
        const [first] = h.jig.transportCalls;
        assert.equal(first?.name, "company-proxy");
        assert.equal(first?.request.system, "jira");
        assert.equal(first?.request.method, "GET");
        assert.match(first?.request.url ?? "", /^https:\/\/jira\.example\.test\/rest\/api\/2\/issue\/PROJ-1\?fields=summary%2Cissuetype%2Cstatus/);
        assert.equal(first?.request.body, undefined);
        // What the proxy forwarded is what the fake Jira saw: only what the proxy added identifies the session.
        assert.equal(h.jira.requests[0]?.headers["x-proxy-session"], "p-77");
    });

    test("a write is sent through it as JSON text, once", async () => {
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi \"there\"\nnew line" });
        assert.equal(ok(result), "Added comment 10100 to PROJ-1.");
        const posts = h.jig.transportCalls.filter((call) => call.request.method === "POST");
        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.request.url, `${SITE}/rest/api/2/issue/PROJ-1/comment`);
        assert.equal(posts[0]?.request.body, JSON.stringify({ body: 'hi "there"\nnew line' }));
        assert.equal(posts[0]?.request.headers?.["Content-Type"], "application/json");
        assert.equal(issueComments().at(-1)?.body, 'hi "there"\nnew line');
    });

    const issueComments = () => (h.jira.issues.get("PROJ-1") as { comments: Array<{ body: string }> }).comments;

    test("no authentication is added: no token, no header, no sign-in service", async () => {
        ok(await h.call({ action: "comment", key: "PROJ-1", text: "hi" }));
        assert.deepEqual(h.jig.secretCalls, []);
        assert.deepEqual(h.jig.signInCalls, []);
        for (const call of h.jig.transportCalls) {
            const names = Object.keys(call.request.headers ?? {}).map((name) => name.toLowerCase());
            assert.deepEqual(names.filter((name) => !["accept", "user-agent", "content-type"].includes(name)), [], "only the plain request headers");
        }
        assert.deepEqual(seen.map((request) => Object.keys(request.headers ?? {}).includes("Authorization")), seen.map(() => false));
    });

    test("the answer is read as an HTTP answer: the status, the headers and the body", async () => {
        const notFound = await h.call({ action: "get", key: "PROJ-99" });
        assert.equal(notFound.error?.message, "Jira said 404 to GET /issue/PROJ-99: Issue does not exist or you do not have permission to see it. - not found, or the account cannot see it");

        h.jig.transports.set("company-proxy", answering({ status: 429, headers: { "Retry-After": "30" }, body: JSON.stringify({ errorMessages: ["Rate limit exceeded"] }) }));
        assert.equal((await h.call(GET_ISSUE)).error?.message, "Jira said 429 to GET /issue/PROJ-1: Rate limit exceeded - Jira is rate limiting; wait before trying again (retry after 30 s)");

        h.jig.transports.set("company-proxy", answering({ status: 302, headers: { Location: "https://sso.example.test/login?state=SECRET" }, body: "" }));
        const redirected = await h.call(GET_ISSUE);
        assert.match(redirected.error?.message ?? "", /^Jira said 302 to GET \/issue\/PROJ-1: Jira redirected the request to sso\.example\.test; it was not followed\./);
        assert.doesNotMatch(redirected.error?.message ?? "", /SECRET/);

        h.jig.transports.set("company-proxy", answering({ status: 200, headers: {}, body: "<html>Please sign in</html>" }));
        assert.equal((await h.call(GET_ISSUE)).error?.message, "Jira answered with something that is not JSON, such as a sign-in page");

        h.jig.transports.set("company-proxy", answering({ status: 502, headers: {}, body: "<html><body><h1>Bad Gateway</h1> the proxy could not reach it </body></html>" }));
        assert.equal((await h.call(GET_ISSUE)).error?.message, "Jira said 502 to GET /issue/PROJ-1: Bad Gateway the proxy could not reach it");
    });

    test("an answer that is empty is no data, and a body over 8 MiB is not read", async () => {
        h.jig.transports.set("company-proxy", answering({ status: 204, headers: {}, body: "" }));
        const result = await h.call({ action: "comments", key: "PROJ-1" });
        assert.equal(result.text, "No comments on PROJ-1.");
        h.jig.transports.set("company-proxy", answering({ status: 200, headers: {}, body: "x".repeat(8 * 1024 * 1024 + 1) }));
        assert.equal((await h.call(GET_ISSUE)).error?.message, "Jira's answer is larger than 8 MiB, so it was not read");
    });

    test("an error from the transport is reported, with the transport's own words and without the request", async () => {
        h.jig.transports.set("company-proxy", { request: async () => { throw new Error("the proxy is not running"); } });
        const result = await h.call({ action: "get", key: "PROJ-1", include: ["Acceptance Criteria"] });
        assert.equal(result.error?.message, 'no answer from Jira (transport "company-proxy" failed: the proxy is not running)');
    });

    test("a name no company plugin registered means nothing was sent", async () => {
        h.configure({ site: SITE, auth: { transport: "missing-proxy" } });
        const read = await h.call(GET_ISSUE);
        assert.equal(read.error?.message, 'no transport named "missing-proxy" (none is registered); a company plugin registers it');
        const write = await h.call({ action: "comment", key: "PROJ-1", text: "hi" }, { ask: false });
        assert.match(write.error?.message ?? "", /no transport named "missing-proxy"/);
        assert.equal(h.jira.requests.length, 0);
    });

    test("a write whose transport fails is not sent again, and one read afterwards says what happened", async () => {
        const forward = proxyTo(h.jira, { "x-proxy-session": "p-77" });
        let down = false;
        h.jig.transports.set("company-proxy", {
            request: async (request, signal) => {
                if (request.method === "POST") {
                    down = true;
                    throw new Error("the connection was reset");
                }
                if (down) throw new Error("the proxy is not running");
                return forward.request(request, signal);
            },
        });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" }, { ask: false });
        const calls = h.jig.transportCalls;
        const first = calls.findIndex((call) => call.request.method === "POST");
        assert.equal(calls.filter((call) => call.request.method === "POST").length, 1, "the write went out once");
        assert.equal(calls.length - first - 1, 1, "and one read was tried after it");
        assert.equal(
            result.error?.message,
            'jira comment on PROJ-1: no answer from Jira (transport "company-proxy" failed: the connection was reset). ' +
                "The write was not sent again. A read afterwards could not settle it: the read after it failed too " +
                '(no answer from Jira (transport "company-proxy" failed: the proxy is not running)). ' +
                "Check the issue before trying again.",
        );
    });

    for (const carriedOut of [true, false]) {
        test(`a transport that is slower than the timeout: the write ${carriedOut ? "was carried out" : "was not"}, it is not sent again, and one read follows`, async () => {
            const forward = proxyTo(h.jira, { "x-proxy-session": "p-77" });
            h.jig.transports.set("company-proxy", {
                // This transport ignores the signal it is given, as another package's code may: the tool's timeout must hold anyway.
                request: async (request, signal) => {
                    if (request.method !== "POST") return forward.request(request, signal);
                    if (carriedOut) await forward.request(request);
                    return new Promise<TransportResponse>(() => {});
                },
            });
            const result = await h.call({ action: "comment", key: "PROJ-1", text: "slow" }, { ask: false });
            const calls = h.jig.transportCalls;
            const first = calls.findIndex((call) => call.request.method === "POST");
            assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
            assert.equal(calls.length - first - 1, 1);
            const message = result.error?.message ?? result.text;
            assert.match(message, new RegExp(`^jira comment on PROJ-1: no answer from Jira \\(timed out after ${SHORT_TIMEOUTS.normal} ms\\)\\. The write was not sent again\\. A read afterwards shows that it (happened|did not happen)`));
            assert.match(message, carriedOut ? /it happened: comment 10100 by you/ : /it did not happen/);
        });
    }

    test("a read that the transport never answers times out, and the same code path keeps the timeouts of fetch", async () => {
        h.jig.transports.set("company-proxy", { request: () => new Promise<TransportResponse>(() => {}) });
        assert.equal((await h.call(GET_ISSUE)).error?.message, `no answer from Jira (timed out after ${SHORT_TIMEOUTS.normal} ms)`);
    });
});

describe("whichever way a request travels", () => {
    test("no token, header value or sign-in header is ever in a result or an error", async () => {
        const secrets = [TOKEN, BASIC, Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64"), "sess-4711", "sso=abc", "p-77", "Bearer "];
        const outputs: string[] = [];
        const run = async (input: Record<string, unknown>, options = {}) => {
            const result = await h.call(input, options);
            outputs.push(result.text, result.error?.message ?? "", result.blocked ?? "", result.preview?.summary ?? "", result.preview?.body ?? "", result.preview?.html ?? "");
        };
        const modes: Array<() => void> = [
            () => h.configure(),
            () => h.configure({ site: SITE, auth: { token: TOKEN_REFERENCE } }),
            () => { h.configure({ site: SITE, auth: { signIn: "company-sso" } }); h.jig.signIn.set("company-sso", () => ({ "x-sso-session": "sess-4711", Cookie: "sso=abc" })); },
            () => { h.configure({ site: SITE, auth: { transport: "company-proxy" } }); h.jig.transports.set("company-proxy", proxyTo(h.jira, { "x-proxy-session": "p-77" })); },
        ];
        for (const mode of modes) {
            h.reset();
            mode();
            await run(GET_ISSUE);
            await run({ action: "get", key: "PROJ-99" });
            await run({ action: "comment", key: "PROJ-1", text: "hi" });
            h.jira.misbehave({ match: (request) => request.method === "POST", status: 500, afterMs: 0 });
            await run({ action: "comment", key: "PROJ-1", text: "again" });
            h.jira.misbehave({ match: () => true, status: 401, apply: false, afterMs: 0 });
            await run(GET_ISSUE);
        }
        assert.ok(outputs.filter((output) => output !== "").length > 20);
        for (const output of outputs) for (const secret of secrets) assert.ok(!output.includes(secret), `"${secret}" is in: ${output.slice(0, 120)}`);
    });
});

describe("only https", () => {
    const settings = (site: string) => {
        const read = readJira({ site, auth: { token: TOKEN_REFERENCE } });
        // The section check refuses http, so the settings of an http address are made by hand: the request refuses it too.
        return read.settings ?? { ...(readJira({ site: "https://jira.example.test", auth: { token: TOKEN_REFERENCE } }).settings as NonNullable<ReturnType<typeof readJira>["settings"]>), site };
    };

    test("a request to an http address is never made, whatever the settings say", async () => {
        let called = false;
        const http = createHttp(settings("http://jira.example.test"), { fetch: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
        await assert.rejects(http.request({ method: "GET", path: "/myself" }), (error: unknown) => error instanceof NotSentError && error.message === "the Jira address must be https");
        assert.equal(called, false);
    });

    test("a redirect is not followed: the request asks for it to be handed back", async () => {
        const inits: RequestInit[] = [];
        const http = createHttp(settings(SITE), {
            fetch: (async (_url: string, init: RequestInit) => {
                inits.push(init);
                return new Response("", { status: 302, headers: { location: "http://plain.example.test/login" } });
            }) as unknown as typeof fetch,
        });
        await assert.rejects(
            http.request({ method: "GET", path: "/myself" }),
            (error: unknown) => error instanceof JiraError && error.status === 302
                && /to plain\.example\.test; it was not followed/.test(error.message),
        );
        assert.equal(inits[0]?.redirect, "manual");
    });

    test("the address is built from the site: a path under it is kept, and the query is encoded", async () => {
        const urls: string[] = [];
        const http = createHttp(settings("https://jira.example.test/jira"), {
            fetch: (async (url: string) => {
                urls.push(url);
                return new Response("{}", { status: 200 });
            }) as unknown as typeof fetch,
        });
        await http.request({ method: "GET", path: "/search", query: { jql: 'project = "A" AND x ~ "b&c"', startAt: 0, skipped: undefined } });
        assert.equal(urls[0], "https://jira.example.test/jira/rest/api/2/search?jql=project+%3D+%22A%22+AND+x+%7E+%22b%26c%22&startAt=0");
    });
});

describe("timeouts", () => {
    test("the defaults are 30 seconds, and 60 for a search", () => {
        assert.deepEqual(TIMEOUTS, { normal: 30_000, search: 60_000 });
    });

    test("a search is given longer than other requests", async () => {
        // Between the two timeouts: in time for a search, too late for anything else.
        const between = (SHORT_TIMEOUTS.normal + SHORT_TIMEOUTS.search) / 2;
        h.jira.misbehave({ match: (request) => request.path === "/search/jql", afterMs: between });
        assert.match(ok(await h.call({ action: "search", jql: "project = PROJ" })), /^2 issues for: project = PROJ/);
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1", afterMs: between });
        assert.equal((await h.call(GET_ISSUE)).error?.message, `no answer from Jira (timed out after ${SHORT_TIMEOUTS.normal} ms)`);
    });

    test("a call that is cancelled stops waiting", async () => {
        const controller = new AbortController();
        const hold = 5 * SHORT_TIMEOUTS.normal;
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1", afterMs: hold, effect: () => controller.abort() });
        const started = Date.now();
        const result = await h.call(GET_ISSUE, { signal: controller.signal });
        assert.equal(result.error?.message, "no answer from Jira (cancelled)");
        assert.ok(Date.now() - started < 2 * SHORT_TIMEOUTS.normal, "it did not wait for the reply");
    });

    test("LostReplyError and NotSentError are told apart", () => {
        assert.ok(new LostReplyError("x") instanceof Error && !(new LostReplyError("x") instanceof NotSentError));
        assert.equal(new JiraError("x", 404).refused, true);
        assert.equal(new JiraError("x", 500).refused, false);
        assert.equal(new JiraError("x", 408).refused, false);
        assert.equal(new JiraError("x", 302).refused, true);
        assert.equal(new JiraError("x", 429).refused, true);
    });
});

