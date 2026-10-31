// The plain variables of a test command: which names are refused (the sandbox's own list of credential-like names), how `~`
// expands, and the shell text that sets them, which is run by a real shell here so that a value is never read as code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { looksLikeCredential as sandboxLooksLikeCredential } from "../../jig-sandbox/src/env.ts";
import {
    environmentLines,
    expandedEnv,
    expandHome,
    looksLikeCredential,
    MAX_ENV_ENTRIES,
    MAX_ENV_VALUE,
    shellWord,
    validateEnv,
    withEnvironment,
} from "../src/environment.ts";

describe("which names look like credentials", () => {
    // Every name the sandbox tests list as removed or kept, and more: the two lists must say the same thing about all of them.
    const NAMES = [
        "GITHUB_TOKEN",
        "github_token",
        "NPM_TOKEN",
        "MY_SECRET",
        "DB_PASSWORD",
        "DB_PASSWD",
        "STRIPE_API_KEY",
        "SERVICE_KEY",
        "APIKEY",
        "SOME_APIKEY_VALUE",
        "REGISTRY_CREDENTIALS",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AZURE_CLIENT_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GH_HOST",
        "GITHUB_ACTIONS",
        "VAULT_ADDR",
        "KUBECONFIG",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
        "DBUS_SESSION_BUS_ADDRESS",
        "WSL_INTEROP",
        "PATH",
        "HOME",
        "LANG",
        "TERM",
        "JAVA_HOME",
        "GRADLE_OPTS",
        "MAVEN_OPTS",
        "KEYBOARD_LAYOUT",
        "MONKEY",
        "PI_SESSION_ID",
        "TMPDIR",
        "NODE_ENV",
        "CI",
        "_",
        "A1",
    ];

    test("the plugin refuses the names the sandbox takes out of an environment", () => {
        for (const name of NAMES) {
            assert.equal(looksLikeCredential(name), sandboxLooksLikeCredential(name), name);
        }
        assert.equal(looksLikeCredential("NPM_TOKEN"), true);
        assert.equal(looksLikeCredential("JAVA_HOME"), false);
    });
});

describe("validating the variables of an entry", () => {
    test("plain variables are valid", () => {
        assert.deepEqual(
            validateEnv({ JAVA_HOME: "~/.sdkman/candidates/java/17", GRADLE_OPTS: "-Xmx2g -Dx=y" }, "a"),
            [],
        );
        assert.deepEqual(validateEnv({ _X1: "", A: "multi\nline" }, "a"), []);
        assert.deepEqual(validateEnv({}, "a"), []);
    });

    test("not an object", () => {
        for (const bad of [[], "JAVA_HOME=x", 3, null]) {
            assert.match(validateEnv(bad, "workflow.tests.a")[0] ?? "", /^workflow\.tests\.a\.env: must be an object/);
        }
    });

    test("names are capital letters, digits and _, and not a digit first", () => {
        for (const name of ["java_home", "1A", "A-B", "A B", "", "JAVA.HOME", "É"]) {
            const errors = validateEnv({ [name]: "x" }, "workflow.tests.a");
            assert.equal(errors.length, 1, JSON.stringify(name));
            assert.match(errors[0] ?? "", /^workflow\.tests\.a\.env: .* is not a variable name/, JSON.stringify(name));
        }
    });

    test("a name that looks like a credential is refused, with the way to give it properly", () => {
        for (const name of ["NPM_TOKEN", "DB_PASSWORD", "AWS_PROFILE", "GITHUB_ACTIONS", "KUBECONFIG", "MY_API_KEY"]) {
            assert.deepEqual(validateEnv({ [name]: "x" }, "workflow.tests.a"), [
                `workflow.tests.a.env.${name}: this name looks like a credential, and credentials belong in a secret reference, not here`,
            ]);
        }
    });

    test("values are text without NUL, and not longer than the question can show", () => {
        assert.deepEqual(validateEnv({ A: 3 }, "x"), ["x.env.A: must be text"]);
        assert.deepEqual(validateEnv({ A: null }, "x"), ["x.env.A: must be text"]);
        assert.deepEqual(validateEnv({ A: "a\u0000b" }, "x"), ["x.env.A: must not contain a NUL character"]);
        assert.deepEqual(validateEnv({ A: "x".repeat(MAX_ENV_VALUE) }, "x"), []);
        assert.deepEqual(validateEnv({ A: "x".repeat(MAX_ENV_VALUE + 1) }, "x"), [
            `x.env.A: at most ${MAX_ENV_VALUE} characters`,
        ]);
    });

    test("at most twenty variables", () => {
        const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`V${n}`, "x"]));
        assert.deepEqual(validateEnv(many(MAX_ENV_ENTRIES), "x"), []);
        assert.deepEqual(validateEnv(many(MAX_ENV_ENTRIES + 1), "x"), [`x.env: at most ${MAX_ENV_ENTRIES} variables`]);
    });

    test("every problem is listed, not only the first", () => {
        assert.equal(validateEnv({ lower: "x", NPM_TOKEN: "y", OK: 1 }, "x").length, 3);
    });
});

