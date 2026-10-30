// The `http` section of jig.json: what is accepted, what is an error and how the error reads, and what the settings are once
// the section is valid.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addressProblem, readHttp, settingsOf, validateHttp } from "../src/config.ts";
import type { Target } from "../src/config.ts";

const BASE = "https://api.example.test";
const target = (extra: Record<string, unknown> = {}) => ({ baseUrl: BASE, environment: "staging", auth: { none: true }, ...extra });
const section = (extra: Record<string, unknown> = {}) => ({ targets: { api: target(extra) } });
const OAUTH = {
    tokenUrl: "https://auth.example.test/oauth/token",
    clientId: "portal",
    clientSecret: "pass:api/client-secret",
    username: "pass:api/user",
    password: "pass:api/password",
};

/** The first target of a section that must be valid. */
function found(raw: Record<string, unknown>): Target {
    const read = readHttp(raw);
    assert.deepEqual(read.errors, []);
    const first = read.settings?.targets.values().next().value;
    assert.ok(first);
    return first;
}

/** The errors of a section, which must hold at least one. */
function errorsOf(raw: unknown): string[] {
    const { errors, settings } = readHttp(raw);
    assert.ok(errors.length > 0, "expected errors");
    assert.equal(settings, undefined, "a section with errors has no settings");
    return errors;
}

describe("a valid section", () => {
    test("the five ways to sign in", () => {
        assert.deepEqual(found(section({ auth: { none: true } })).auth, { kind: "none" });
        assert.deepEqual(found(section({ auth: { bearer: "pass:api/token" } })).auth, { kind: "bearer", token: "pass:api/token" });
        assert.deepEqual(found(section({ auth: { oauthPassword: OAUTH } })).auth, { kind: "oauthPassword", oauth: OAUTH });
        assert.deepEqual(found(section({ auth: { signIn: "company-sso" } })).auth, { kind: "signIn", name: "company-sso" });
        assert.deepEqual(found(section({ auth: { transport: "company-proxy" } })).auth, { kind: "transport", name: "company-proxy" });
    });

    test("every secret backend's reference is a secret reference", () => {
        for (const bearer of ["pass:work/api", "env:API_TOKEN", "keychain:api/jane", "op://vault/api/token"]) {
            assert.deepEqual(validateHttp(section({ auth: { bearer } })), [], bearer);
        }
    });

    test("the OAuth settings may leave out the client secret and the scope, and may give a scope", () => {
        const { clientSecret: _left, ...open } = OAUTH;
        assert.deepEqual(found(section({ auth: { oauthPassword: open } })).auth, { kind: "oauthPassword", oauth: open });
        const scoped = { ...OAUTH, scope: "read write" };
        assert.deepEqual(found(section({ auth: { oauthPassword: scoped } })).auth, { kind: "oauthPassword", oauth: scoped });
    });

    test("the defaults, and every field set", () => {
        const plain = found(section());
        assert.deepEqual(plain, { name: "api", baseUrl: BASE, environment: "staging", auth: { kind: "none" }, allowPlainLocal: false });
        const full = found(section({ description: "The test API", allowPlainLocal: true }));
        assert.equal(full.description, "The test API");
        assert.equal(full.allowPlainLocal, true);
    });

    test("the base address is kept without a trailing slash, and may have a path and a port", () => {
        assert.equal(found(section({ baseUrl: "https://api.example.test/" })).baseUrl, BASE);
        assert.equal(found(section({ baseUrl: "https://api.example.test/v1//" })).baseUrl, `${BASE}/v1`);
        assert.equal(found(section({ baseUrl: "https://api.example.test:8443/a/b" })).baseUrl, `${BASE}:8443/a/b`);
        assert.equal(found(section({ baseUrl: "HTTPS://API.Example.Test/V1" })).baseUrl, `${BASE}/V1`);
    });

    test("several targets are kept by name, and a name may hold dots, dashes and underscores", () => {
        const read = readHttp({ targets: { api: target(), "billing-v2": target(), "a.b_c": target(), "9lives": target() } });
        assert.deepEqual(read.errors, []);
        assert.deepEqual([...(read.settings?.targets.keys() ?? [])], ["api", "billing-v2", "a.b_c", "9lives"]);
    });
});

