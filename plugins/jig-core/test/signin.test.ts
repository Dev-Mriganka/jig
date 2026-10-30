// Sign-in services: a company plugin registers them, tools ask for the headers of one request, and the values are hidden
// from every later result like secrets.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig } from "../src/client.ts";
import type { SignInRequest, SignInService } from "../src/contract.ts";
import { jigCore } from "../src/index.ts";
import { createRedactor, REDACTED } from "../src/redact.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePi } from "./support/fake-pi.ts";
import { startWorld } from "./support/session.ts";
import type { World, WorldOptions } from "./support/session.ts";
import { rawRecords, tempState } from "./support/state.ts";

const REQUEST: SignInRequest = { system: "jira", url: "https://jira.example/rest/api", method: "GET", headers: {} };

function make() {
    const redactor = createRedactor();
    return { redactor, signIn: createSignIn({ redactor }) };
}

/** A service that answers with fixed headers and notes what it was asked. */
function service(
    headers: Record<string, string>,
    seen: Array<{ request: SignInRequest; signal?: AbortSignal }> = [],
): SignInService {
    return {
        async headers(request, signal) {
            seen.push({ request, ...(signal === undefined ? {} : { signal }) });
            return headers;
        },
    };
}

describe("asking for headers", () => {
    test("the registered service gets the request and the signal, and its headers come back", async () => {
        const { signIn } = make();
        const seen: Array<{ request: SignInRequest; signal?: AbortSignal }> = [];
        signIn.register("corp", service({ Authorization: "Bearer tok-1f9a77c2", "X-Tenant": "acme-eu" }, seen));
        const controller = new AbortController();
        const headers = await signIn.headers("corp", REQUEST, controller.signal);
        assert.deepEqual(headers, { Authorization: "Bearer tok-1f9a77c2", "X-Tenant": "acme-eu" });
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0]?.request, REQUEST);
        assert.equal(seen[0]?.signal, controller.signal);
    });

    test("every call asks the service again, so a token that expired is a new one", async () => {
        const { signIn } = make();
        let n = 0;
        signIn.register("corp", { headers: async () => ({ Authorization: `Bearer tok-${++n}-aaaaaaaa` }) });
        assert.equal((await signIn.headers("corp", REQUEST)).Authorization, "Bearer tok-1-aaaaaaaa");
        assert.equal((await signIn.headers("corp", REQUEST)).Authorization, "Bearer tok-2-aaaaaaaa");
    });

    test("registering a name again replaces the service", async () => {
        const { signIn } = make();
        signIn.register("corp", service({ "X-Who": "first-service" }));
        signIn.register("corp", service({ "X-Who": "second-service" }));
        assert.deepEqual(await signIn.headers("corp", REQUEST), { "X-Who": "second-service" });
    });

    test("services with different names are independent", async () => {
        const { signIn } = make();
        signIn.register("one", service({ "X-Who": "service-one" }));
        signIn.register("two", service({ "X-Who": "service-two" }));
        assert.equal((await signIn.headers("two", REQUEST))["X-Who"], "service-two");
        assert.equal((await signIn.headers("one", REQUEST))["X-Who"], "service-one");
    });

    test("the headers are a copy that cannot be changed, so a tool cannot alter what the service holds", async () => {
        const { signIn } = make();
        const held = { Authorization: "Bearer tok-77aa11bb" };
        signIn.register("corp", service(held));
        const headers = await signIn.headers("corp", REQUEST);
        assert.notEqual(headers, held);
        assert.throws(() => {
            (headers as Record<string, string>).Authorization = "other";
        }, TypeError);
        assert.equal(held.Authorization, "Bearer tok-77aa11bb");
    });
});

