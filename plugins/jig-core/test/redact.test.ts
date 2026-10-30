// Redaction: resolved secret values and their encodings, secret-shaped strings, and deep structures.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRedactor, mapStrings, RedactionError, REDACTED, secretForms } from "../src/redact.ts";

// Test tokens are built from pieces, so no complete token-looking string sits in the source.
const GITHUB_CLASSIC = ["ghp", "_", "A1b2".repeat(9)].join("");
const GITHUB_OAUTH = ["gho", "_", "Z9y8".repeat(9)].join("");
const GITHUB_FINE = ["github", "_pat_", "11ABCDEFG0".repeat(8)].join("");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const AWS_TEMP = ["ASIA", "IOSFODNN7EXAMPLE"].join("");
const SLACK_BOT = ["xox", "b-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"].join("");
const SLACK_APP = ["xapp", "-1-A0123456789-1234567890123-", "ab12cd34ef56ab12cd34ef56"].join("");
const JWT = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const PEM = (kind: string) => [`-----BEGIN ${kind}PRIVATE KEY-----`, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu", `-----END ${kind}PRIVATE KEY-----`].join("\n");

describe("secret values", () => {
    test("a registered value is removed wherever it appears", () => {
        const redactor = createRedactor();
        redactor.register("s3cr3t-value");
        assert.equal(redactor.text("token=s3cr3t-value and again s3cr3t-value."), `token=${REDACTED} and again ${REDACTED}.`);
        assert.equal(redactor.text("nothing to hide"), "nothing to hide");
        assert.equal(redactor.count(), 1);
    });

    test("nothing is removed before the value is registered", () => {
        const redactor = createRedactor();
        assert.equal(redactor.text("s3cr3t-value"), "s3cr3t-value");
        redactor.register("s3cr3t-value");
        assert.equal(redactor.text("s3cr3t-value"), REDACTED);
    });

    test("an empty value is ignored, and the same value twice counts once", () => {
        const redactor = createRedactor();
        redactor.register("");
        redactor.register("abc12345");
        redactor.register("abc12345");
        assert.equal(redactor.count(), 1);
        assert.equal(redactor.text("plain text"), "plain text");
    });

    test("a longer value that contains a shorter one is removed whole", () => {
        const redactor = createRedactor();
        redactor.register("pass");
        redactor.register("password-123");
        assert.equal(redactor.text("x password-123 y"), `x ${REDACTED} y`);
    });

    test("characters that mean something in a pattern are plain characters", () => {
        const redactor = createRedactor();
        redactor.register("a.b*c+(d)[e]{f}|g^h$i\\j");
        assert.equal(redactor.text("see a.b*c+(d)[e]{f}|g^h$i\\j here"), `see ${REDACTED} here`);
        assert.equal(redactor.text("axb"), "axb");
    });

    test("the marker is never scanned again, even for a value that appears inside it", () => {
        const redactor = createRedactor();
        redactor.register("red");
        redactor.register("act");
        assert.equal(redactor.text("a red act"), `a ${REDACTED} ${REDACTED}`);
    });
});

describe("the forms a secret can take", () => {
    // Bytes chosen so that base64 contains both + and /, which base64url writes differently.
    const secret = "p@ss/w0rd+?>>~ \"quoted\" \\ and\nnewline";

    test("the list holds the value, JSON text, base64, base64url, URL encoding and hex", () => {
        const bytes = Buffer.from(secret, "utf8");
        const forms = secretForms(secret);
        for (const expected of [
            secret,
            JSON.stringify(secret).slice(1, -1),
            bytes.toString("base64"),
            bytes.toString("base64").replace(/=+$/, ""),
            bytes.toString("base64url"),
            encodeURIComponent(secret),
            bytes.toString("hex"),
            bytes.toString("hex").toUpperCase(),
        ]) {
            assert.ok(forms.includes(expected), expected);
        }
        assert.ok(bytes.toString("base64").includes("+") || bytes.toString("base64").includes("/") || bytes.toString("base64url") !== bytes.toString("base64"));
    });

    test("each form is removed from text", () => {
        const redactor = createRedactor();
        redactor.register(secret);
        const bytes = Buffer.from(secret, "utf8");
        for (const form of [
            secret,
            JSON.stringify({ k: secret }),
            bytes.toString("base64"),
            bytes.toString("base64url"),
            encodeURIComponent(secret),
            bytes.toString("hex"),
            bytes.toString("hex").toUpperCase(),
        ]) {
            const cleaned = redactor.text(`prefix ${form} suffix`);
            assert.ok(!cleaned.includes(form.slice(0, 12)) || form.length < 12, `${form} -> ${cleaned}`);
            assert.ok(cleaned.includes(REDACTED), form);
        }
    });

    test("a form shows up in the output of a tool that echoes a header or a URL", () => {
        const redactor = createRedactor();
        redactor.register("tok-0123456789");
        const base64 = Buffer.from("tok-0123456789").toString("base64");
        assert.equal(redactor.text(`Authorization: Bearer ${base64}`), `Authorization: Bearer ${REDACTED}`);
        redactor.register("a b&c=d");
        assert.equal(redactor.text("GET /x?key=a%20b%26c%3Dd HTTP/1.1"), `GET /x?key=${REDACTED} HTTP/1.1`);
    });
});

describe("secret shapes nobody registered", () => {
    const redactor = createRedactor();
    const cases: Array<[string, string]> = [
        ["a classic GitHub token", GITHUB_CLASSIC],
        ["a GitHub OAuth token", GITHUB_OAUTH],
        ["a fine-grained GitHub token", GITHUB_FINE],
        ["an AWS access key id", AWS_KEY],
        ["an AWS temporary key id", AWS_TEMP],
        ["a Slack bot token", SLACK_BOT],
        ["a Slack app token", SLACK_APP],
        ["a JWT", JWT],
        ["a private key block", PEM("")],
        ["an RSA private key block", PEM("RSA ")],
        ["an OpenSSH private key block", PEM("OPENSSH ")],
    ];
    for (const [name, token] of cases) {
        test(`${name} is removed from the middle of a sentence`, () => {
            assert.equal(redactor.text(`before ${token} after`), `before ${REDACTED} after`);
        });
    }

    test("a private key block cut short, with no END line, is removed to the end of the text", () => {
        const cut = ["before", "-----BEGIN " + "PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"].join("\n");
        assert.equal(redactor.text(cut), `before\n${REDACTED}`);
    });

    test("text that only looks a little like a secret is left alone", () => {
        for (const text of [
            "ghp_short", "github_pat_short", "AKIA is a prefix", "AKIAlowercase1234567890", "eyJhbGciOiJIUzI1NiJ9 alone",
            "xoxb- nothing", "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----", "a normal sentence, with 123456 numbers",
        ]) {
            assert.equal(redactor.text(text), text);
        }
    });

    test("several in one text, each removed", () => {
        assert.equal(redactor.text(`${GITHUB_CLASSIC} ${AWS_KEY}`), `${REDACTED} ${REDACTED}`);
    });
});

describe("deep structures", () => {
    const redactor = createRedactor();
    redactor.register("hush-hush-1");

    test("every string at every depth, in objects and arrays", () => {
        const input = { a: "x hush-hush-1", list: ["hush-hush-1", { deep: [{ deeper: "z hush-hush-1 z" }] }], n: 3, flag: true, nothing: null };
        const output = redactor.value(input);
        assert.deepEqual(output, { a: `x ${REDACTED}`, list: [REDACTED, { deep: [{ deeper: `z ${REDACTED} z` }] }], n: 3, flag: true, nothing: null });
    });

    test("does not change the input", () => {
        const input = { a: "hush-hush-1", list: ["hush-hush-1"] };
        redactor.value(input);
        assert.deepEqual(input, { a: "hush-hush-1", list: ["hush-hush-1"] });
    });

    test("object keys too, and two keys that become the same name both stay", () => {
        const output = redactor.value({ "hush-hush-1": 1, "hush-hush-1 ": 2 }) as Record<string, number>;
        assert.deepEqual(Object.values(output).sort(), [1, 2]);
        assert.ok(Object.keys(output).every((key) => !key.includes("hush")));
    });

    test("values that are not plain data are left as they are", () => {
        const date = new Date(0);
        const bytes = Buffer.from("hush-hush-1");
        const output = redactor.value({ date, bytes, big: 10n, none: undefined }) as Record<string, unknown>;
        assert.equal(output.date, date);
        assert.equal(output.bytes, bytes);
        assert.equal(output.big, 10n);
        assert.equal(output.none, undefined);
    });

    test("a structure that refers to itself, or is far too deep, is refused rather than passed through", () => {
        const loop: Record<string, unknown> = { text: "hush-hush-1" };
        loop.self = loop;
        assert.throws(() => redactor.value(loop), RedactionError);
        let deep: unknown = "hush-hush-1";
        for (let i = 0; i < 500; i++) deep = [deep];
        assert.throws(() => redactor.value(deep), RedactionError);
    });

    test("the same object used twice (not a loop) is fine", () => {
        const shared = { text: "hush-hush-1" };
        assert.deepEqual(redactor.value({ a: shared, b: shared }), { a: { text: REDACTED }, b: { text: REDACTED } });
    });

    test("structures that hold a secret shape are redacted too", () => {
        assert.deepEqual(redactor.value({ headers: { authorization: `token ${GITHUB_CLASSIC}` } }), { headers: { authorization: `token ${REDACTED}` } });
    });
});

describe("mapStrings", () => {
    test("applies a change to every string and nothing else", () => {
        assert.deepEqual(mapStrings({ a: "x", b: [1, "y"] }, (text) => text.toUpperCase()), { A: "X", B: [1, "Y"] });
    });
});
