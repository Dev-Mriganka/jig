// The `type` of the backend, and what each type does to the checks of the section: which fields an environment needs,
// which fields belong to which type, and what the settings look like for Loki. The checks that every type shares are in
// config.test.ts, which runs unchanged on sections without a type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsFrom, validateLogsSection } from "../src/config.ts";

const direct = { url: "https://logs.example.com:3100", auth: { token: "env:LOGS_TOKEN" } };
const transport = { transport: "corp", url: "https://logs.example.com" };
const SELECTOR = '{app="orders-api", env="staging"}';
const loki = { type: "loki", ...direct };
const lokiStaging = { selector: SELECTOR };
const elasticStaging = { index: "app-logs-*" };

const section = (backend: unknown, environments: unknown = { staging: lokiStaging }) => ({ backend, environments });
const errorsOf = validateLogsSection;

// ---- the type ---------------------------------------------------------------------------------------------------------

test("a section without a type is Elasticsearch, and a type may also be said", () => {
    assert.deepEqual(errorsOf(section(direct, { staging: elasticStaging })), []);
    assert.deepEqual(errorsOf(section({ type: "elasticsearch", ...direct }, { staging: elasticStaging })), []);
    assert.deepEqual(errorsOf(section(loki)), []);
    assert.equal(settingsFrom(section(direct, { staging: elasticStaging }))?.type, "elasticsearch");
    assert.equal(settingsFrom(section(loki))?.type, "loki");
});

test("a type that is neither is one error, and the fields that depend on the type are not checked", () => {
    const only = ['logs.backend.type must be "elasticsearch" or "loki"'];
    for (const type of ["lokii", "Loki", "", 5, null, ["loki"], "constructor", "__proto__"]) {
        const raw = section({ ...direct, type, tenant: "t" }, { staging: { selector: "x", index: 3, other: 1 } });
        assert.deepEqual(errorsOf(raw), only, JSON.stringify(type));
        assert.equal(settingsFrom(raw), undefined);
    }
    // What does not depend on the type is still checked.
    const raw = section({ type: "lokii", url: "http://h", auth: { token: "plain" } }, {});
    assert.equal(errorsOf(raw).length, 4);
});

// ---- an environment, by type ---------------------------------------------------------------------------------------

test("an environment needs what its type needs, and says so when it is not even an object", () => {
    assert.deepEqual(errorsOf(section(direct, { staging: "app-*" })), [
        "logs.environments.staging must be an object with at least an index",
    ]);
    assert.deepEqual(errorsOf(section(loki, { staging: '{app="x"}' })), [
        "logs.environments.staging must be an object with at least a selector",
    ]);
    assert.deepEqual(errorsOf(section(loki, { staging: {} })), [
        'logs.environments.staging.selector must be a stream selector, such as {app="orders-api", env="staging"}',
    ]);
    assert.deepEqual(errorsOf(section(direct, { staging: {} })), [
        "logs.environments.staging.index must be an index name or pattern, such as app-logs-*",
    ]);
});

test("a field of the other type is an error that names the field and the type it belongs to", () => {
    for (const [field, value] of [
        ["index", "app-logs-*"],
        ["timeField", "timestamp"],
        ["messageField", "msg"],
        ["filter", { env: "staging" }],
    ] as const) {
        assert.deepEqual(errorsOf(section(loki, { staging: { ...lokiStaging, [field]: value } })), [
            `logs.environments.staging.${field} is only used when logs.backend.type is "elasticsearch"`,
        ]);
    }
    assert.deepEqual(errorsOf(section(direct, { staging: { ...elasticStaging, selector: SELECTOR } })), [
        'logs.environments.staging.selector is only used when logs.backend.type is "loki"',
    ]);
    assert.deepEqual(
        errorsOf(section({ type: "elasticsearch", ...direct }, { staging: { ...elasticStaging, selector: SELECTOR } })),
        ['logs.environments.staging.selector is only used when logs.backend.type is "loki"'],
    );
});

test("the settings of the other type are reported with the ones that are missing", () => {
    assert.deepEqual(errorsOf(section(loki, { staging: { index: "app-logs-*" } })), [
        'logs.environments.staging.index is only used when logs.backend.type is "elasticsearch"',
        'logs.environments.staging.selector must be a stream selector, such as {app="orders-api", env="staging"}',
    ]);
});

test("a field nobody defined is still unknown, for either type", () => {
    assert.deepEqual(errorsOf(section(loki, { staging: { ...lokiStaging, selektor: "x" } })), [
        "logs.environments.staging.selektor is not a known field",
    ]);
    assert.deepEqual(errorsOf(section({ ...loki, timeout: 5 })), ["logs.backend.timeout is not a known field"]);
    assert.deepEqual(errorsOf(section({ ...direct, timeout: 5 }, { staging: elasticStaging })), [
        "logs.backend.timeout is not a known field",
    ]);
});

test("jigEnvironment is every type's", () => {
    assert.deepEqual(errorsOf(section(loki, { staging: { ...lokiStaging, jigEnvironment: "production" } })), []);
    assert.deepEqual(errorsOf(section(loki, { staging: { ...lokiStaging, jigEnvironment: "a b" } })), [
        "logs.environments.staging.jigEnvironment must be the name of a jig-core environment",
    ]);
});