describe("a name nobody registered", () => {
    test("is an error that says so, and lists what is registered", async () => {
        const { signIn } = make();
        signIn.register("corp", service({}));
        signIn.register("other", service({}));
        await assert.rejects(
            signIn.headers("crop", REQUEST),
            /no sign-in service is named "crop": a company plugin registers one with signIn\.register \(registered: corp, other\)/,
        );
    });

    test("says that none are registered when none are", async () => {
        const { signIn } = make();
        await assert.rejects(
            signIn.headers("corp", REQUEST),
            /no sign-in service is named "corp".*\(none are registered\)/,
        );
    });

    test("is a rejection, not a throw, because the caller awaits it", async () => {
        const { signIn } = make();
        let promise: Promise<unknown> | undefined;
        assert.doesNotThrow(() => {
            promise = signIn.headers("corp", REQUEST);
        });
        await assert.rejects(promise as Promise<unknown>);
    });

    test("the name is shown on one line and short, whatever it holds", async () => {
        const { signIn } = make();
        const error = await signIn.headers(`bad\nname${"x".repeat(200)}`, REQUEST).catch((e: unknown) => e as Error);
        assert.ok(!error.message.includes("\n"));
        assert.ok(error.message.length < 300, String(error.message.length));
    });
});

describe("hiding the values", () => {
    test("each header value is removed from text from the moment the headers are returned", async () => {
        const { redactor, signIn } = make();
        signIn.register(
            "corp",
            service({ Authorization: "Bearer tok-4f9a2c7e", Cookie: "SESSION=abc123def456; theme=dark" }),
        );
        assert.equal(
            redactor.text("before: Bearer tok-4f9a2c7e"),
            "before: Bearer tok-4f9a2c7e",
            "nothing is hidden before it is asked for",
        );
        const headers = await signIn.headers("corp", REQUEST);
        assert.equal(
            redactor.text(`sent ${headers.Authorization} and ${headers.Cookie}`),
            `sent ${REDACTED} and ${REDACTED}`,
        );
    });

    test("with the encodings a secret has: base64, URL-encoded and hex", async () => {
        const { redactor, signIn } = make();
        signIn.register("corp", service({ "X-Api-Key": "key/with+chars=9f8e7d" }));
        const value = (await signIn.headers("corp", REQUEST))["X-Api-Key"] as string;
        const bytes = Buffer.from(value);
        const text = `${bytes.toString("base64")} ${encodeURIComponent(value)} ${bytes.toString("hex")}`;
        assert.equal(redactor.text(text), `${REDACTED} ${REDACTED} ${REDACTED}`);
    });

    test("the token of an Authorization header is hidden on its own, because a server may echo it without the scheme", async () => {
        const { redactor, signIn } = make();
        signIn.register(
            "corp",
            service({ Authorization: "Bearer tok-9d2e51aa", "Proxy-Authorization": "Basic dXNlcjpwYXNzd29yZA==" }),
        );
        await signIn.headers("corp", REQUEST);
        assert.equal(redactor.text("invalid token tok-9d2e51aa"), `invalid token ${REDACTED}`);
        assert.equal(redactor.text("proxy said dXNlcjpwYXNzd29yZA=="), `proxy said ${REDACTED}`);
        assert.equal(redactor.text("the word Bearer is not a secret"), "the word Bearer is not a secret");
    });

    test("only an Authorization header is split into scheme and token", async () => {
        const { redactor, signIn } = make();
        signIn.register("corp", service({ "X-User": "Jane Example" }));
        await signIn.headers("corp", REQUEST);
        assert.equal(redactor.text("Jane wrote"), "Jane wrote");
    });

    test("an empty or blank value protects nothing and is not registered", async () => {
        const { redactor, signIn } = make();
        signIn.register("corp", service({ "X-Empty": "", "X-Blank": "  ", Authorization: "Bearer tok-2b7c90ee" }));
        await signIn.headers("corp", REQUEST);
        assert.equal(redactor.text("a b  c"), "a b  c", "spaces are not blanked");
        assert.equal(redactor.count(), 2, "the value and its token");
    });

    test("headers that could not be returned hide nothing", async () => {
        const { redactor, signIn } = make();
        signIn.register("corp", service({ Authorization: "Bearer tok-6e6e6e6e", "X-Bad": 42 as unknown as string }));
        await assert.rejects(signIn.headers("corp", REQUEST));
        assert.equal(redactor.count(), 0);
    });
});

