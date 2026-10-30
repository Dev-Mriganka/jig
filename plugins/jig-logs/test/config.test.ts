import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { logsSettings, requireSettings, settingsFrom, targetFor, validateLogsSection } from "../src/config.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

const direct = { url: "https://logs.example.com:9200", auth: { token: "env:LOGS_TOKEN" } };
const transport = { transport: "corp", url: "https://logs.example.com" };
const staging = { index: "app-staging-*" };

/** A section that is valid, with the parts a test changes replaced. */
function section(over: { backend?: unknown; environments?: unknown } = {}): Record<string, unknown> {
    return { backend: direct, environments: { staging }, ...over };
}

const errorsOf = (raw: unknown) => validateLogsSection(raw);

test("a section with a backend and an environment is valid, whichever way requests travel", () => {
    assert.deepEqual(errorsOf(section()), []);
    assert.deepEqual(errorsOf(section({ backend: transport })), []);
});

test("every documented field is accepted", () => {
    const full = {
        backend: {
            url: "https://logs.example.com:9200/search",
            auth: { username: "reader", password: "pass:logs/reader" },
        },
        environments: {
            staging: { index: "app-staging-*", timeField: "timestamp", messageField: "log.message" },
            prod: {
                index: "app-*,-app-debug-*",
                filter: { "env.keyword": "prod", region: 7, canary: false },
                jigEnvironment: "production",
            },
        },
    };
    assert.deepEqual(errorsOf(full), []);
    assert.deepEqual(errorsOf({ ...full, backend: { url: "https://h", auth: { apiKey: "pass:logs/key" } } }), []);
    assert.deepEqual(
        errorsOf({ ...full, backend: { url: "https://h", auth: { token: "op://vault/logs/token" } } }),
        [],
    );
    assert.deepEqual(errorsOf({ ...full, backend: { url: "https://h", auth: { signIn: "corp-sso" } } }), []);
});

test("the section must be an object, and so must everything in it that holds fields", () => {
    for (const raw of [null, "logs", ["a"], 3])
        assert.deepEqual(errorsOf(raw), ["logs must be an object"], JSON.stringify(raw));
    assert.deepEqual(errorsOf(section({ backend: "https://h" })), ["logs.backend must be an object"]);
    assert.deepEqual(errorsOf(section({ backend: { ...direct, auth: "token" } })), [
        "logs.backend.auth must be an object",
    ]);
    assert.deepEqual(errorsOf(section({ environments: [staging] })), [
        "logs.environments must be an object that maps an environment name to its settings",
    ]);
    assert.deepEqual(errorsOf(section({ environments: { staging: "app-*" } })), [
        "logs.environments.staging must be an object with at least an index",
    ]);
});

test("a field nobody defined is an error that names it, at every depth", () => {
    assert.deepEqual(errorsOf({ ...section(), enviroments: {} }), ["logs.enviroments is not a known field"]);
    assert.deepEqual(errorsOf(section({ backend: { ...direct, timeout: 5 } })), [
        "logs.backend.timeout is not a known field",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { ...direct, auth: { token: "env:T", scheme: "x" } } })), [
        "logs.backend.auth.scheme is not a known field",
    ]);
    assert.deepEqual(errorsOf(section({ environments: { staging: { ...staging, indx: "x" } } })), [
        "logs.environments.staging.indx is not a known field",
    ]);
});

test("the backend and the environments are both needed", () => {
    assert.deepEqual(errorsOf({}), [
        "logs.backend is needed: where the search backend is",
        "logs.environments is needed: at least one environment to search",
    ]);
    assert.deepEqual(errorsOf(section({ environments: {} })), ["logs.environments needs at least one environment"]);
});

