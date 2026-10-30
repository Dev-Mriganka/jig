// The `api` section of jig.json: what is accepted, what is an error and how the error reads, and what the settings are once the
// section is valid. Nothing here reads a file: the section is checked when jig-core starts, before any call.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { jigEnvironmentOf, readApi, settingsOf, validateApi } from "../src/config.ts";
import type { ApiSettings } from "../src/config.ts";

const POSTMAN = "/work/billing.postman_collection.json";
const HTTP = "/work/orders/http";
const section = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    collections: { orders: { http: HTTP } },
    ...extra,
});

/** The settings of a section that must be valid. */
function found(raw: Record<string, unknown>): ApiSettings {
    const read = readApi(raw);
    assert.deepEqual(read.errors, []);
    assert.ok(read.settings);
    return read.settings;
}

/** The errors of a section, which must hold at least one. */
function errorsOf(raw: unknown): string[] {
    const { errors, settings } = readApi(raw);
    assert.ok(errors.length > 0, "expected errors");
    assert.equal(settings, undefined, "a section with errors has no settings");
    return errors;
}

describe("a valid section", () => {
    test("the smallest one is a single collection, and everything else has a default", () => {
        const settings = found(section());
        assert.deepEqual([...settings.collections.keys()], ["orders"]);
        assert.equal(settings.collections.get("orders")?.kind, "http");
        assert.equal(settings.environments.size, 0);
        assert.equal(settings.secrets.size, 0);
        assert.equal(settings.reads.size, 0);
        assert.equal(settings.adHoc.size, 0);
        assert.equal(settings.timeoutSec, 30);
        assert.equal(settings.allowPlainLocal, false);
    });

    test("the section of the README", () => {
        const settings = found({
            collections: {
                orders: { http: "~/work/orders-api/http" },
                billing: { postman: "~/work/billing.postman_collection.json", environments: { Staging: "~/work/billing-staging.postman_environment.json" } },
            },
            environments: { Staging: "staging", Prod: "production" },
            secrets: { token: "pass:orders/token" },
            reads: ["Search orders"],
            adHoc: ["staging"],
        });
        assert.deepEqual([...settings.collections.keys()], ["orders", "billing"]);
        assert.deepEqual(settings.environments.get("Staging"), { environment: "staging" });
        assert.deepEqual(settings.secrets.get("token"), { everywhere: "pass:orders/token", byEnvironment: new Map() });
        assert.deepEqual([...settings.reads], ["Search orders"]);
        assert.deepEqual([...settings.adHoc], ["staging"]);
    });

    test("every field of the section, set", () => {
        const settings = found(section({ environments: { Local: "local" }, adHoc: ["local"], timeoutSec: 90, allowPlainLocal: true }));
        assert.equal(settings.timeoutSec, 90);
        assert.equal(settings.allowPlainLocal, true);
    });

    test("a path may start with ~/, which is the home folder, and is otherwise absolute", () => {
        const raw = { collections: { a: { http: "~/work/http" }, b: { postman: "~/work/p.json", environments: { Staging: "~/work/e.json" } } } };
        assert.deepEqual(readApi(raw).errors, []);
        const files = (settings: ApiSettings, name: string): string => JSON.stringify(settings.collections.get(name));
        assert.ok(files(found(raw), "a").includes('"kind":"http"'));
        // The expanded path is what the source reads: checked through what it reports for a folder that does not exist.
        const collection = found(raw).collections.get("a")?.load();
        assert.equal(collection?.problems[0]?.message, "the folder does not exist");
        assert.equal(collection?.root, path.join(os.homedir(), "work", "http"));
    });

    test("a secret may be one reference for every environment, or one per environment", () => {
        const settings = found(section({ secrets: { token: { Staging: "pass:orders/staging", Prod: "env:ORDERS_PROD_TOKEN" }, key: "op://vault/orders/key" } }));
        assert.deepEqual([...(settings.secrets.get("token")?.byEnvironment ?? [])], [["Staging", "pass:orders/staging"], ["Prod", "env:ORDERS_PROD_TOKEN"]]);
        assert.equal(settings.secrets.get("key")?.everywhere, "op://vault/orders/key");
    });

    test("every secret backend's reference is a secret reference", () => {
        for (const reference of ["pass:work/api", "env:API_TOKEN", "keychain:api/jane", "op://vault/api/token"]) {
            assert.deepEqual(validateApi(section({ secrets: { token: reference } })), [], reference);
        }
    });

    test("an environment may name the sign-in service or the transport that every request in it goes through", () => {
        const settings = found(section({
            environments: { Staging: "staging", Qa: { environment: "qa", signIn: "company-sso" }, Dev: { environment: "dev", transport: "company-proxy" } },
        }));
        assert.deepEqual(settings.environments.get("Qa"), { environment: "qa", signIn: "company-sso" });
        assert.deepEqual(settings.environments.get("Dev"), { environment: "dev", transport: "company-proxy" });
    });
});

