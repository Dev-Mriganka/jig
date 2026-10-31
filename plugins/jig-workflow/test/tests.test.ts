// The test runner: which command a repository gets, where it runs (the sandbox, or a shell after the user approved), and what
// is recorded against the commit.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { settingsFrom } from "../src/config.ts";
import type { WorkflowSettings } from "../src/config.ts";
import { inspect } from "../src/repos.ts";
import type { RepoView } from "../src/repos.ts";
import { detectCommand, globToRegExp, planTests, ruleMatches, runTests, tailOf } from "../src/tests.ts";
import { commit, fakeHost, headOf, makeRepo, NOW, ok, tempFolder } from "./support.ts";

const settings = (tests: Record<string, unknown> = {}, timeout = 900): WorkflowSettings =>
    settingsFrom({ tests, testTimeoutSeconds: timeout });

describe("a pattern over a path", () => {
    test("* stays inside a folder, ** does not, ? is one character", () => {
        assert.equal(globToRegExp("libs/*").test("libs/common"), true);
        assert.equal(globToRegExp("libs/*").test("libs/common/deep"), false);
        assert.equal(globToRegExp("libs/**").test("libs/common/deep"), true);
        assert.equal(globToRegExp("lib?").test("libs"), true);
        assert.equal(globToRegExp("lib?").test("lib/"), false);
        assert.equal(globToRegExp("a.b").test("axb"), false, "a dot is a dot");
        assert.equal(globToRegExp("**/orders-*").test("/work/orders-api"), true);
    });
});

describe("which test rule names a repository", () => {
    const view = (over: Partial<RepoView> = {}): RepoView => ({
        root: "/work/orders-api-PROJ-1",
        name: "orders-api-PROJ-1",
        ...over,
    });

    test("a plain key is the folder's name, or the name origin gives", () => {
        assert.equal(ruleMatches({ key: "orders-api-PROJ-1" }, view(), "/work"), true);
        assert.equal(ruleMatches({ key: "orders-api" }, view({ remoteName: "orders-api" }), "/work"), true);
        assert.equal(ruleMatches({ key: "orders-api" }, view(), "/work"), false);
        assert.equal(
            ruleMatches({ key: "orders" }, view({ remoteName: "orders-api" }), "/work"),
            false,
            "a name is not a prefix",
        );
    });

    test("a pattern is matched over the path from Pi's folder, and over the absolute path", () => {
        assert.equal(ruleMatches({ key: "orders-*" }, view(), "/work"), true);
        assert.equal(ruleMatches({ key: "/work/orders-*" }, view(), "/elsewhere"), true);
        assert.equal(
            ruleMatches({ key: "services/*" }, view({ root: "/work/services/billing", name: "billing" }), "/work"),
            true,
        );
        assert.equal(
            ruleMatches({ key: "services/*" }, view({ root: "/work/other/billing", name: "billing" }), "/work"),
            false,
        );
        assert.equal(
            ruleMatches({ key: "../*" }, view({ root: "/other/x", name: "x" }), "/work"),
            false,
            "outside Pi's folder, only the absolute path",
        );
    });
});

describe("the default for a build file", () => {
    function inRepo(t: Parameters<typeof tempFolder>[0], files: Record<string, string>) {
        const dir = tempFolder(t);
        for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
        return dir;
    }

    test("each file, and the first row of the table wins", (t) => {
        const cases: Array<[Record<string, string>, string]> = [
            [{ gradlew: "", "build.gradle": "" }, "./gradlew test"],
            [{ "build.gradle": "" }, "gradle test"],
            [{ "build.gradle.kts": "" }, "gradle test"],
            [{ "pom.xml": "" }, "mvn -q test"],
            [{ "package.json": '{ "scripts": { "test": "node --test" } }' }, "npm test"],
            [{ "pyproject.toml": "" }, "pytest"],
            [{ "pytest.ini": "" }, "pytest"],
            [{ "tox.ini": "" }, "pytest"],
            [{ "setup.py": "" }, "pytest"],
            [{ "go.mod": "" }, "go test ./..."],
            [{ "Cargo.toml": "" }, "cargo test"],
            [{ "pom.xml": "", "package.json": '{ "scripts": { "test": "x" } }', "go.mod": "" }, "mvn -q test"],
        ];
        for (const [files, command] of cases) {
            assert.equal(detectCommand(inRepo(t, files))?.command, command, Object.keys(files).join());
        }
    });

    test("a package.json with no test script, with npm's placeholder, or broken, has no test command", (t) => {
        for (const content of [
            "{}",
            '{ "scripts": {} }',
            '{ "scripts": { "test": "echo \\"Error: no test specified\\" && exit 1" } }',
            "{ nope",
        ]) {
            assert.equal(detectCommand(inRepo(t, { "package.json": content })), undefined, content);
        }
        assert.equal(detectCommand(inRepo(t, {})), undefined);
    });

    test("the file that gave it is named", (t) => {
        assert.equal(detectCommand(inRepo(t, { "go.mod": "" }))?.file, "go.mod");
    });
});