test("a backend is exactly one of: a direct address with auth, or a transport with an address", () => {
    assert.deepEqual(errorsOf(section({ backend: { url: "https://h" } })), [
        "logs.backend needs auth (username with password, apiKey, token or signIn), or a transport that signs the request in",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { auth: { token: "env:T" } } })), [
        "logs.backend.url must be the address of the search backend, such as https://logs.example.com:9200",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { transport: "corp" } })), [
        "logs.backend.url must be the address of the search backend, such as https://logs.example.com:9200",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { ...transport, auth: { token: "env:T" } } })), [
        "logs.backend.auth cannot be used with transport: the transport signs the request in",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { ...transport, transport: "" } })), [
        "logs.backend.transport must be the name of a transport",
    ]);
    assert.deepEqual(errorsOf(section({ backend: { ...transport, transport: 7 } })), [
        "logs.backend.transport must be the name of a transport",
    ]);
});

// ---- the https rule -------------------------------------------------------------------------------------------

test("a direct address must be https, because a credential travels with every request", () => {
    for (const url of [
        "http://logs.example.com",
        "ftp://logs.example.com",
        "logs.example.com:9200",
        "//logs.example.com",
    ]) {
        assert.equal(errorsOf(section({ backend: { ...direct, url } })).length, 1, url);
    }
    assert.deepEqual(errorsOf(section({ backend: { ...direct, url: "http://127.0.0.1:9200" } })), [
        "logs.backend.url must start with https://, because a credential travels with every request",
    ]);
    assert.deepEqual(
        errorsOf(section({ backend: { ...direct, url: "https://127.0.0.1:9200" } })),
        [],
        "https to a local port is fine",
    );
});

test("a transport signs in by itself, so its address may also be http", () => {
    assert.deepEqual(errorsOf(section({ backend: { ...transport, url: "http://127.0.0.1:8123" } })), []);
    assert.deepEqual(errorsOf(section({ backend: { ...transport, url: "ftp://h" } })), [
        "logs.backend.url must start with http:// or https://",
    ]);
});

test("an address may not hold a user name or password, a query string or a fragment, and is never repeated", () => {
    const pasted = "https://reader:hunter2-the-password@logs.example.com";
    const errors = errorsOf(section({ backend: { ...direct, url: pasted } }));
    assert.deepEqual(errors, ["logs.backend.url must not hold a user name or password: put them in backend.auth"]);
    assert.ok(!errors.join().includes("hunter2"));
    assert.deepEqual(errorsOf(section({ backend: { ...direct, url: "https://h/?token=abc" } })), [
        "logs.backend.url must not have a query string or a fragment: the index is added to it",
    ]);
    assert.equal(errorsOf(section({ backend: { ...direct, url: "https://h/#x" } })).length, 1);
    assert.deepEqual(errorsOf(section({ backend: { ...direct, url: "not an address" } })), [
        "logs.backend.url is not a valid address",
    ]);
});

test("a path in the address is kept, and a trailing slash is not", () => {
    const settings = settingsFrom(section({ backend: { ...direct, url: "https://logs.example.com/search///" } }));
    assert.equal(settings?.backend.url, "https://logs.example.com/search");
    assert.equal(
        settingsFrom(section({ backend: { ...direct, url: "https://logs.example.com:9200/" } }))?.backend.url,
        "https://logs.example.com:9200",
    );
    // The address is kept as the URL parser reads it, so spaces around it and an upper-case host do no harm.
    const odd = settingsFrom(section({ backend: { ...direct, url: " https://LOGS.example.com:443/search/ " } }));
    assert.equal(odd?.backend.url, "https://logs.example.com/search");
});

// ---- the sign-in ----------------------------------------------------------------------------------------------