describe("a service that misbehaves", () => {
    test("that throws is an error naming the service and carrying its message", async () => {
        const { signIn } = make();
        signIn.register("corp", {
            headers: async () => {
                throw new Error("the login expired: sign in again");
            },
        });
        await assert.rejects(
            signIn.headers("corp", REQUEST),
            /sign-in service "corp" failed: the login expired: sign in again/,
        );
    });

    test("that throws a string is still an error", async () => {
        const { signIn } = make();
        signIn.register("corp", {
            headers: () => {
                throw "plain text";
            },
        });
        await assert.rejects(signIn.headers("corp", REQUEST), /sign-in service "corp" failed: plain text/);
    });

    test("that returns something other than an object of headers", async () => {
        const { signIn } = make();
        for (const answer of [undefined, null, "Bearer x", ["a"], 42]) {
            signIn.register("corp", { headers: async () => answer as never });
            await assert.rejects(
                signIn.headers("corp", REQUEST),
                /sign-in service "corp" must return an object of headers/,
                String(answer),
            );
        }
    });

    test("whose header value is not a string names the header and never the value", async () => {
        const { signIn } = make();
        signIn.register("corp", service({ "X-Count": 42 as unknown as string, "X-Secret": "tok-should-not-appear-1" }));
        const error = await signIn.headers("corp", REQUEST).catch((e: unknown) => e as Error);
        assert.match(error.message, /header \(X-Count\) whose value is not a string/);
        assert.ok(!error.message.includes("tok-should-not-appear-1") && !error.message.includes("42"));
    });
});

describe("what the caller gives", () => {
    test("register needs a name and a service with a headers function", () => {
        const { signIn } = make();
        assert.throws(() => signIn.register("", service({})), TypeError);
        assert.throws(() => signIn.register(7 as unknown as string, service({})), TypeError);
        assert.throws(() => signIn.register("corp", {} as SignInService), /needs a headers function/);
        assert.throws(() => signIn.register("corp", undefined as unknown as SignInService), TypeError);
    });

    test("the service is told the method, the headers and the body, as a copy it cannot use to change the caller's", async () => {
        const { signIn } = make();
        const seen: Array<{ request: SignInRequest }> = [];
        signIn.register("corp", service({}, seen));
        const headers = { "Content-Type": "application/json" };
        const bytes = new Uint8Array([7, 8, 9]);
        await signIn.headers("corp", { ...REQUEST, method: "POST", headers, body: bytes });
        await signIn.headers("corp", { ...REQUEST, method: "POST", headers, body: '{"a":1}' });
        await signIn.headers("corp", REQUEST);
        const [bytesAsked, textAsked, plainAsked] = seen.map((item) => item.request);
        assert.equal(bytesAsked?.method, "POST");
        assert.deepEqual({ ...bytesAsked?.headers }, headers);
        assert.equal(bytesAsked?.body, bytes);
        assert.equal(textAsked?.body, '{"a":1}');
        assert.ok(!("body" in (plainAsked as object)));
        assert.notEqual(bytesAsked?.headers, headers);
        assert.throws(() => {
            (bytesAsked?.headers as Record<string, string>)["X-Other"] = "changed";
        }, TypeError);
        assert.equal(Object.keys(headers).length, 1);
    });

    test("without a method or the headers a POST would be signed as a GET, so the request is refused", async () => {
        const { signIn } = make();
        const seen: Array<{ request: SignInRequest }> = [];
        signIn.register("corp", service({}, seen));
        const base = { system: "jira", url: "https://x" };
        await assert.rejects(signIn.headers("corp", base as never), /the request needs a method/);
        await assert.rejects(signIn.headers("corp", { ...base, method: "" } as never), /the request needs a method/);
        for (const headers of [undefined, null, "a", ["a"]]) {
            await assert.rejects(
                signIn.headers("corp", { ...base, method: "GET", headers } as never),
                /the request needs its headers/,
                String(headers),
            );
        }
        for (const body of [1, {}, ["a"], null]) {
            await assert.rejects(
                signIn.headers("corp", { ...base, method: "POST", headers: {}, body } as never),
                /the body must be text or bytes/,
                JSON.stringify(body),
            );
        }
        assert.equal(seen.length, 0, "the service was never asked");
    });

    test("the request needs a system and a url", async () => {
        const { signIn } = make();
        signIn.register("corp", service({}));
        for (const request of [
            undefined,
            {},
            { system: "jira" },
            { url: "https://x" },
            { system: "", url: "https://x" },
            { system: 1, url: "https://x" },
        ]) {
            await assert.rejects(
                signIn.headers("corp", request as never),
                /the request needs a system and a url/,
                JSON.stringify(request),
            );
        }
    });
});