describe("planning a repository's tests", () => {
    const view = (root: string, name = path.basename(root)): RepoView => ({ root, name });

    test("a rule in jig.json wins over the build file, with its own timeout", (t) => {
        const dir = tempFolder(t);
        writeFileSync(path.join(dir, "pom.xml"), "");
        const name = path.basename(dir);
        const plan = planTests(
            settings({ [name]: { command: "make check", timeoutSeconds: 60 } }),
            view(dir),
            path.dirname(dir),
        );
        assert.equal(plan.command, "make check");
        assert.equal(plan.timeoutSeconds, 60);
        assert.equal(plan.source, `workflow.tests "${name}"`);
    });

    test("the first rule that matches is used, in the order written", (t) => {
        const dir = tempFolder(t);
        const name = path.basename(dir);
        const plan = planTests(settings({ "*": "first", [name]: "second" }), view(dir), path.dirname(dir));
        assert.equal(plan.command, "first");
    });

    test("without a rule, the build file's default and the default timeout", (t) => {
        const dir = tempFolder(t);
        writeFileSync(path.join(dir, "go.mod"), "");
        const plan = planTests(settings({}, 300), view(dir), path.dirname(dir));
        assert.deepEqual([plan.command, plan.timeoutSeconds, plan.source], ["go test ./...", 300, "go.mod"]);
    });

    test("with neither, no command, and the problem says what to set", (t) => {
        const dir = tempFolder(t);
        const plan = planTests(settings(), view(dir), path.dirname(dir));
        assert.equal(plan.command, undefined);
        assert.match(plan.problem ?? "", /no test command is known for .*: set workflow.tests in jig.json/);
    });
});