describe("~ in a value", () => {
    test("is the home folder at the start, and after a colon in a list; elsewhere it is a character", () => {
        assert.equal(expandHome("~/.sdkman/java", "/home/me"), "/home/me/.sdkman/java");
        assert.equal(expandHome("~", "/home/me"), "/home/me");
        assert.equal(
            expandHome("~/bin:/usr/bin:~/.local/bin", "/home/me"),
            "/home/me/bin:/usr/bin:/home/me/.local/bin",
        );
        assert.equal(expandHome("~root/x", "/home/me"), "~root/x");
        assert.equal(expandHome("a~/b", "/home/me"), "a~/b");
        assert.equal(expandHome("http://example.com/~x", "/home/me"), "http://example.com/~x");
        assert.equal(expandHome("", "/home/me"), "");
    });

    test("a whole entry, in the order written", () => {
        assert.deepEqual(expandedEnv({ B: "~/b", A: "x" }, "/home/me"), { B: "/home/me/b", A: "x" });
        assert.deepEqual(Object.keys(expandedEnv({ B: "~/b", A: "x" }, "/home/me")), ["B", "A"]);
    });
});

describe("the shell text that sets them", () => {
    test("a word with nothing special is left alone, anything else is quoted", () => {
        assert.equal(shellWord("/home/me/.sdkman/java-17"), "/home/me/.sdkman/java-17");
        assert.equal(shellWord("a b"), "'a b'");
        assert.equal(shellWord(""), "''");
        assert.equal(shellWord("it's"), "'it'\\''s'");
        assert.equal(shellWord("~/x"), "'~/x'", "a tilde that is still there is not expanded by the shell");
    });

    test("no variables: the command as it is; some: exported first, in the order written", () => {
        assert.equal(withEnvironment("npm test", undefined), "npm test");
        assert.equal(withEnvironment("npm test", {}), "npm test");
        assert.equal(
            withEnvironment("./gradlew test", { JAVA_HOME: "/opt/jdk-17", GRADLE_OPTS: "-Xmx2g -Dx=y" }),
            "export JAVA_HOME=/opt/jdk-17 GRADLE_OPTS='-Xmx2g -Dx=y' && ./gradlew test",
        );
    });

    test("a real shell reads every value as text, whatever it holds", () => {
        const values = [
            "plain",
            "a b",
            "it's",
            'say "hi"',
            "$HOME",
            "$(echo pwned)",
            "`echo pwned`",
            "a;b&c|d",
            "back\\slash",
            "new\nline",
            "*",
            "~",
            "#x",
            "",
        ];
        for (const value of values) {
            const out = execFileSync("/bin/sh", ["-c", withEnvironment('printf %s "$V"', { V: value })], {
                encoding: "utf8",
                env: { PATH: process.env.PATH ?? "", HOME: "/nowhere" },
            });
            assert.equal(out, value, JSON.stringify(value));
        }
    });

    test("the variables reach every part of a command with && in it", () => {
        const out = execFileSync("/bin/sh", ["-c", withEnvironment('printf %s "$A" && printf %s "$A"', { A: "x" })], {
            encoding: "utf8",
        });
        assert.equal(out, "xx");
    });
});

describe("the lines in a question", () => {
    test("none without variables, one line with them, and a control character is made visible", () => {
        assert.deepEqual(environmentLines(undefined), []);
        assert.deepEqual(environmentLines({}), []);
        assert.deepEqual(environmentLines({ JAVA_HOME: "/opt/jdk", X: "a\rb" }), [
            "    with JAVA_HOME=/opt/jdk X=a\\x0db",
        ]);
    });
});