describe("the collections", () => {
    test("a source is exactly one of the sources there are", () => {
        assert.deepEqual(errorsOf({ collections: { a: {} } }), ["api.collections.a: needs a source: one of postman, http, bruno"]);
        assert.deepEqual(errorsOf({ collections: { a: { yaml: "/work/x" } } }), [
            "api.collections.a: needs a source: one of postman, http, bruno",
            "api.collections.a.yaml: unknown field",
        ]);
        assert.deepEqual(errorsOf({ collections: { a: { http: HTTP, postman: POSTMAN } } }), ["api.collections.a: use exactly one source (got http, postman)"]);
        assert.deepEqual(errorsOf({ collections: { a: "orders" } }), [
            'api.collections.a: must be an object with one source, such as { "postman": "<path>" } or { "http": "<folder>" }',
        ]);
    });

    test("an unknown field is an error at every level, and a misspelt one is not a silent default", () => {
        assert.deepEqual(errorsOf(section({ adhoc: ["staging"] })), ["api.adhoc: unknown field"]);
        assert.deepEqual(errorsOf({ collections: { a: { http: HTTP, folder: "x" } } }), ["api.collections.a.folder: unknown field"]);
        assert.deepEqual(errorsOf({ collections: { a: { postman: POSTMAN, enviroments: {} } } }), ["api.collections.a.enviroments: unknown field"]);
        assert.deepEqual(errorsOf(section({ environments: { Staging: { environment: "staging", signin: "x" } } })), ["api.environments.Staging.signin: unknown field"]);
    });

    test("a Bruno collection is a folder, by an absolute path or ~/, and has no other field", () => {
        const settings = found({ collections: { a: { bruno: "~/work/bruno" }, b: { bruno: "/work/bruno" } } });
        assert.equal(settings.collections.get("a")?.kind, "bruno");
        assert.deepEqual(errorsOf({ collections: { a: { bruno: "work/bruno" } } }), ["api.collections.a.bruno: must be an absolute path or start with ~/"]);
        assert.deepEqual(errorsOf({ collections: { a: { bruno: 7 } } }), ["api.collections.a.bruno: must be the path of a Bruno collection folder"]);
        assert.deepEqual(errorsOf({ collections: { a: { bruno: "/work/bruno", environments: {} } } }), ["api.collections.a.environments: unknown field"]);
    });

    test("a path is absolute or starts with ~/, and is not text of no use", () => {
        assert.deepEqual(errorsOf({ collections: { a: { http: "orders/http" } } }), ["api.collections.a.http: must be an absolute path or start with ~/"]);
        assert.deepEqual(errorsOf({ collections: { a: { postman: "billing.json" } } }), ["api.collections.a.postman: must be an absolute path or start with ~/"]);
        for (const bad of ["", "  ", 5, null, ["/work"], "/work/\0x"]) {
            assert.deepEqual(errorsOf({ collections: { a: { http: bad } } }), ["api.collections.a.http: must be the path of a folder of .http files"], String(bad));
        }
        assert.deepEqual(errorsOf({ collections: { a: { postman: POSTMAN, environments: { Staging: "staging.json" } } } }), [
            "api.collections.a.environments.Staging: must be an absolute path or start with ~/",
        ]);
    });

    test("environments of a Postman collection are an object of name to path", () => {
        assert.deepEqual(errorsOf({ collections: { a: { postman: POSTMAN, environments: ["/work/e.json"] } } }), [
            "api.collections.a.environments: must be an object that maps an environment name to the path of its exported file",
        ]);
        assert.deepEqual(errorsOf({ collections: { a: { postman: POSTMAN, environments: { "a\nb": "/work/e.json" } } } }), [
            "api.collections.a.environments: an environment name is text of 1 to 60 characters with no control characters",
        ]);
    });

    test("the collections are required, an object, and between 1 and 50", () => {
        assert.match(errorsOf({})[0] ?? "", /^api\.collections: required/);
        assert.deepEqual(errorsOf({ collections: [] }), ["api.collections: must be an object that maps a name to a source"]);
        assert.deepEqual(errorsOf({ collections: {} }), ["api.collections: must name 1 to 50 collections"]);
        const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`c${index}`, { http: HTTP }]));
        assert.deepEqual(errorsOf({ collections: many }), ["api.collections: must name 1 to 50 collections"]);
    });

    test("a name is plain: it is what the model types, and what a message quotes", () => {
        for (const name of ["", " a", "a b", "-a", ".a", "a".repeat(41), "é", "a/b"]) {
            const [error] = errorsOf({ collections: { [name]: { http: HTTP } } });
            assert.match(error ?? "", /^api\.collections: .* is not a usable name \(1 to 40 letters, digits, \. _ -, starting with a letter or digit\)$/, name);
        }
        const hostile = JSON.parse('{"collections":{"__proto__":{"http":"/work/http"}}}') as unknown;
        assert.match(errorsOf(hostile)[0] ?? "", /is not a usable name/);
        for (const name of ["orders", "billing-v2", "a.b_c", "9lives"]) assert.deepEqual(validateApi({ collections: { [name]: { http: HTTP } } }), [], name);
    });
});

