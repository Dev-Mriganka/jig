// The `workflow` section of jig.json: what is accepted, what is refused with the key named, and the defaults.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_TEST_TIMEOUT_SECONDS, settingsFrom, validateWorkflow } from "../src/config.ts";

describe("validating the section", () => {
    test("an empty section, and a full one, are valid", () => {
        assert.deepEqual(validateWorkflow({}), []);
        assert.deepEqual(
            validateWorkflow({
                folders: ["/srv/workflows", "~/work/workflows"],
                tests: { "orders-api": "./gradlew test", "libs/*": { command: "npm test", timeoutSeconds: 300 } },
                testTimeoutSeconds: 1200,
            }),
            [],
        );
    });

    test("a section that is not an object", () => {
        assert.deepEqual(validateWorkflow("x"), ["workflow: must be an object"]);
        assert.deepEqual(validateWorkflow([]), ["workflow: must be an object"]);
    });

    test("a misspelt field is an error, not a silent default", () => {
        assert.deepEqual(validateWorkflow({ folder: [] }), ["workflow.folder: unknown field"]);
    });

    test("folders: a list of absolute paths or ~/ paths", () => {
        assert.match(validateWorkflow({ folders: "/x" })[0] ?? "", /^workflow.folders: must be a list/);
        assert.match(
            validateWorkflow({ folders: ["relative/dir"] })[0] ?? "",
            /^workflow.folders\[0\]: use an absolute path/,
        );
        assert.match(validateWorkflow({ folders: [3] })[0] ?? "", /^workflow.folders\[0\]/);
    });

    test("tests: a command, or an object with a command and a timeout, by key", () => {
        assert.match(validateWorkflow({ tests: [] })[0] ?? "", /^workflow.tests: must be an object/);
        assert.match(validateWorkflow({ tests: { a: "" } })[0] ?? "", /^workflow.tests.a: must be a command/);
        assert.match(validateWorkflow({ tests: { a: 3 } })[0] ?? "", /^workflow.tests.a: must be a command/);
        assert.match(validateWorkflow({ tests: { a: "x\ny" } })[0] ?? "", /^workflow.tests.a: must be a command/);
        assert.deepEqual(validateWorkflow({ tests: { a: { command: "x", shell: "zsh" } } }), [
            "workflow.tests.a.shell: unknown field",
        ]);
        assert.match(
            validateWorkflow({ tests: { a: { timeoutSeconds: 30 } } })[0] ?? "",
            /^workflow.tests.a.command: must be one line/,
        );
        assert.match(
            validateWorkflow({ tests: { a: { command: "x", timeoutSeconds: 5 } } })[0] ?? "",
            /timeoutSeconds: must be a whole number from 10 to 7200/,
        );
        assert.match(
            validateWorkflow({ tests: { a: { command: "x", timeoutSeconds: 1.5 } } })[0] ?? "",
            /timeoutSeconds/,
        );
    });

    test("env: plain variables, each problem named by its key", () => {
        assert.deepEqual(
            validateWorkflow({
                tests: { a: { command: "x", env: { JAVA_HOME: "~/.sdkman/candidates/java/17" } }, b: "y" },
            }),
            [],
        );
        assert.match(
            validateWorkflow({ tests: { a: { command: "x", env: [] } } })[0] ?? "",
            /^workflow.tests.a.env: must be/,
        );
        assert.deepEqual(validateWorkflow({ tests: { a: { command: "x", env: { NPM_TOKEN: "t" } } } }), [
            "workflow.tests.a.env.NPM_TOKEN: this name looks like a credential, and credentials belong in a secret reference, not here",
        ]);
        assert.deepEqual(validateWorkflow({ tests: { a: { command: "x", env: { java: "17" } } } }).length, 1);
        assert.deepEqual(validateWorkflow({ tests: { a: { command: "x", env: { A: 1 } } } }), [
            "workflow.tests.a.env.A: must be text",
        ]);
    });

    test("testTimeoutSeconds: a whole number of seconds from 10 to 7200", () => {
        for (const bad of [9, 7201, 1.5, "900", null]) {
            assert.match(
                validateWorkflow({ testTimeoutSeconds: bad })[0] ?? "",
                /^workflow.testTimeoutSeconds/,
                String(bad),
            );
        }
        assert.deepEqual(validateWorkflow({ testTimeoutSeconds: 10 }), []);
        assert.deepEqual(validateWorkflow({ testTimeoutSeconds: 7200 }), []);
    });
});

describe("the settings", () => {
    test("defaults when there is no section, and when it is not valid", () => {
        const defaults = { folders: [], tests: [], testTimeoutSeconds: DEFAULT_TEST_TIMEOUT_SECONDS };
        assert.deepEqual(settingsFrom(undefined), defaults);
        assert.deepEqual(settingsFrom({ folders: "no" }), defaults);
        assert.equal(DEFAULT_TEST_TIMEOUT_SECONDS, 900);
    });

    test("~/ is the home folder, test rules keep the order they were written in", () => {
        const settings = settingsFrom(
            {
                folders: ["~/work/workflows", "/srv/w"],
                tests: { "b-api": "mvn -q test", "a-*": { command: "npm test", timeoutSeconds: 60 }, c: "pytest" },
                testTimeoutSeconds: 300,
            },
            "/home/me",
        );
        assert.deepEqual(settings.folders, ["/home/me/work/workflows", "/srv/w"]);
        assert.deepEqual(settings.tests, [
            { key: "b-api", command: "mvn -q test" },
            { key: "a-*", command: "npm test", timeoutSeconds: 60 },
            { key: "c", command: "pytest" },
        ]);
        assert.equal(settings.testTimeoutSeconds, 300);
    });

    test("env: ~ is the home folder in a value, and the variables keep their order", () => {
        const settings = settingsFrom(
            {
                tests: {
                    "orders-api": {
                        command: "./gradlew test",
                        env: { JAVA_HOME: "~/.sdkman/candidates/java/17", A: "x" },
                    },
                    plain: "make",
                },
            },
            "/home/me",
        );
        assert.deepEqual(settings.tests, [
            {
                key: "orders-api",
                command: "./gradlew test",
                env: { JAVA_HOME: "/home/me/.sdkman/candidates/java/17", A: "x" },
            },
            { key: "plain", command: "make" },
        ]);
        assert.deepEqual(Object.keys(settings.tests[0]?.env ?? {}), ["JAVA_HOME", "A"]);
    });

    test("a section with a refused variable gives the defaults, as any invalid section does", () => {
        const settings = settingsFrom({ tests: { a: { command: "x", env: { GH_TOKEN: "t" } } } });
        assert.deepEqual(settings.tests, []);
    });
});