test("auth is exactly one of: username with password, apiKey, token, signIn", () => {
    const auth = (value: unknown) => errorsOf(section({ backend: { url: "https://h", auth: value } }));
    assert.deepEqual(auth({}), [
        "logs.backend.auth needs exactly one of username with password, apiKey, token and signIn (found none)",
    ]);
    assert.deepEqual(auth({ token: "env:T", apiKey: "env:K" }), [
        "logs.backend.auth needs exactly one of username with password, apiKey, token and signIn (found apiKey, token)",
    ]);
    assert.deepEqual(auth({ username: "u", password: "pass:p", token: "env:T" }), [
        "logs.backend.auth needs exactly one of username with password, apiKey, token and signIn (found username with password, token)",
    ]);
    assert.deepEqual(auth({ username: "reader" }), [
        "logs.backend.auth.password must be a secret reference such as pass:logs/reader, never the secret itself",
    ]);
    assert.deepEqual(auth({ password: "pass:p" }), [
        "logs.backend.auth.username must be a user name: text without a colon",
    ]);
    assert.deepEqual(auth({ username: "a:b", password: "pass:p" }), [
        "logs.backend.auth.username must be a user name: text without a colon",
    ]);
    assert.deepEqual(auth({ signIn: "" }), ["logs.backend.auth.signIn must be the name of a sign-in service"]);
    assert.deepEqual(auth({ signIn: 4 }), ["logs.backend.auth.signIn must be the name of a sign-in service"]);
});

test("a secret is a reference, and an error about one never repeats what was written", () => {
    const pasted = "hunter2-the-actual-password";
    for (const [field, auth] of [
        ["password", { username: "reader", password: pasted }],
        ["apiKey", { apiKey: pasted }],
        ["token", { token: pasted }],
    ] as const) {
        const errors = errorsOf(section({ backend: { url: "https://h", auth } }));
        assert.deepEqual(errors, [
            `logs.backend.auth.${field} must be a secret reference such as pass:logs/reader, never the secret itself`,
        ]);
        assert.ok(!errors.join().includes("hunter2"), field);
    }
    assert.equal(
        errorsOf(section({ backend: { url: "https://h", auth: { token: 12345 } } })).length,
        1,
        "a number is not a reference",
    );
    assert.equal(errorsOf(section({ backend: { url: "https://h", auth: { token: "env:T" } } })).length, 0);
});

// ---- the environments -----------------------------------------------------------------------------------------

test("an environment needs an index, written as a name or pattern that can go in a request path", () => {
    const index = (value: unknown) => errorsOf(section({ environments: { staging: { index: value } } }));
    assert.deepEqual(errorsOf(section({ environments: { staging: {} } })), [
        "logs.environments.staging.index must be an index name or pattern, such as app-logs-*",
    ]);
    for (const good of [
        "app-*",
        "logs-2026.10.*",
        "a,b",
        "cluster:logs-*",
        "logs-*,-logs-debug-*",
        "_all",
        "a_b.c-d",
    ]) {
        assert.deepEqual(index(good), [], good);
    }
    for (const bad of [
        "",
        "a b",
        "a/b",
        "../x",
        "..",
        ".",
        "a,,b",
        "a,",
        ",a",
        "a,..",
        "a?b",
        "a\nb",
        "a%2Fb",
        7,
        "x".repeat(256),
    ]) {
        assert.equal(index(bad).length, 1, JSON.stringify(bad));
    }
});

test("timeField and messageField are field names", () => {
    for (const field of ["timeField", "messageField"]) {
        const set = (value: unknown) =>
            errorsOf(section({ environments: { staging: { ...staging, [field]: value } } }));
        assert.deepEqual(set("log.message"), []);
        assert.deepEqual(set("@timestamp"), []);
        for (const bad of ["", "a b", "a/b", 5, "x".repeat(129)]) {
            assert.deepEqual(
                set(bad),
                [`logs.environments.staging.${field} must be a field name`],
                JSON.stringify(bad),
            );
        }
    }
});