describe("the environments", () => {
    test("a name that is mapped is the jig-core environment, and one that is not counts as production", () => {
        const settings = found(section({ environments: { Staging: "staging" } }));
        assert.equal(jigEnvironmentOf(settings, "Staging"), "staging");
        assert.equal(jigEnvironmentOf(settings, "Prod"), "production");
        assert.equal(jigEnvironmentOf(settings, "staging"), "production", "the collection's name is not the jig-core name");
        assert.equal(jigEnvironmentOf(settings, "constructor"), "production", "a name that is only a name on an object is not mapped");
    });

    test("a jig-core name is letters, digits, _ and -, starting with a letter", () => {
        for (const bad of ["", "9staging", "has space", "a".repeat(41), 5, null, ["staging"]]) {
            assert.match(errorsOf(section({ environments: { Staging: bad } }))[0] ?? "", /^api\.environments\.Staging: must be a jig-core environment name such as staging/, String(bad));
        }
    });

    test("a sign-in service and a transport are named, and not both", () => {
        for (const key of ["signIn", "transport"]) {
            const what = key === "signIn" ? "sign-in service" : "transport";
            for (const name of ["", "  ", "a".repeat(65), 5, true, ["x"], "a\nb"]) {
                assert.deepEqual(errorsOf(section({ environments: { Staging: { environment: "staging", [key]: name } } })), [`api.environments.Staging.${key}: must be the name of a ${what}`]);
            }
        }
        assert.deepEqual(errorsOf(section({ environments: { Staging: { environment: "staging", signIn: "a", transport: "b" } } })), [
            "api.environments.Staging: use signIn or transport, not both",
        ]);
        assert.deepEqual(errorsOf(section({ environments: { Staging: { signIn: "a" } } })), [
            "api.environments.Staging.environment: required, a jig-core environment name such as staging",
        ]);
    });

    test("the section must be an object", () => {
        assert.deepEqual(errorsOf(section({ environments: ["staging"] })), [
            'api.environments: must be an object that maps your collections\' environment names to jig-core\'s, such as { "Staging": "staging" }',
        ]);
    });
});

describe("the secrets", () => {
    test("a secret must be a reference, and a secret pasted in its place is refused without being repeated", () => {
        const pasted = "tok-4f9c2a71d3e8";
        for (const reference of [pasted, "", 5, "has space:abc", "pass:", "Bearer abc"]) {
            const errors = errorsOf(section({ secrets: { token: reference } }));
            assert.equal(errors.length, 1);
            assert.ok(!errors.join("").includes(pasted));
            assert.match(errors[0] ?? "", /^api\.secrets\.token: must be a secret reference such as pass:work\/api-token/, String(reference));
        }
        const nested = errorsOf(section({ secrets: { token: { Staging: pasted } } }));
        assert.deepEqual(nested, ["api.secrets.token.Staging: must be a secret reference such as pass:work/api-token, not the secret itself"]);
    });

    test("a name is a variable name, and an empty object is no secret", () => {
        assert.match(errorsOf(section({ secrets: { "has space": "pass:a/b" } }))[0] ?? "", /^api\.secrets: .* is not a usable variable name$/);
        assert.match(errorsOf(section({ secrets: { token: {} } }))[0] ?? "", /^api\.secrets\.token: must be a secret reference/);
        assert.match(errorsOf(section({ secrets: ["pass:a/b"] }))[0] ?? "", /^api\.secrets: must be an object that maps a variable name to a secret reference/);
    });
});

