// Variable resolution, on its own: the order values come in (the agent's, the environment's, the request's own, the
// collection's), secrets from references only, how the agent's values are written where they land, and what is refused.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SecretSource } from "../src/config.ts";
import { displayOf } from "../src/engine/text.ts";
import type { Text } from "../src/engine/text.ts";
import { InputError } from "../src/engine/values.ts";
import type { Collection, Environment, SavedRequest, Variable } from "../src/model.ts";
import { agentValues, createResolver, secretNamesOf } from "../src/resolve.ts";
import type { Slot } from "../src/resolve.ts";

const plain = (value: string): Variable => ({ value, secret: false });
const secret: Variable = { value: "", secret: true };

function request(variables: string[], extra: Partial<SavedRequest> = {}): SavedRequest {
    return {
        collection: "c",
        folder: [],
        name: "R",
        origin: "c.json: R",
        method: "GET",
        url: "https://a.example.test/",
        headers: [],
        auth: { kind: "none" },
        variables,
        secrets: [],
        signsIn: [],
        defaults: new Map(),
        scripts: { prerequest: false },
        notes: [],
        ...extra,
    };
}

interface Setup {
    environment?: Record<string, Variable>;
    collection?: Record<string, Variable>;
    defaults?: Record<string, string>;
    secrets?: Record<string, SecretSource>;
    agent?: Record<string, string>;
    request?: SavedRequest;
}

function resolver(setup: Setup = {}) {
    const environment: Environment = {
        name: "Staging",
        file: "e.json",
        variables: new Map(Object.entries(setup.environment ?? {})),
    };
    const collection: Collection = {
        name: "c",
        root: "/work",
        requests: [],
        environments: new Map([["Staging", environment]]),
        variables: new Map(Object.entries(setup.collection ?? {})),
        auth: { kind: "none" },
        problems: [],
    };
    const base = setup.request ?? request([]);
    return createResolver({
        collection,
        environment,
        label: "Staging",
        secrets: new Map(Object.entries(setup.secrets ?? {})),
        agent: new Map(Object.entries(setup.agent ?? {})),
        request: { ...base, defaults: new Map(Object.entries(setup.defaults ?? {})) },
    });
}

const text = (template: string, setup: Setup = {}, slot: Slot = "plain"): string => {
    const r = resolver(setup);
    const found = r.text(template, slot);
    r.finish();
    return displayOf(found);
};
/** The call throws an InputError, a TypeError, whose message matches. */
function throwsInput(work: () => unknown, pattern: RegExp, what = ""): void {
    assert.throws(
        work,
        (error: unknown) => error instanceof InputError && error instanceof TypeError && pattern.test(error.message),
        what,
    );
}
const refused = (template: string, setup: Setup, pattern: RegExp, slot: Slot = "plain"): void =>
    assert.throws(
        () => text(template, setup, slot),
        (error: unknown) => error instanceof InputError && error instanceof TypeError && pattern.test(error.message),
        template,
    );

describe("the order of values", () => {
    test("the agent's, then the environment's, then the request's own, then the collection's", () => {
        const all = {
            agent: { v: "agent" },
            environment: { v: plain("environment") },
            defaults: { v: "request" },
            collection: { v: plain("collection") },
        };
        assert.equal(text("{{v}}", all), "agent");
        assert.equal(text("{{v}}", { ...all, agent: {} }), "environment");
        assert.equal(text("{{v}}", { ...all, agent: {}, environment: {} }), "request");
        assert.equal(text("{{v}}", { ...all, agent: {}, environment: {}, defaults: {} }), "collection");
    });

    test("a variable with no value anywhere is invalid input, and every missing one is named at once", () => {
        const r = resolver();
        r.text("{{a}} {{b}} {{a}} {{c}}", "plain");
        assert.throws(
            () => r.finish(),
            (error: unknown) =>
                error instanceof InputError &&
                error.message ===
                    "no value for a, b, c in Staging: pass the ones the request uses in variables, or define them in the environment",
        );
    });

    test("text around the variables is kept, a variable may be used twice, and white space inside the braces does not matter", () => {
        assert.equal(text("x{{ a }}y{{a}}z{{  b}}", { environment: { a: plain("1"), b: plain("2") } }), "x1y1z2");
        assert.equal(text("no variables at all", {}), "no variables at all");
        assert.equal(text("{ not } {{ }} {{}} {single}", {}), "{ not } {{ }} {{}} {single}");
    });

    test("a value is not read again: what the agent gives, even {{token}}, stays text", () => {
        assert.equal(
            text("{{note}}", {
                agent: { note: "{{token}} and {{$uuid}}" },
                secrets: { token: { everywhere: "pass:a/b", byEnvironment: new Map() } },
                request: request(["note"]),
            }),
            "{{token}} and {{$uuid}}",
        );
    });
});