test("a filter maps 1 to 8 field names to the text, number or flag each must equal", () => {
    const filter = (value: unknown) => errorsOf(section({ environments: { staging: { ...staging, filter: value } } }));
    assert.deepEqual(filter({ "env.keyword": "prod" }), []);
    assert.deepEqual(filter({ a: 1, b: 1.5, c: true, d: false }), []);
    const range = "logs.environments.staging.filter must map 1 to 8 field names to the value each must equal";
    assert.deepEqual(filter({}), [range]);
    assert.deepEqual(filter([]), [range]);
    assert.deepEqual(filter("env"), [range]);
    assert.deepEqual(filter(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"]))), [range]);
    assert.deepEqual(filter({ "bad field": "x" }), [
        'logs.environments.staging.filter: "bad field" is not a field name',
    ]);
    assert.deepEqual(filter({ env: "" }), [
        "logs.environments.staging.filter.env must be text, a number, true or false",
    ]);
    assert.deepEqual(filter({ env: null }), [
        "logs.environments.staging.filter.env must be text, a number, true or false",
    ]);
    assert.deepEqual(filter({ env: ["a", "b"] }), [
        "logs.environments.staging.filter.env must be text, a number, true or false",
    ]);
    assert.deepEqual(filter({ env: Number.POSITIVE_INFINITY }), [
        "logs.environments.staging.filter.env must be text, a number, true or false",
    ]);
});

test("jigEnvironment is the name of a jig-core environment", () => {
    const named = (value: unknown) =>
        errorsOf(section({ environments: { staging: { ...staging, jigEnvironment: value } } }));
    assert.deepEqual(named("production"), []);
    assert.deepEqual(named("qa-2"), []);
    for (const bad of ["", "a b", 3, "-x"]) {
        assert.deepEqual(
            named(bad),
            ["logs.environments.staging.jigEnvironment must be the name of a jig-core environment"],
            JSON.stringify(bad),
        );
    }
});

test("an environment name is letters, digits and . _ -, so it is safe in a message and a key", () => {
    for (const bad of ["with space", "", "_x", "a/b", "x".repeat(65), "line\nbreak"]) {
        const errors = errorsOf(section({ environments: { [bad]: staging } }));
        assert.equal(errors.length, 1, JSON.stringify(bad));
        assert.match(errors[0] as string, /^logs\.environments: ".*" is not a usable name/);
        assert.ok(!errors[0]?.includes("\n"));
    }
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`env${i}`, staging]));
    assert.deepEqual(errorsOf(section({ environments: many })), ["logs.environments may hold at most 50 environments"]);
});

test("every error is reported, not only the first", () => {
    const raw = {
        backend: { url: "http://h", auth: { token: "plain" }, extra: 1 },
        environments: { staging: { index: "a b", timeField: "x y" } },
        extra: 1,
    };
    assert.equal(errorsOf(raw).length, 6);
});

// ---- the settings ---------------------------------------------------------------------------------------------

test("the settings have every default filled in", () => {
    const settings = settingsFrom(
        section({
            environments: { staging, prod: { index: "app-*", filter: { env: "prod" }, jigEnvironment: "production" } },
        }),
    );
    assert.deepEqual(settings?.backend, {
        kind: "direct",
        url: "https://logs.example.com:9200",
        auth: { kind: "bearer", token: "env:LOGS_TOKEN" },
    });
    assert.deepEqual(settings?.environments.get("staging"), {
        index: "app-staging-*",
        timeField: "@timestamp",
        messageField: "message",
        filter: {},
        jigEnvironment: "staging",
    });
    assert.deepEqual(settings?.environments.get("prod"), {
        index: "app-*",
        timeField: "@timestamp",
        messageField: "message",
        filter: { env: "prod" },
        jigEnvironment: "production",
    });
    assert.deepEqual([...(settings?.environments.keys() ?? [])], ["staging", "prod"]);
});