describe("the address", () => {
    test("addressProblem accepts https, and plain http only to this machine when the target allows it", () => {
        assert.equal(addressProblem("https://api.example.test", false), undefined);
        assert.equal(addressProblem("https://api.example.test:8443/x?y=1", false), undefined);
        assert.equal(addressProblem("http://127.0.0.1:8080", true), undefined);
        assert.equal(addressProblem("http://localhost", true), undefined);
        assert.equal(addressProblem("http://LOCALHOST:3000/x", true), undefined);
        assert.match(addressProblem("http://127.0.0.1", false) ?? "", /needs "allowPlainLocal": true/);
        assert.match(addressProblem("http://localhost:3000", false) ?? "", /needs "allowPlainLocal": true/);
    });

    test("anything else is refused, with or without the flag", () => {
        const refused = [
            "http://api.example.test", "http://127.0.0.2", "http://127.0.0.1.example.test", "http://localhost.example.test",
            "http://[::1]:8080", "http://0.0.0.0", "http://10.0.0.1", "ftp://api.example.test", "ws://127.0.0.1", "file:///etc/hosts",
            "api.example.test", "//api.example.test", "/v1", "", "https://", "not a url", 5, undefined, null, {},
        ];
        for (const address of refused) {
            for (const flag of [false, true]) assert.notEqual(addressProblem(address, flag), undefined, `${String(address)} with ${flag}`);
        }
    });

    test("a user name or password in the address is refused", () => {
        assert.match(addressProblem("https://jane:secret@api.example.test", false) ?? "", /must not contain a user name or password/);
        assert.match(addressProblem("https://jane@api.example.test", false) ?? "", /must not contain a user name or password/);
        const errors = errorsOf(section({ baseUrl: "https://jane:s3cret@api.example.test" }));
        assert.deepEqual(errors, ["http.targets.api.baseUrl: must not contain a user name or password"]);
    });

    test("an http base address is an error that says why and what would allow it", () => {
        const [error] = errorsOf(section({ baseUrl: "http://api.example.test" }));
        assert.match(error ?? "", /^http\.targets\.api\.baseUrl: must be an https address/);
        assert.match(error ?? "", /plain http is only for 127\.0\.0\.1 and localhost/);
        assert.deepEqual(errorsOf(section({ baseUrl: "http://127.0.0.1:9" })), [
            'http.targets.api.baseUrl: plain http to this machine needs "allowPlainLocal": true on the target',
        ]);
        assert.equal(found(section({ baseUrl: "http://127.0.0.1:9", allowPlainLocal: true })).baseUrl, "http://127.0.0.1:9");
        assert.equal(found(section({ baseUrl: "http://localhost:9/v1/", allowPlainLocal: true })).baseUrl, "http://localhost:9/v1");
    });

    test("the flag does not make another http address valid, and it must be true or false", () => {
        assert.match(errorsOf(section({ baseUrl: "http://api.example.test", allowPlainLocal: true }))[0] ?? "", /must be an https address/);
        assert.deepEqual(errorsOf(section({ allowPlainLocal: "yes" })), ["http.targets.api.allowPlainLocal: must be true or false"]);
        assert.equal(found(section({ allowPlainLocal: true })).baseUrl, BASE, "harmless with an https address");
    });

    test("a missing, odd or decorated base address is an error", () => {
        const { baseUrl: _removed, ...without } = target();
        assert.match(errorsOf({ targets: { api: without } })[0] ?? "", /^http\.targets\.api\.baseUrl: required/);
        assert.match(errorsOf(section({ baseUrl: 5 }))[0] ?? "", /^http\.targets\.api\.baseUrl: must be an https address/);
        assert.match(errorsOf(section({ baseUrl: "not a url" }))[0] ?? "", /must be an https address/);
        assert.equal(errorsOf(section({ baseUrl: `${BASE}/v1?key=1` }))[0], "http.targets.api.baseUrl: must not contain a query or a fragment");
        assert.equal(errorsOf(section({ baseUrl: `${BASE}/v1#top` }))[0], "http.targets.api.baseUrl: must not contain a query or a fragment");
    });

    test("the token endpoint follows the same rule, and the target's flag", () => {
        const withToken = (tokenUrl: unknown, extra: Record<string, unknown> = {}) =>
            section({ auth: { oauthPassword: { ...OAUTH, tokenUrl } }, ...extra });
        assert.match(errorsOf(withToken("http://auth.example.test/token"))[0] ?? "", /^http\.targets\.api\.auth\.oauthPassword\.tokenUrl: must be an https address/);
        assert.match(errorsOf(withToken("http://127.0.0.1:9/token"))[0] ?? "", /tokenUrl: plain http to this machine needs "allowPlainLocal": true/);
        assert.deepEqual(validateHttp(withToken("http://127.0.0.1:9/token", { baseUrl: "http://127.0.0.1:8", allowPlainLocal: true })), []);
        assert.deepEqual(validateHttp(withToken("https://auth.example.test/token?tenant=1")), [], "a query is part of some token endpoints");
        assert.match(errorsOf(withToken("https://auth.example.test/token#x"))[0] ?? "", /tokenUrl: must not contain a fragment/);
        assert.match(errorsOf(withToken("https://u:p@auth.example.test/token"))[0] ?? "", /tokenUrl: must not contain a user name or password/);
        assert.match(errorsOf(withToken(undefined))[0] ?? "", /tokenUrl: required/);
    });
});