describe("values that refer to values", () => {
    test("an environment value may use other variables, from the environment, the request's own and the collection", () => {
        const setup = {
            environment: { url: plain("{{scheme}}://{{host}}/{{version}}"), host: plain("a.example.test") },
            defaults: { scheme: "https" },
            collection: { version: plain("v1") },
        };
        assert.equal(text("{{url}}/x", setup), "https://a.example.test/v1/x");
    });

    test("the agent's values are not offered to them: a value of the environment never changes because the agent gave something", () => {
        const setup = {
            environment: { url: plain("https://{{host}}/x"), host: plain("a.example.test") },
            agent: { host: "evil.example.test" },
            request: request(["url", "host"]),
        };
        assert.equal(text("{{url}}", setup), "https://a.example.test/x");
    });

    test("a variable that refers to itself, directly or in a ring, is refused", () => {
        refused("{{a}}", { environment: { a: plain("{{a}}") } }, /^a refers to itself$/);
        refused(
            "{{a}}",
            { environment: { a: plain("{{b}}"), b: plain("{{c}}"), c: plain("{{a}}") } },
            /^a refers to itself$/,
        );
        const deep = Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [`v${index}`, plain(`{{v${index + 1}}}`)]),
        );
        refused("{{v0}}", { environment: { ...deep, v12: plain("end") } }, /refers to itself/);
    });
});