test("each way of signing in becomes one kind of auth", () => {
    const kind = (auth: unknown) => settingsFrom(section({ backend: { url: "https://h", auth } }))?.backend;
    assert.deepEqual(kind({ username: "reader", password: "pass:p" }), {
        kind: "direct",
        url: "https://h",
        auth: { kind: "basic", username: "reader", password: "pass:p" },
    });
    assert.deepEqual(kind({ apiKey: "pass:k" }), {
        kind: "direct",
        url: "https://h",
        auth: { kind: "apiKey", apiKey: "pass:k" },
    });
    assert.deepEqual(kind({ token: "pass:t" }), {
        kind: "direct",
        url: "https://h",
        auth: { kind: "bearer", token: "pass:t" },
    });
    assert.deepEqual(kind({ signIn: "corp" }), {
        kind: "direct",
        url: "https://h",
        auth: { kind: "signIn", service: "corp" },
    });
    assert.deepEqual(settingsFrom(section({ backend: transport }))?.backend, {
        kind: "transport",
        url: "https://logs.example.com",
        transport: "corp",
    });
});

test("an invalid section is never half used: there are no settings", () => {
    assert.equal(settingsFrom(section({ backend: { url: "http://h", auth: { token: "env:T" } } })), undefined);
    assert.equal(settingsFrom({ ...section(), typo: 1 }), undefined);
    assert.equal(settingsFrom(undefined), undefined);
    assert.equal(settingsFrom("logs"), undefined);
});

test("an environment may be called constructor: names are data", () => {
    const settings = settingsFrom(section({ environments: { constructor: staging, toString: staging } }));
    assert.equal(settings?.environments.get("constructor")?.index, "app-staging-*");
    assert.equal(settings?.environments.get("toString")?.index, "app-staging-*");
});

test("targetFor finds an environment, and names the ones that exist when the name is wrong", () => {
    const settings = settingsFrom(section({ environments: { staging, prod: { index: "p-*" } } }));
    assert.ok(settings);
    assert.equal(targetFor(settings, "prod").index, "p-*");
    assert.throws(
        () => targetFor(settings, "prd"),
        new TypeError('logs: unknown environment "prd"; use one of staging, prod'),
    );
    assert.throws(() => targetFor(settings, "Prod"), TypeError, "names are exact");
    assert.throws(() => targetFor(settings, undefined), new TypeError("logs needs environment: one of staging, prod"));
    assert.throws(() => targetFor(settings, ""), new TypeError("logs needs environment: one of staging, prod"));
    assert.throws(() => targetFor(settings, 7), new TypeError("logs needs environment: one of staging, prod"));
    assert.throws(() => targetFor(settings, "toString"), TypeError, "not an inherited property");
    assert.throws(
        () => targetFor(settings, "x".repeat(500)),
        (error: Error) => error.message.length < 150 && error.message.includes("..."),
    );
});

// ---- through jig-core -----------------------------------------------------------------------------------------

let jig: FakeJig;
beforeEach(() => {
    jig = installFakeJig();
    jig.sections.set("logs", validateLogsSection);
});
afterEach(() => jig.remove());

test("the settings are read from jig-core when a call needs them", () => {
    jig.setSection("logs", section());
    assert.equal(logsSettings()?.environments.size, 1);
    assert.equal(requireSettings().backend.kind, "direct");
});

test("a section jig-core finds invalid reads as absent, and the tool says it is not configured", () => {
    jig.setSection("logs", { ...section(), typo: 1 });
    assert.equal(logsSettings(), undefined);
    assert.throws(
        () => requireSettings(),
        (error: Error) =>
            error instanceof TypeError &&
            /^logs is not configured: add a "logs" section with "backend" and "environments" to jig.json/.test(
                error.message,
            ),
    );
    jig.setSection("logs", undefined);
    assert.throws(() => requireSettings(), TypeError);
});

test("without jig-core nothing is read: the tool fails closed", () => {
    jig.remove();
    assert.throws(() => logsSettings(), /jig-core is not loaded: enable jig-core, which governs every Jig tool/);
    jig = installFakeJig();
});
