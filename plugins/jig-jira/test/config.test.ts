// The `jira` section of jig.json: what is accepted, what is an error and how the error reads, and what the settings are
// once the section is valid.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ENVIRONMENT, DEFAULT_UPDATE_FIELDS, httpsOnly, readJira, settingsOf, validateJira } from "../src/config.ts";

const SITE = "https://example.atlassian.net";
const cloud = { site: SITE, auth: { email: "jane@example.test", token: "pass:work/jira-token" } };

/** The settings of a section that must be valid. */
function settings(section: Record<string, unknown>) {
    const read = readJira(section);
    assert.deepEqual(read.errors, []);
    assert.ok(read.settings);
    return read.settings;
}

describe("a valid section", () => {
    test("the four ways to sign in", () => {
        assert.deepEqual(settings(cloud).auth, { kind: "basic", email: "jane@example.test", token: "pass:work/jira-token" });
        assert.deepEqual(settings({ site: SITE, auth: { token: "env:JIRA_PAT" } }).auth, { kind: "bearer", token: "env:JIRA_PAT" });
        assert.deepEqual(settings({ site: SITE, auth: { signIn: "company-sso" } }).auth, { kind: "signIn", name: "company-sso" });
        assert.deepEqual(settings({ site: SITE, auth: { transport: "company-proxy" } }).auth, { kind: "transport", name: "company-proxy" });
    });

    test("every secret backend's reference is a token reference", () => {
        for (const token of ["pass:work/jira", "env:JIRA_TOKEN", "keychain:jira/jane", "op://vault/jira/token"]) {
            assert.deepEqual(validateJira({ site: SITE, auth: { token } }), [], token);
        }
    });

    test("the defaults", () => {
        const found = settings(cloud);
        assert.deepEqual(found.updateFields, DEFAULT_UPDATE_FIELDS);
        assert.deepEqual(DEFAULT_UPDATE_FIELDS, ["summary", "description", "labels", "priority", "assignee"]);
        assert.deepEqual(found.fields, {});
        assert.deepEqual(found.privateNames, []);
        assert.equal(found.environment, DEFAULT_ENVIRONMENT);
        assert.equal(DEFAULT_ENVIRONMENT, "external");
    });

    test("every field set", () => {
        const found = settings({
            ...cloud,
            updateFields: ["summary", "Story Points", "customfield_10500"],
            fields: { "Story Points": "customfield_10016", Epic: "customfield_10014" },
            privateNames: [" payroll ", "corp.example.net"],
            environment: "staging",
        });
        assert.deepEqual(found.updateFields, ["summary", "Story Points", "customfield_10500"]);
        assert.deepEqual(found.fields, { "Story Points": "customfield_10016", Epic: "customfield_10014" });
        assert.deepEqual(found.privateNames, ["payroll", "corp.example.net"]);
        assert.equal(found.environment, "staging");
    });

    test("the address is kept without a trailing slash, and may have a path", () => {
        assert.equal(settings({ site: "https://example.atlassian.net/", auth: cloud.auth }).site, "https://example.atlassian.net");
        assert.equal(settings({ site: "https://jira.example.test/jira//", auth: cloud.auth }).site, "https://jira.example.test/jira");
        assert.equal(settings({ site: "https://jira.example.test:8443", auth: cloud.auth }).site, "https://jira.example.test:8443");
    });
});

describe("the address is https", () => {
    test("httpsOnly accepts https addresses and nothing else", () => {
        assert.equal(httpsOnly("https://example.test")?.host, "example.test");
        for (const address of ["http://example.test", "ftp://example.test", "example.test", "//example.test", "", "file:///etc/hosts", 5, undefined, null, "https://"]) {
            assert.equal(httpsOnly(address), undefined, String(address));
        }
    });

    test("an http address is an error that says why", () => {
        const [error] = validateJira({ ...cloud, site: "http://jira.example.test" });
        assert.match(error ?? "", /^jira\.site: must be an https address/);
        assert.match(error ?? "", /never crosses the network in the clear/);
    });

    test("a missing, odd or decorated address is an error", () => {
        assert.match(validateJira({ auth: cloud.auth })[0] ?? "", /^jira\.site: required/);
        assert.match(validateJira({ ...cloud, site: 5 })[0] ?? "", /^jira\.site: must be an https address/);
        assert.match(validateJira({ ...cloud, site: "not a url" })[0] ?? "", /^jira\.site: must be an https address/);
        assert.match(validateJira({ ...cloud, site: "https://jane:secret@example.test" })[0] ?? "", /^jira\.site: must not contain a user name or password/);
        assert.match(validateJira({ ...cloud, site: "https://example.test/?a=1" })[0] ?? "", /^jira\.site: must not contain a query or a fragment/);
        assert.match(validateJira({ ...cloud, site: "https://example.test/#top" })[0] ?? "", /^jira\.site: must not contain a query or a fragment/);
    });

    test("the error for an address with a password does not repeat it", () => {
        assert.doesNotMatch(validateJira({ ...cloud, site: "https://jane:hunter2@example.test" }).join("\n"), /hunter2/);
    });
});