describe("secrets", () => {
    const setup = (extra: Setup = {}): Setup => ({
        environment: { token: secret },
        secrets: { token: { everywhere: "pass:orders/token", byEnvironment: new Map() } },
        request: request(["token"], { secrets: ["token"] }),
        ...extra,
    });

    test("come from references only: the text holds the secret by name and reference, and no value", () => {
        const r = resolver(setup());
        const found: Text = r.text("Bearer {{token}}", "header");
        r.finish();
        assert.deepEqual(found, ["Bearer ", { secret: "token", reference: "pass:orders/token" }]);
        assert.equal(displayOf(found), "Bearer {{token}}");
    });

    test("a name in api.secrets is a secret whatever the files say, and its value in a file is not used", () => {
        const found = resolver({
            environment: { token: plain("plain-from-the-file") },
            secrets: { token: { everywhere: "pass:a/b", byEnvironment: new Map() } },
        }).text("{{token}}", "plain");
        assert.deepEqual(found, [{ secret: "token", reference: "pass:a/b" }]);
        const collection = resolver({
            collection: { token: plain("plain-from-the-collection") },
            secrets: { token: { everywhere: "pass:a/b", byEnvironment: new Map() } },
        }).text("{{token}}", "plain");
        assert.deepEqual(collection, [{ secret: "token", reference: "pass:a/b" }]);
    });

    test("a reference may be per environment, and the one for another environment is not used", () => {
        const byEnvironment = (map: Record<string, string>): SecretSource => ({
            byEnvironment: new Map(Object.entries(map)),
        });
        assert.deepEqual(
            resolver(setup({ secrets: { token: byEnvironment({ Staging: "pass:s", Production: "pass:p" }) } })).text(
                "{{token}}",
                "plain",
            ),
            [{ secret: "token", reference: "pass:s" }],
        );
        refused(
            "{{token}}",
            setup({ secrets: { token: byEnvironment({ Production: "pass:p" }) } }),
            /^token is a secret, but api\.secrets has no reference for it in Staging$/,
        );
        assert.deepEqual(
            resolver(
                setup({
                    secrets: { token: { everywhere: "pass:all", byEnvironment: new Map([["Production", "pass:p"]]) } },
                }),
            ).text("{{token}}", "plain"),
            [{ secret: "token", reference: "pass:all" }],
            "the one for every environment is the default",
        );
    });

    test("a secret that the files declare and the configuration has no reference for stops the request, all of them named", () => {
        refused(
            "{{a}} {{b}} {{c}}",
            { environment: { a: secret, b: secret, c: plain("x") } },
            /^a, b are secrets, but api\.secrets has no reference for them in Staging$/,
        );
        refused(
            "{{a}}",
            { environment: { a: secret } },
            /^a is a secret, but api\.secrets has no reference for it in Staging$/,
        );
    });

    test("a secret inside a value of the environment is a secret too", () => {
        const found = resolver(setup({ environment: { token: secret, header: plain("Bearer {{token}}") } })).text(
            "{{header}}",
            "plain",
        );
        assert.deepEqual(found, ["Bearer ", { secret: "token", reference: "pass:orders/token" }]);
    });

    test("is written the way its place needs it when it is sent: inside a JSON string, or URL-encoded", () => {
        const json = resolver(setup()).text('{"password": "{{token}}", "n": {{token}}}', "json");
        assert.deepEqual(json, [
            '{"password": "',
            { secret: "token", reference: "pass:orders/token", as: "json" },
            '", "n": ',
            { secret: "token", reference: "pass:orders/token" },
            "}",
        ]);
        assert.deepEqual(resolver(setup()).text("{{token}}", "form"), [
            { secret: "token", reference: "pass:orders/token", as: "form" },
        ]);
    });

    test("the names of the secrets of a collection are the declared ones, the configured ones, and those of its requests", () => {
        const environment: Environment = {
            name: "S",
            file: "e.json",
            variables: new Map([
                ["a", secret],
                ["b", plain("x")],
            ]),
        };
        const collection: Collection = {
            name: "c",
            root: "/",
            requests: [request([], { secrets: ["d"] })],
            environments: new Map([["S", environment]]),
            variables: new Map(),
            auth: { kind: "none" },
            problems: [],
        };
        assert.deepEqual([...secretNamesOf(collection, new Map([["c", { byEnvironment: new Map() }]]))].sort(), [
            "a",
            "c",
            "d",
        ]);
    });
});

describe("generated values", () => {
    test("$uuid, $timestamp and $isoTimestamp stay marks until the request is sent, and $guid is $uuid", () => {
        const found = resolver().text("{{$uuid}} {{$guid}} {{$timestamp}} {{$isoTimestamp}}", "plain");
        assert.deepEqual(found, [
            { generated: "uuid" },
            " ",
            { generated: "uuid" },
            " ",
            { generated: "timestamp" },
            " ",
            { generated: "isoTimestamp" },
        ]);
        assert.equal(displayOf(found), "{{$uuid}} {{$uuid}} {{$timestamp}} {{$isoTimestamp}}");
    });

    test("any other is refused", () => {
        refused(
            "{{$randomInt}}",
            {},
            /^\{\{\$randomInt\}\} is not supported \(only \$uuid, \$timestamp and \$isoTimestamp are made here\)$/,
        );
    });
});