// ---- the selector ---------------------------------------------------------------------------------------------------------

test("a selector is a LogQL stream selector with a label that equals a value", () => {
    const selector = (value: unknown) => errorsOf(section(loki, { staging: { selector: value } }));
    const form =
        'logs.environments.staging.selector must be a stream selector, such as {app="orders-api", env="staging"}';
    for (const good of [SELECTOR, '{app=~"orders-.+"}', "{app=`orders-api`}", '{app="x", env!="dev"}']) {
        assert.deepEqual(selector(good), [], good);
    }
    for (const bad of ["", "app=x", "{}", '{app="x"} |= "y"', '{app="x",}', "{app='x'}", 7, null, ['{app="x"}']]) {
        assert.deepEqual(selector(bad), [form], JSON.stringify(bad));
    }
    for (const negative of ['{env!="dev"}', '{app=""}', '{app!~"x", env!="y"}']) {
        assert.deepEqual(selector(negative), [
            "logs.environments.staging.selector needs a label that equals a value (= or =~): Loki refuses a selector that can match every stream",
        ]);
    }
});

test("a selector is kept as written, without the spaces around it, and the environment has no Elasticsearch fields", () => {
    const settings = settingsFrom(section(loki, { staging: { selector: `  ${SELECTOR}  `, jigEnvironment: "test" } }));
    const target = settings?.environments.get("staging");
    assert.deepEqual(target, {
        type: "loki",
        selector: SELECTOR,
        timeField: "@timestamp",
        messageField: "message",
        jigEnvironment: "test",
    });
    assert.ok(!Object.hasOwn(target ?? {}, "index") && !Object.hasOwn(target ?? {}, "filter"));
});

// ---- the tenant ---------------------------------------------------------------------------------------------------------

test("the tenant is Loki's: visible characters without spaces, and no other type has one", () => {
    const tenant = (value: unknown) => errorsOf(section({ ...loki, tenant: value }));
    for (const good of ["orders", "fake", "team-a.prod", "a|b", "ORG_1", "x".repeat(300)]) {
        assert.deepEqual(tenant(good), [], good);
    }
    for (const bad of ["", "a b", "a\nb", "tenanté", 7, null, "x".repeat(301)]) {
        assert.deepEqual(
            tenant(bad),
            ["logs.backend.tenant must be the tenant id: visible characters without spaces, such as orders"],
            JSON.stringify(bad),
        );
    }
    assert.deepEqual(errorsOf(section({ ...direct, tenant: "orders" }, { staging: elasticStaging })), [
        'logs.backend.tenant is only used when logs.backend.type is "loki"',
    ]);
});

test("the settings carry the tenant, with a direct backend and with a transport", () => {
    assert.deepEqual(settingsFrom(section({ ...loki, tenant: "orders" }))?.backend, {
        kind: "direct",
        url: "https://logs.example.com:3100",
        auth: { kind: "bearer", token: "env:LOGS_TOKEN" },
        tenant: "orders",
    });
    assert.deepEqual(settingsFrom(section({ type: "loki", ...transport, tenant: "orders" }))?.backend, {
        kind: "transport",
        url: "https://logs.example.com",
        transport: "corp",
        tenant: "orders",
    });
    assert.ok(!Object.hasOwn(settingsFrom(section(loki))?.backend ?? {}, "tenant"), "no tenant, no key");
});

// ---- how Loki is reached --------------------------------------------------------------------------------------------------

test("Loki is reached the way every backend is: directly with any of the four sign-ins, or through a transport", () => {
    const auths = [
        { username: "12345", password: "pass:logs/token" },
        { apiKey: "pass:logs/key" },
        { token: "pass:logs/token" },
        { signIn: "corp-sso" },
    ];
    for (const auth of auths)
        assert.deepEqual(errorsOf(section({ type: "loki", url: direct.url, auth })), [], JSON.stringify(auth));
    assert.deepEqual(errorsOf(section({ type: "loki", ...transport })), []);
    assert.deepEqual(errorsOf(section({ type: "loki", ...transport, url: "http://127.0.0.1:3100" })), []);
    assert.deepEqual(errorsOf(section({ type: "loki", url: "http://127.0.0.1:3100", auth: direct.auth })), [
        "logs.backend.url must start with https://, because a credential travels with every request",
    ]);
    assert.deepEqual(errorsOf(section({ type: "loki", ...transport, auth: direct.auth })), [
        "logs.backend.auth cannot be used with transport: the transport signs the request in",
    ]);
});

test("the address in the message is an example for the type", () => {
    assert.deepEqual(errorsOf(section({ type: "loki", auth: direct.auth })), [
        "logs.backend.url must be the address of the search backend, such as https://logs.example.com:3100",
    ]);
    assert.deepEqual(errorsOf(section({ auth: direct.auth }, { staging: elasticStaging })), [
        "logs.backend.url must be the address of the search backend, such as https://logs.example.com:9200",
    ]);
});

test("a Loki section reports every error, not only the first", () => {
    const raw = {
        backend: { type: "loki", url: "http://h", auth: { token: "plain" }, tenant: "a b", extra: 1 },
        environments: { staging: { selector: "x", index: "a" }, prod: "x" },
        extra: 1,
    };
    assert.equal(errorsOf(raw).length, 8);
});