describe("auth is exactly one way", () => {
    test("auth is required, and must be an object", () => {
        assert.match(validateJira({ site: SITE })[0] ?? "", /^jira\.auth: required, one of/);
        assert.match(validateJira({ site: SITE, auth: {} })[0] ?? "", /^jira\.auth: required, one of/);
        assert.deepEqual(validateJira({ site: SITE, auth: "pass:work/jira" }), ["jira.auth: must be an object"]);
        assert.deepEqual(validateJira({ site: SITE, auth: ["pass:work/jira"] }), ["jira.auth: must be an object"]);
    });

    test("a sign-in service and a transport stand alone", () => {
        for (const auth of [
            { signIn: "sso", token: "pass:work/jira" },
            { signIn: "sso", email: "jane@example.test" },
            { transport: "proxy", token: "pass:work/jira" },
            { transport: "proxy", email: "jane@example.test" },
            { signIn: "sso", transport: "proxy" },
        ]) {
            assert.match(validateJira({ site: SITE, auth })[0] ?? "", /^jira\.auth: use exactly one of signIn, transport, or token/, JSON.stringify(auth));
        }
    });

    test("an email alone is not a way to sign in", () => {
        assert.match(validateJira({ site: SITE, auth: { email: "jane@example.test" } })[0] ?? "", /^jira\.auth\.token: required/);
    });

    test("a token must be a secret reference, and the error never repeats the value", () => {
        for (const token of ["ATATT3xFfGF0AbCdEfGhIj1234567890", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "has space:in it", "", 7, null]) {
            const errors = validateJira({ site: SITE, auth: { token } });
            assert.match(errors[0] ?? "", /^jira\.auth\.token: must be a secret reference such as pass:work\/jira-token, not the token itself/, String(token));
            if (typeof token === "string" && token !== "") assert.doesNotMatch(errors.join("\n"), new RegExp(token.slice(0, 12)));
        }
    });

    test("an email must look like one, and a name must be a name", () => {
        assert.match(validateJira({ site: SITE, auth: { email: "jane", token: "pass:x/y" } })[0] ?? "", /^jira\.auth\.email: must be an email address/);
        assert.match(validateJira({ site: SITE, auth: { email: "a:b@c.test", token: "pass:x/y" } })[0] ?? "", /^jira\.auth\.email/);
        for (const key of ["signIn", "transport"]) {
            for (const name of ["", "  ", 5, "x".repeat(65)]) {
                assert.match(validateJira({ site: SITE, auth: { [key]: name } })[0] ?? "", new RegExp(`^jira\\.auth\\.${key}: must be the name of`), `${key} ${String(name)}`);
            }
        }
    });

    test("a field that auth does not have is an error that names it", () => {
        assert.deepEqual(validateJira({ site: SITE, auth: { token: "pass:x/y", password: "x" } }), ["jira.auth.password: unknown field"]);
        assert.deepEqual(validateJira({ site: SITE, auth: { signIn: "sso", cookie: "x" } }), ["jira.auth.cookie: unknown field"]);
    });
});