// ---- inside a real Pi session ----------------------------------------------------------------------------------------------------------------

describe("in a Pi session", () => {
    const state = tempState();
    beforeEach(() => {
        state.start();
    });

    let world: World | undefined;
    afterEach(async () => {
        await world?.close();
        world = undefined;
        state.stop();
    });
    async function begin(options: WorldOptions = {}): Promise<World> {
        world = await startWorld(options);
        return world;
    }

    test("a header value a tool printed is removed from its own result, and from every later one, with its encodings", async () => {
        const w = await begin();
        jig().signIn.register("corp", service({ Authorization: "Bearer tok-c0ffee-5eed-1234" }));

        const first = await w.call("fake_tool", { env: "local", signIn: "corp" });
        assert.equal(first.isError, false, first.text);
        assert.equal(first.text, `ok headers={"Authorization":"${REDACTED}"}`);
        assert.deepEqual((first.details as { headers: unknown }).headers, { Authorization: REDACTED });
        assert.ok(!first.text.includes("tok-c0ffee"));

        const secret = "Bearer tok-c0ffee-5eed-1234";
        const later = await w.call("fake_tool", {
            env: "local",
            output: `echoed ${secret}, token only tok-c0ffee-5eed-1234, base64 ${Buffer.from(secret).toString("base64")}`,
        });
        assert.equal(later.text, `echoed ${REDACTED}, token only ${REDACTED}, base64 ${REDACTED}`);
        assert.ok(!rawRecords(state.dir).includes("tok-c0ffee"));
    });

    test("a name nobody registered gives the tool a clear error, which the model reads", async () => {
        const w = await begin();
        jig().signIn.register("corp", service({ "X-Who": "someone" }));
        const result = await w.call("fake_tool", { env: "local", signIn: "nope" });
        assert.equal(result.isError, true);
        assert.match(
            result.text,
            /no sign-in service is named "nope": a company plugin registers one with signIn\.register \(registered: corp\)/,
        );
    });

    test("a service that fails gives the tool an error that names it", async () => {
        const w = await begin();
        jig().signIn.register("corp", {
            headers: async () => {
                throw new Error("the gateway is down");
            },
        });
        const result = await w.call("fake_tool", { env: "local", signIn: "corp" });
        assert.equal(result.isError, true);
        assert.match(result.text, /sign-in service "corp" failed: the gateway is down/);
    });
});

describe("across loads", () => {
    const state = tempState();
    beforeEach(() => {
        state.start();
    });
    afterEach(() => {
        state.stop();
    });

    test("a reload starts with no services, because each load makes its own state", async () => {
        const first = fakePi();
        jigCore()(first.pi);
        jig().signIn.register("corp", service({ "X-Who": "first-load" }));
        assert.equal((await jig().signIn.headers("corp", REQUEST))["X-Who"], "first-load");
        withdrawJig(jig());

        const second = fakePi();
        jigCore()(second.pi);
        await assert.rejects(jig().signIn.headers("corp", REQUEST), /no sign-in service is named "corp"/);
        withdrawJig(jig());
    });
});