describe("the environment", () => {
    test("is required, and is a name", () => {
        const { environment: _removed, ...without } = target();
        assert.match(errorsOf({ targets: { api: without } })[0] ?? "", /^http\.targets\.api\.environment: required/);
        for (const environment of ["", "9staging", "has space", "a".repeat(41), 5, null, ["staging"]]) {
            assert.match(errorsOf(section({ environment }))[0] ?? "", /^http\.targets\.api\.environment: must be an environment name/, String(environment));
        }
        for (const environment of ["staging", "prod", "qa-2", "test_env", "local", "external", "A"]) assert.equal(found(section({ environment })).environment, environment);
    });
});

describe("the sign-in", () => {
    test("is required, and exactly one of the five", () => {
        const { auth: _removed, ...without } = target();
        assert.match(errorsOf({ targets: { api: without } })[0] ?? "", /^http\.targets\.api\.auth: required, exactly one of \{ "none": true \}/);
        assert.match(errorsOf(section({ auth: {} }))[0] ?? "", /^http\.targets\.api\.auth: required/);
        assert.deepEqual(errorsOf(section({ auth: "none" })), ["http.targets.api.auth: must be an object"]);
        assert.deepEqual(errorsOf(section({ auth: [] })), ["http.targets.api.auth: must be an object"]);
        assert.deepEqual(errorsOf(section({ auth: { none: true, bearer: "pass:a/b" } })), [
            "http.targets.api.auth: use exactly one of none, bearer, oauthPassword, signIn, transport (got none, bearer)",
        ]);
        assert.deepEqual(errorsOf(section({ auth: { signIn: "a", transport: "b" } })).length, 1);
    });

    test("a way to sign in that does not exist is an unknown field", () => {
        assert.deepEqual(errorsOf(section({ auth: { basic: "pass:a/b" } })), ["http.targets.api.auth.basic: unknown field"]);
        assert.deepEqual(errorsOf(section({ auth: { bearer: "pass:a/b", header: "X-Key" } })), ["http.targets.api.auth.header: unknown field"]);
    });

    test("none is true", () => {
        assert.deepEqual(errorsOf(section({ auth: { none: false } })), ["http.targets.api.auth.none: must be true"]);
        assert.deepEqual(errorsOf(section({ auth: { none: "true" } })), ["http.targets.api.auth.none: must be true"]);
    });

    test("a secret must be a reference, and a secret pasted in its place is refused without being repeated", () => {
        const pasted = "tok-4f9c2a71d3e8";
        for (const bearer of [pasted, "", 5, null, "has space:abc", "pass:", "Bearer abc"]) {
            const errors = errorsOf(section({ auth: { bearer } }));
            assert.deepEqual(errors, ["http.targets.api.auth.bearer: must be a secret reference such as pass:work/api-token, not the secret itself"]);
        }
    });

    test("a sign-in service and a transport are named", () => {
        for (const kind of ["signIn", "transport"]) {
            const what = kind === "signIn" ? "sign-in service" : "transport";
            for (const name of ["", "  ", "a".repeat(65), 5, true, ["x"], "a\nb"]) {
                assert.deepEqual(errorsOf(section({ auth: { [kind]: name } })), [`http.targets.api.auth.${kind}: must be the name of a ${what}`]);
            }
        }
    });

    test("the OAuth settings: every required field, a reference for each secret, and no other field", () => {
        const withOAuth = (oauthPassword: unknown) => section({ auth: { oauthPassword } });
        assert.match(errorsOf(withOAuth("pass:a/b"))[0] ?? "", /^http\.targets\.api\.auth\.oauthPassword: must be an object with tokenUrl, clientId, username and password/);
        const required = ["tokenUrl", "clientId", "username", "password"];
        for (const field of required) {
            const { [field]: _removed, ...rest } = OAUTH as Record<string, unknown>;
            assert.match(errorsOf(withOAuth(rest))[0] ?? "", new RegExp(`^http\\.targets\\.api\\.auth\\.oauthPassword\\.${field}: required`));
        }
        for (const field of ["clientSecret", "username", "password"]) {
            const errors = errorsOf(withOAuth({ ...OAUTH, [field]: "hunter2hunter2" }));
            assert.deepEqual(errors, [`http.targets.api.auth.oauthPassword.${field}: must be a secret reference such as pass:work/api-token, not the secret itself`]);
        }
        assert.deepEqual(errorsOf(withOAuth({ ...OAUTH, grantType: "password" })), ["http.targets.api.auth.oauthPassword.grantType: unknown field"]);
        for (const bad of ["", "  ", "a".repeat(201), 5, "a\nb"]) {
            assert.match(errorsOf(withOAuth({ ...OAUTH, clientId: bad }))[0] ?? "", /oauthPassword\.clientId: must be text of 1 to 200 characters/);
        }
        for (const bad of ["", "a".repeat(501), 5, "a\u0000b"]) {
            assert.match(errorsOf(withOAuth({ ...OAUTH, scope: bad }))[0] ?? "", /oauthPassword\.scope: must be text of 1 to 500 characters/);
        }
    });
});