describe("the other fields", () => {
    test("an unknown field is an error, not a silent default", () => {
        assert.deepEqual(validateJira({ ...cloud, updateField: ["summary"] }), ["jira.updateField: unknown field"]);
        assert.deepEqual(validateJira({ ...cloud, url: SITE }), ["jira.url: unknown field"]);
    });

    test("the section must be an object", () => {
        for (const raw of [null, "jira", ["a"], 3, undefined]) assert.deepEqual(validateJira(raw), ["jira: must be an object"], String(raw));
    });

    test("updateFields names fields the tool knows, friendly names from fields, or field ids", () => {
        assert.deepEqual(validateJira({ ...cloud, updateFields: ["summary", "Labels", "components", "fixVersions", "customfield_10016", "duedate"] }), []);
        assert.deepEqual(validateJira({ ...cloud, fields: { Points: "customfield_10016" }, updateFields: ["points"] }), []);
        assert.match(
            validateJira({ ...cloud, updateFields: ["Story Points"] })[0] ?? "",
            /^jira\.updateFields\[0\]: "Story Points" is not a field the tool knows, a name in jira\.fields, or a field id/,
        );
        assert.match(validateJira({ ...cloud, updateFields: "summary" })[0] ?? "", /^jira\.updateFields: must be a list/);
        assert.match(validateJira({ ...cloud, updateFields: ["summary", ""] })[0] ?? "", /^jira\.updateFields\[1\]: must be text of 1 to 60 characters/);
        assert.match(validateJira({ ...cloud, updateFields: Array.from({ length: 101 }, () => "summary") })[0] ?? "", /at most 100/);
    });

    test("fields maps friendly names to field ids", () => {
        assert.deepEqual(validateJira({ ...cloud, fields: { "Story Points": "customfield_10016", Due: "duedate" } }), []);
        assert.match(validateJira({ ...cloud, fields: { "Story Points": "10016" } })[0] ?? "", /^jira\.fields\.Story Points: must be a field id such as customfield_10016/);
        assert.match(validateJira({ ...cloud, fields: { "Story Points": 5 } })[0] ?? "", /^jira\.fields\.Story Points: must be a field id/);
        assert.match(validateJira({ ...cloud, fields: { Summary: "customfield_1" } })[0] ?? "", /^jira\.fields\.Summary: is a field the tool already knows by that name/);
        assert.match(validateJira({ ...cloud, fields: { Points: "customfield_1", points: "customfield_2" } })[0] ?? "", /is the same name as another entry, apart from case/);
        assert.match(validateJira({ ...cloud, fields: { "": "customfield_1" } })[0] ?? "", /is not a usable name/);
        assert.match(validateJira({ ...cloud, fields: ["customfield_1"] })[0] ?? "", /^jira\.fields: must be an object/);
    });

    test("privateNames is a list of names", () => {
        assert.match(validateJira({ ...cloud, privateNames: "payroll" })[0] ?? "", /^jira\.privateNames: must be a list/);
        assert.match(validateJira({ ...cloud, privateNames: ["ok", 5] })[0] ?? "", /^jira\.privateNames\[1\]: must be text of 1 to 100 characters/);
        assert.match(validateJira({ ...cloud, privateNames: [""] })[0] ?? "", /^jira\.privateNames\[0\]/);
    });

    test("environment is a name", () => {
        for (const environment of ["staging", "qa-2", "ext_1"]) assert.deepEqual(validateJira({ ...cloud, environment }), [], environment);
        for (const environment of ["", "two words", "1abc", 5, "x".repeat(41)]) {
            assert.match(validateJira({ ...cloud, environment })[0] ?? "", /^jira\.environment: must be an environment name/, String(environment));
        }
    });

    test("all the errors come back together, each naming its key", () => {
        const errors = validateJira({ site: "http://x.test", auth: { token: "plain" }, environment: 3, extra: 1 });
        assert.equal(errors.length, 4);
        assert.deepEqual(errors.map((error) => error.split(":")[0]).sort(), ["jira.auth.token", "jira.environment", "jira.extra", "jira.site"]);
    });
});

describe("settingsOf", () => {
    test("reads a valid section and nothing else", () => {
        assert.equal(settingsOf(cloud)?.site, SITE);
        assert.equal(settingsOf({ ...cloud, extra: 1 }), undefined);
        assert.equal(settingsOf(undefined), undefined);
        assert.equal(settingsOf(null), undefined);
        assert.equal(settingsOf("jira"), undefined);
    });

    test("reads a section once", () => {
        const raw = { ...cloud };
        assert.equal(settingsOf(raw), settingsOf(raw), "the same object gives the same settings");
    });
});