describe("what the agent gives is written as a value", () => {
    const agent = (value: string, template: string, slot: Slot): string =>
        text(template, { agent: { v: value }, request: request(["v"]) }, slot);

    test("in a JSON string: quotes, backslashes and line ends are escaped", () => {
        assert.equal(agent('a"b\\c\nd ', '{"k": "{{v}}"}', "json"), '{"k": "a\\"b\\\\c\\nd "}');
        assert.deepEqual(JSON.parse(agent('x", "admin": "true', '{"k": "{{v}}"}', "json")), {
            k: 'x", "admin": "true',
        });
    });

    test("outside a JSON string: a number, true, false or null, and nothing that adds structure", () => {
        for (const value of ["1", "-2.5", "1e3", "true", "false", "null"])
            assert.equal(agent(value, '{"k": {{v}}}', "json"), `{"k": ${value}}`);
        for (const value of ["1, 2", '"a"', "{}", "[1]", "yes", ""])
            refused(
                '{"k": {{v}}}',
                { agent: { v: value }, request: request(["v"]) },
                /sits outside a string in a JSON body, so its value must be a number, true, false or null/,
                "json",
            );
    });

    test("a JSON string is tracked through escapes and across variables", () => {
        assert.equal(agent('"', '{"a": "x\\"{{v}}"}', "json"), '{"a": "x\\"\\""}');
        const setup = { agent: { v: '"' }, environment: { w: plain("1") }, request: request(["v", "w"]) };
        assert.equal(text('{"a": "{{w}}", "b": "{{v}}"}', setup, "json"), '{"a": "1", "b": "\\""}');
    });

    test("in a URL-encoded form: percent-encoded", () => {
        assert.equal(agent("a b&c=d/é", "x={{v}}", "form"), "x=a%20b%26c%3Dd%2F%C3%A9");
    });

    test("in XML or HTML: escaped", () => {
        assert.equal(
            agent(`<a b="c" d='e'>&`, "<n>{{v}}</n>", "xml"),
            "<n>&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;</n>",
        );
    });

    test("in a header: printable ASCII only", () => {
        assert.equal(agent("abc 123 ~!", "{{v}}", "header"), "abc 123 ~!");
        for (const value of ["a\tb", "é", "a\u007fb"])
            refused(
                "{{v}}",
                { agent: { v: value }, request: request(["v"]) },
                /goes into a header, so it must be printable ASCII/,
                "header",
            );
    });

    test("in a GraphQL query: a plain token only", () => {
        assert.equal(agent("OPEN", "{ orders(status: {{v}}) { id } }", "graphql"), "{ orders(status: OPEN) { id } }");
        assert.equal(agent("a.b-c_d:e@f+g 1", "{{v}}", "graphql"), "a.b-c_d:e@f+g 1");
        for (const value of ["a) { b", 'a"', "a$b", "a{b}", "a\nb", "a".repeat(201)])
            refused("{{v}}", { agent: { v: value }, request: request(["v"]) }, /goes into a GraphQL query/, "graphql");
    });

    test("in plain text: as it is", () => {
        assert.equal(agent('He said "hi"\n{{x}}', "{{v}}", "plain"), 'He said "hi"\n{{x}}');
    });
});