describe("running them", () => {
    async function ready(t: Parameters<typeof tempFolder>[0], host = fakeHost()) {
        const root = makeRepo(tempFolder(t), "orders-api", "git@github.example.com:acme/orders-api.git");
        const view = await inspect(host, root);
        const plan = planTests(
            settings({ "orders-api": { command: "npm test", timeoutSeconds: 120 } }),
            view,
            path.dirname(root),
        );
        return { root, view, plan };
    }

    test("in the sandbox: the command, the folder and the time limit go to the sandbox, and the result is against the commit", async (t) => {
        const host = fakeHost({
            sandbox: () => ({ code: 0, output: "3 passing\n", timedOut: false, truncated: false }),
        });
        const { root, view, plan } = await ready(t, host);
        const run = await runTests(host, plan, view, { sandboxed: true });
        assert.deepEqual(host.sandboxed, [{ command: "npm test", cwd: root, timeoutMs: 120_000 }]);
        assert.deepEqual(host.ran, [], "nothing ran outside");
        assert.deepEqual(run.result, {
            head: headOf(root),
            clean: true,
            passed: true,
            command: "npm test",
            exitCode: 0,
            timedOut: false,
            sandboxed: true,
            at: NOW.toISOString(),
            durationMs: 0,
        });
        assert.equal(run.tail, "3 passing");
    });

    test("variables of the entry: set by the command line in the sandbox, and by the environment of a shell", async (t) => {
        const host = fakeHost({ run: () => ok() });
        const root = makeRepo(tempFolder(t), "orders-api", "git@github.example.com:acme/orders-api.git");
        const view = await inspect(host, root);
        const plan = planTests(
            settingsFrom({
                tests: {
                    "orders-api": {
                        command: "./gradlew test",
                        env: { JAVA_HOME: "/opt/jdk-17", GRADLE_OPTS: "-Xmx2g -Dx=y" },
                    },
                },
            }),
            view,
            path.dirname(root),
        );
        assert.deepEqual(plan.env, { JAVA_HOME: "/opt/jdk-17", GRADLE_OPTS: "-Xmx2g -Dx=y" });
        const inside = await runTests(host, plan, view, { sandboxed: true });
        assert.deepEqual(host.sandboxed, [
            {
                command: "export JAVA_HOME=/opt/jdk-17 GRADLE_OPTS='-Xmx2g -Dx=y' && ./gradlew test",
                cwd: root,
                timeoutMs: 900_000,
            },
        ]);
        assert.equal(inside.result.command, "./gradlew test", "what is recorded is the command that was configured");
        await runTests(host, plan, view, { sandboxed: false });
        assert.deepEqual(host.ran, [
            {
                file: "/bin/sh",
                args: ["-c", "./gradlew test"],
                cwd: root,
                env: { JAVA_HOME: "/opt/jdk-17", GRADLE_OPTS: "-Xmx2g -Dx=y" },
            },
        ]);
    });

    test("a runner for outside replaces the sandbox and the shell, and the result is not a sandboxed one", async (t) => {
        const host = fakeHost({ run: () => ok() });
        const controller = new AbortController();
        const root = makeRepo(tempFolder(t), "orders-api", "git@github.example.com:acme/orders-api.git");
        const view = await inspect(host, root);
        const plan = planTests(
            settingsFrom({ tests: { "orders-api": { command: "./gradlew test", outside: true } } }),
            view,
            path.dirname(root),
        );
        assert.equal(plan.outside, true);
        const seen: Array<{ plan: unknown; signal: AbortSignal | undefined }> = [];
        const run = await runTests(host, plan, view, {
            sandboxed: false,
            signal: controller.signal,
            outside: async (given, options) => {
                seen.push({ plan: given, signal: options.signal });
                return { code: 0, timedOut: false, output: "BUILD SUCCESSFUL\n", truncated: false };
            },
        });
        assert.deepEqual(seen, [{ plan, signal: controller.signal }]);
        assert.deepEqual([host.sandboxed, host.ran], [[], []], "neither the sandbox nor the shell was used");
        assert.deepEqual(
            [run.result.passed, run.result.sandboxed, run.result.command, run.result.head],
            [true, false, "./gradlew test", headOf(root)],
        );
        assert.equal(run.tail, "BUILD SUCCESSFUL");
        const failed = await runTests(host, plan, view, {
            sandboxed: false,
            outside: async () => ({ code: 2, timedOut: false, output: "", truncated: false }),
        });
        assert.deepEqual([failed.result.passed, failed.result.exitCode], [false, 2]);
        await assert.rejects(
            runTests(host, plan, view, {
                sandboxed: false,
                outside: async () => {
                    throw new Error("outside the sandbox was refused: the user declined this call");
                },
            }),
            /declined/,
        );
    });

    test("a plan has no outside unless the entry says true", async (t) => {
        const root = makeRepo(tempFolder(t), "orders-api", "git@github.example.com:acme/orders-api.git");
        const view = await inspect(fakeHost(), root);
        const plan = (entry: unknown) =>
            planTests(settingsFrom({ tests: { "orders-api": entry } }), view, path.dirname(root));
        assert.equal(plan("npm test").outside, undefined);
        assert.equal(plan({ command: "npm test", outside: false }).outside, undefined);
        assert.equal(plan({ command: "npm test", outside: true }).outside, true);
    });

    test("an entry without variables runs the command as it is", async (t) => {
        const host = fakeHost({ run: () => ok() });
        const { view, plan } = await ready(t, host);
        assert.equal(plan.env, undefined);
        await runTests(host, plan, view, { sandboxed: true });
        await runTests(host, plan, view, { sandboxed: false });
        assert.equal(host.sandboxed[0]?.command, "npm test");
        assert.equal(host.ran[0]?.env, undefined);
    });

    test("a failing command, and one that ran out of time, are not passes", async (t) => {
        const host = fakeHost({
            sandbox: () => ({ code: 1, output: "1 failing\n", timedOut: false, truncated: false }),
        });
        const { view, plan } = await ready(t, host);
        const failed = await runTests(host, plan, view, { sandboxed: true });
        assert.deepEqual([failed.result.passed, failed.result.exitCode, failed.result.timedOut], [false, 1, false]);
        const slow = fakeHost({ sandbox: () => ({ code: null, output: "", timedOut: true, truncated: false }) });
        const timed = await runTests(slow, plan, view, { sandboxed: true });
        assert.deepEqual([timed.result.passed, timed.result.exitCode, timed.result.timedOut], [false, null, true]);
        const odd = fakeHost({ sandbox: () => ({ code: 0, output: "", timedOut: true, truncated: false }) });
        assert.equal(
            (await runTests(odd, plan, view, { sandboxed: true })).result.passed,
            false,
            "exit 0 after a timeout is not a pass",
        );
    });

    test("the tree as it was when the run began: a change makes the result dirty", async (t) => {
        const host = fakeHost();
        const { root, plan } = await ready(t, host);
        writeFileSync(path.join(root, "README.md"), "edited\n");
        const view = await inspect(host, root);
        const run = await runTests(host, plan, view, { sandboxed: true });
        assert.equal(run.result.clean, false);
        assert.equal(run.result.head, headOf(root));
    });

    test("the commit is the one HEAD was at when the run began, whatever happens during it", async (t) => {
        const host = fakeHost({
            sandbox: (_command, options) => {
                commit(options.cwd);
                return { code: 0, output: "", timedOut: false, truncated: false };
            },
        });
        const { root, view, plan } = await ready(t, host);
        const before = headOf(root);
        const run = await runTests(host, plan, view, { sandboxed: true });
        assert.equal(run.result.head, before);
        assert.notEqual(headOf(root), before);
    });

    test("without a sandbox: a shell, as the user, in the repository, with the same limit; both streams come back", async (t) => {
        const host = fakeHost({ run: () => ({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false }) });
        const { root, view, plan } = await ready(t, host);
        const run = await runTests(host, plan, view, { sandboxed: false });
        assert.deepEqual(host.ran, [{ file: "/bin/sh", args: ["-c", "npm test"], cwd: root }]);
        assert.deepEqual(host.sandboxed, []);
        assert.equal(run.result.sandboxed, false);
        assert.equal(run.result.passed, true);
        assert.equal(run.tail, "out\n\nerr");
    });

    test("a cancelled run throws, and a missing command or commit is a refusal with its reason", async (t) => {
        const host = fakeHost({
            sandbox: () => {
                throw new Error("aborted");
            },
        });
        const { view, plan } = await ready(t, host);
        await assert.rejects(runTests(host, plan, view, { sandboxed: true }), /aborted/);
        await assert.rejects(
            runTests(host, { ...plan, command: undefined, problem: "no test command is known for x" }, view, {
                sandboxed: true,
            }),
            /no test command is known/,
        );
        await assert.rejects(
            runTests(host, plan, { ...view, head: undefined, problem: "there is no commit yet" }, { sandboxed: true }),
            /there is no commit yet/,
        );
    });

    test("the signal is passed on to the sandbox and to the shell", async (t) => {
        const controller = new AbortController();
        const seen: Array<AbortSignal | undefined> = [];
        const host = fakeHost({
            sandbox: (_command, options) => {
                seen.push(options.signal);
                return { code: 0, output: "", timedOut: false, truncated: false };
            },
            run: (_file, _args, options) => {
                seen.push(options.signal);
                return ok();
            },
        });
        const { view, plan } = await ready(t, host);
        await runTests(host, plan, view, { sandboxed: true, signal: controller.signal });
        await runTests(host, plan, view, { sandboxed: false, signal: controller.signal });
        assert.deepEqual(seen, [controller.signal, controller.signal]);
    });
});

describe("the end of the output", () => {
    test("the last 60 lines, and at most 8000 characters", () => {
        const lines = Array.from({ length: 100 }, (_, n) => `line ${n}`).join("\n");
        const tail = tailOf(lines);
        assert.equal(tail.split("\n").length, 60);
        assert.ok(tail.endsWith("line 99"));
        assert.equal(tailOf("x".repeat(20_000)).length, 8000);
        assert.equal(tailOf("a\r\nb\r\n\r\n"), "a\nb");
        assert.equal(tailOf(""), "");
    });
});

// A folder that is not a repository gives the runner nothing to test.
test("a folder with no commit cannot be tested", async (t) => {
    const dir = path.join(tempFolder(t), "empty");
    mkdirSync(dir);
    const host = fakeHost();
    const view = await inspect(host, dir);
    await assert.rejects(
        runTests(host, { root: dir, name: "empty", command: "x", timeoutSeconds: 60 }, view, { sandboxed: true }),
    );
});