describe("reads, ad-hoc calls and the switches", () => {
    test("reads are request names", () => {
        assert.deepEqual([...found(section({ reads: ["Search orders", "Report: daily"] })).reads], ["Search orders", "Report: daily"]);
        assert.match(errorsOf(section({ reads: "Search orders" }))[0] ?? "", /^api\.reads: must be a list of at most 200 request names/);
        assert.match(errorsOf(section({ reads: [""] }))[0] ?? "", /^api\.reads: "" is not request name/);
        assert.match(errorsOf(section({ reads: [5] }))[0] ?? "", /^api\.reads: 5 is not request name/);
    });

    test("an ad-hoc environment is one that api.environments maps to, so a typo is found now", () => {
        const environments = { Staging: "staging" };
        assert.deepEqual([...found(section({ environments, adHoc: ["staging"] })).adHoc], ["staging"]);
        assert.deepEqual(errorsOf(section({ environments, adHoc: ["stagin"] })), ['api.adHoc: "stagin" is not an environment that api.environments maps to']);
        assert.deepEqual(errorsOf(section({ adHoc: ["staging"] })), ['api.adHoc: "staging" is not an environment that api.environments maps to']);
        assert.match(errorsOf(section({ environments, adHoc: "staging" }))[0] ?? "", /^api\.adHoc: must be a list/);
        assert.match(errorsOf(section({ environments, adHoc: ["9bad"] }))[0] ?? "", /^api\.adHoc: "9bad" is not environment name/);
    });

    test("timeoutSec is a whole number from 1 to 120, and allowPlainLocal is true or false", () => {
        for (const bad of [0, 121, 1.5, "30", null, -1]) {
            assert.deepEqual(errorsOf(section({ timeoutSec: bad })), ["api.timeoutSec: must be a whole number from 1 to 120"], String(bad));
        }
        for (const good of [1, 30, 120]) assert.equal(found(section({ timeoutSec: good })).timeoutSec, good);
        assert.deepEqual(errorsOf(section({ allowPlainLocal: "yes" })), ["api.allowPlainLocal: must be true or false"]);
    });
});

describe("a section with mistakes", () => {
    test("the section must be an object", () => {
        assert.deepEqual(validateApi("collections"), ["api: must be an object"]);
        assert.deepEqual(validateApi([]), ["api: must be an object"]);
        assert.deepEqual(validateApi(null), ["api: must be an object"]);
    });

    test("every mistake is reported at once, each with its key", () => {
        const errors = errorsOf({
            collections: { one: { http: 5 }, two: {} },
            environments: { Staging: "9" },
            secrets: { token: "pasted" },
            extra: 1,
        });
        assert.equal(errors.length, 5);
        for (const key of ["api.extra:", "api.collections.one.http:", "api.collections.two:", "api.environments.Staging:", "api.secrets.token:"]) {
            assert.ok(errors.some((error) => error.startsWith(key)), key);
        }
    });
});

describe("what the plugin reads from the section", () => {
    test("settingsOf gives the settings of a valid section, and reads each object once", () => {
        const raw = section({ reads: ["A"] });
        const first = settingsOf(raw);
        assert.ok(first);
        assert.equal(settingsOf(raw), first, "the same settings for the same object");
        assert.notEqual(settingsOf({ ...raw }), first, "a changed section is read again");
    });

    test("settingsOf gives nothing for an absent or an invalid section", () => {
        for (const raw of [undefined, null, "collections", 5, [], { collections: {} }, section({ timeoutSec: 0 })]) {
            assert.equal(settingsOf(raw), undefined);
        }
    });

    test("validateApi returns the errors of readApi, and none for a valid section", () => {
        assert.deepEqual(validateApi(section()), []);
        assert.deepEqual(validateApi(section({ timeoutSec: 0 })), readApi(section({ timeoutSec: 0 })).errors);
    });

    test("checking the section touches no file", () => {
        // A folder and a collection file that do not exist are still a valid section: they are read when a call needs them.
        assert.deepEqual(validateApi({ collections: { a: { http: "/no/such/folder" }, b: { postman: "/no/such/file.json" } } }), []);
    });
});