describe("a section with mistakes", () => {
    test("an unknown field is an error, at every level, and a misspelt one is not a silent default", () => {
        assert.deepEqual(errorsOf({ targets: { api: target() }, target: {} }), ["http.target: unknown field"]);
        assert.deepEqual(errorsOf(section({ enviroment: "staging" })), ["http.targets.api.enviroment: unknown field"]);
        assert.deepEqual(errorsOf(section({ plain: true })), ["http.targets.api.plain: unknown field"]);
    });

    test("the section and its targets must be objects, and there must be a target", () => {
        assert.deepEqual(validateHttp("targets"), ["http: must be an object"]);
        assert.deepEqual(validateHttp([]), ["http: must be an object"]);
        assert.deepEqual(validateHttp(null), ["http: must be an object"]);
        assert.match(errorsOf({})[0] ?? "", /^http\.targets: required/);
        assert.deepEqual(errorsOf({ targets: [] }), ["http.targets: must be an object that maps a name to a target"]);
        assert.deepEqual(errorsOf({ targets: {} }), ["http.targets: must name 1 to 100 targets"]);
        assert.deepEqual(errorsOf({ targets: { api: "https://api.example.test" } }), ["http.targets.api: must be an object with baseUrl, environment and auth"]);
        const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`t${index}`, target()]));
        assert.deepEqual(errorsOf({ targets: many }), ["http.targets: must name 1 to 100 targets"]);
    });

    test("a target name is plain: it is what the model types, and what a message quotes", () => {
        for (const name of ["", " api", "api ", "a b", "-api", ".api", "_api", "a".repeat(41), "é", "a/b", "a:b"]) {
            const [error] = errorsOf({ targets: { [name]: target() } });
            assert.match(error ?? "", /^http\.targets: .* is not a usable name \(1 to 40 letters, digits, \. _ -, starting with a letter or digit\)$/, name);
        }
        const hostile = JSON.parse('{"targets":{"__proto__":{"baseUrl":"https://a.example.test","environment":"staging","auth":{"none":true}}}}') as unknown;
        assert.match(errorsOf(hostile)[0] ?? "", /is not a usable name/);
        const quoted = errorsOf({ targets: { "a\nb": target() } })[0] ?? "";
        assert.ok(!quoted.includes("\n"), "a control character is quoted, not printed");
    });

    test("every mistake is reported at once, each with its key", () => {
        const errors = errorsOf({
            targets: {
                one: { baseUrl: "http://one.example.test", environment: "", auth: {} },
                two: target({ description: "" }),
            },
            extra: 1,
        });
        assert.equal(errors.length, 5);
        assert.ok(errors.some((error) => error.startsWith("http.extra:")));
        assert.ok(errors.some((error) => error.startsWith("http.targets.one.baseUrl:")));
        assert.ok(errors.some((error) => error.startsWith("http.targets.one.environment:")));
        assert.ok(errors.some((error) => error.startsWith("http.targets.one.auth:")));
        assert.ok(errors.some((error) => error.startsWith("http.targets.two.description:")));
    });

    test("a description is text without control characters, of at most 200 characters", () => {
        for (const description of ["", "  ", "a".repeat(201), 5, "a\nb"]) {
            assert.deepEqual(errorsOf(section({ description })), ["http.targets.api.description: must be text of 1 to 200 characters, with no control characters"]);
        }
    });
});

describe("what the plugin reads from the section", () => {
    test("settingsOf gives the settings of a valid section, and reads each object once", () => {
        const raw = section({ auth: { bearer: "pass:a/b" } });
        const first = settingsOf(raw);
        assert.ok(first);
        assert.equal(settingsOf(raw), first, "the same settings for the same object");
        assert.notEqual(settingsOf({ ...raw }), first, "a changed section is read again");
    });

    test("settingsOf gives nothing for an absent or an invalid section", () => {
        for (const raw of [undefined, null, "targets", 5, [], { targets: {} }, section({ baseUrl: "http://api.example.test" })]) {
            assert.equal(settingsOf(raw), undefined);
        }
    });

    test("validateHttp returns the errors of readHttp, and none for a valid section", () => {
        assert.deepEqual(validateHttp(section()), []);
        assert.deepEqual(validateHttp(section({ baseUrl: "ftp://x" })), readHttp(section({ baseUrl: "ftp://x" })).errors);
    });
});