describe("addresses", () => {
    const address = (template: string, setup: Setup = {}) => {
        const r = resolver(setup);
        const found = r.address(template);
        r.finish();
        return found;
    };

    test("the address, its scheme and host, and whether a variable gave them", () => {
        const found = address("{{base}}/orders/{{id}}?q={{q}}", {
            environment: { base: plain("https://api.example.test:8443/v1") },
            agent: { id: "7", q: "a b" },
            request: request(["id", "q"]),
        });
        assert.deepEqual(found, {
            url: "https://api.example.test:8443/v1/orders/7?q=a%20b",
            origin: "https://api.example.test:8443",
            fromVariables: true,
        });
        assert.equal(
            address("https://a.example.test/x/{{id}}", { environment: { id: plain("1") } }).fromVariables,
            false,
            "the host is written out",
        );
        assert.equal(
            address("https://{{host}}/x", { environment: { host: plain("a.example.test") } }).fromVariables,
            true,
        );
    });

    test("the agent's values are encoded, as one segment: nothing in them can end the host, the path or the query", () => {
        const found = address("https://a.example.test/{{v}}", {
            agent: { v: "x/../y?z=1#f@h:80" },
            request: request(["v"]),
        });
        assert.equal(found.url, "https://a.example.test/x%2F..%2Fy%3Fz%3D1%23f%40h%3A80");
        throwsInput(
            () => address("https://a.example.test/{{v}}", { agent: { v: ".." }, request: request(["v"]) }),
            /^v cannot be \. or \.\. in an address$/,
        );
    });

    test("a variable of the agent's anywhere in the scheme or the host is refused, whatever the shape", () => {
        const r =
            (template: string, name = "v") =>
            () =>
                address(template, {
                    agent: { [name]: "evil.example.test" },
                    environment: { base: plain("https://a.example.test") },
                    request: request([name, "base"]),
                });
        assert.throws(r("https://{{v}}/x"), /v would set the host/);
        assert.throws(r("https://a.example.test{{v}}/x"), /v would set the host/);
        assert.throws(r("https://a.{{v}}/x"), /v would set the host/);
        assert.throws(r("https://a.example.test:{{v}}/x"), /v would set the host/);
        assert.throws(r("{{v}}/x"), /v would set the host/);
        assert.throws(r("{{v}}://a.example.test/x"), /v would set the host/);
        assert.doesNotThrow(r("{{base}}/{{v}}"));
        assert.doesNotThrow(r("{{base}}?x={{v}}"));
    });

    test("a secret or a generated value cannot be in an address", () => {
        const secrets = { token: { everywhere: "pass:a/b", byEnvironment: new Map() } };
        assert.throws(
            () => address("https://a.example.test/?key={{token}}", { environment: { token: secret }, secrets }),
            /token is a secret or a generated value, and an address would show it/,
        );
        assert.throws(() => address("https://a.example.test/{{$uuid}}"), /\$uuid is a secret or a generated value/);
    });

    test("an address that has no scheme once its variables are filled in is refused", () => {
        throwsInput(
            () => address("{{host}}/x", { environment: { host: plain("a.example.test") } }),
            /^the address must start with https:\/\/ \(or http:\/\/\) once its variables are filled in; it starts "a\.example\.test\/x"$/,
        );
    });

    test("origin works out the host without the rest, and gives up when a variable of the host is missing", () => {
        const r = resolver({ environment: { base: plain("https://a.example.test") } });
        assert.deepEqual(r.origin("{{base}}/orders/{{id}}"), {
            url: "https://a.example.test/orders/",
            origin: "https://a.example.test",
            fromVariables: true,
        });
        assert.equal(resolver().origin("{{base}}/orders"), undefined);
        assert.equal(resolver().origin("not an address"), undefined);
    });
});

describe("the agent's values, checked", () => {
    const names = new Set(["token"]);

    test("each must be a variable the request uses", () => {
        const r = request(["baseUrl", "id", "token"]);
        assert.deepEqual([...agentValues(r, { id: "1" }, names)], [["id", "1"]]);
        throwsInput(
            () => agentValues(r, { other: "1" }, names),
            /^"other" is not a variable of R; it uses baseUrl, id, token$/,
        );
        throwsInput(
            () => agentValues(request([]), { other: "1" }, names),
            /^"other" is not a variable of R; it uses none$/,
        );
        assert.throws(() => agentValues(request(["$uuid"]), { $uuid: "1" }, names), /not a variable of R/);
    });

    test("never a secret or a variable that fills a sign-in", () => {
        const r = request(["id", "token", "user", "other"], { secrets: ["other"], signsIn: ["user"] });
        for (const name of ["token", "user", "other"]) {
            assert.throws(
                () => agentValues(r, { [name]: "x" }, names),
                /is a secret or fills the sign-in, so it comes from the environment and api\.secrets, not from the call/,
                name,
            );
        }
    });

    test("a value is text, a number or true or false, short, and has no control characters; null and undefined mean none", () => {
        const r = request(["a"]);
        assert.deepEqual([...agentValues(r, { a: 5 }, names)], [["a", "5"]]);
        assert.deepEqual([...agentValues(r, { a: true }, names)], [["a", "true"]]);
        assert.deepEqual([...agentValues(r, { a: null, b: undefined } as never, names)], []);
        assert.deepEqual([...agentValues(r, undefined, names)], []);
        for (const value of [{}, [], () => 1])
            assert.throws(() => agentValues(r, { a: value }, names), /must be text, a number or true or false/);
        for (const value of ["a".repeat(2001), "a\u0000b", "a\u001fb"])
            assert.throws(
                () => agentValues(r, { a: value }, names),
                /at most 2000 characters with no control characters/,
            );
        assert.deepEqual(
            [...agentValues(r, { a: "line\nbreak\ttab\r" }, names)],
            [["a", "line\nbreak\ttab\r"]],
            "a line end and a tab are text",
        );
    });
});
