// Tests run in the real sandbox: jig-core and jig-sandbox loaded for real, with the real broker and runtime, and a repository's
// test command run through `jig().sandbox.run` by the plugin's own runner. It needs bwrap, socat, rg and python3 as programs,
// skips with the reason when they are missing, and fails in CI, as jig-sandbox's own real tests do.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { jig, withdrawJig } from "../../jig-core/src/client.ts";
import { jigCore } from "../../jig-core/src/index.ts";
import { DEFAULT_SETTINGS } from "../../jig-sandbox/src/config.ts";
import { sandbox } from "../../jig-sandbox/src/index.ts";
import { fakeContext, fakePi } from "../../jig-sandbox/test/support/fake-pi.ts";
import type { FakeContext, FakePi } from "../../jig-sandbox/test/support/fake-pi.ts";
import { skipUnlessRealSandbox, testPrograms } from "../../jig-sandbox/test/support/programs.ts";
import { REAL_HOME_CREDENTIALS } from "../../jig-sandbox/test/support/world.ts";
import { settingsFrom } from "../src/config.ts";
import { coreHost } from "../src/host.ts";
import { inspect } from "../src/repos.ts";
import { planTests, runTests } from "../src/tests.ts";
import { makeRepo } from "./support.ts";

const skip = skipUnlessRealSandbox();

describe("a repository's tests, in the real sandbox", { skip }, () => {
    let root: string;
    let home: string;
    let project: string;
    let pi: FakePi;
    let context: FakeContext;
    const saved = { agent: process.env.PI_CODING_AGENT_DIR, state: process.env.JIG_STATE_DIR };

    before(async () => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-workflow-real-")));
        home = path.join(root, "home");
        mkdirSync(path.join(home, ".ssh"), { recursive: true });
        mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
        writeFileSync(path.join(home, ".ssh", "id_test"), "fake-key-text-from-test\n");
        writeFileSync(path.join(home, ".bashrc"), "# fake\n");
        mkdirSync(path.join(root, "tmp"), { recursive: true });
        mkdirSync(path.join(home, "work"), { recursive: true });
        project = makeRepo(path.join(home, "work"), "orders-api", "git@github.example.com:acme/orders-api.git");
        process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
        process.env.JIG_STATE_DIR = path.join(root, "state");

        const programs = testPrograms();
        pi = fakePi();
        jigCore({ createMasker: () => ({ text: (text: string) => text, value: <T>(value: T): T => value }) as never })(
            pi.pi,
        );
        sandbox({
            env: { ...process.env, HOME: home },
            home: () => home,
            tmpRoot: path.join(root, "tmp"),
            agentDir: () => path.join(home, ".pi", "agent"),
            settings: () => ({
                ...DEFAULT_SETTINGS,
                // The real home's credential places are hidden here as in every real-sandbox test.
                hide: REAL_HOME_CREDENTIALS.map((name) => path.join(userInfo().homedir, name)),
                programs: {
                    ...(programs.bwrap === undefined ? {} : { bwrap: programs.bwrap }),
                    ...(programs.socat === undefined ? {} : { socat: programs.socat }),
                    ...(programs.ripgrep === undefined ? {} : { ripgrep: programs.ripgrep }),
                },
            }),
        })(pi.pi);
        context = fakeContext({ cwd: project });
        await pi.fire("session_start", { reason: "startup" }, context.ctx);
        await jig().sandbox.run("true", { cwd: project, timeoutMs: 60_000 });
    });

    after(async () => {
        await pi.fire("session_shutdown", { reason: "quit" }, context.ctx);
        try {
            withdrawJig(jig());
        } catch {
            // Already withdrawn by the shutdown.
        }
        rmSync(root, { recursive: true, force: true });
        for (const [name, value] of [
            ["PI_CODING_AGENT_DIR", saved.agent],
            ["JIG_STATE_DIR", saved.state],
        ] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    async function run(command: string, sandboxed: boolean) {
        const host = coreHost();
        const view = await inspect(host, project);
        const plan = planTests(
            settingsFrom({ tests: { "orders-api": { command, timeoutSeconds: 60 } } }),
            view,
            path.dirname(project),
        );
        return runTests(host, plan, view, { sandboxed });
    }

    test("jig-core says the sandbox can run commands, once jig-sandbox is loaded and started", () => {
        assert.equal(jig().sandbox.canRun, true);
        assert.equal(coreHost().sandbox.canRun(), true);
    });

    const READ_CREDENTIAL =
        'if grep -q fake-key-text-from-test "$HOME/.ssh/id_test" 2>/dev/null; then echo leaked; exit 3; fi; echo hidden';

    test("a test that reads a credential cannot see it: it passes in the sandbox, and the same command fails outside", async () => {
        const inside = await run(READ_CREDENTIAL, true);
        assert.equal(inside.result.passed, true, inside.tail);
        assert.equal(inside.result.sandboxed, true);
        assert.match(inside.tail, /hidden/);
        // The control: outside the sandbox, as the user, the same command does read the file, so it is the sandbox that hid it.
        const host = coreHost();
        const outside = await host.run("/bin/sh", ["-c", READ_CREDENTIAL], { cwd: project, env: { HOME: home } });
        assert.equal(outside.code, 3);
        assert.match(outside.stdout, /leaked/);
    });

    test("a test that writes a start-up file fails, and the sandbox's explanation is in what the agent reads", async () => {
        const run1 = await run('echo x >> "$HOME/.bashrc"', true);
        assert.equal(run1.result.passed, false);
        assert.notEqual(run1.result.exitCode, 0);
        assert.match(run1.tail, /\[sandbox\] cannot write ~\/\.bashrc: your shells run it outside the sandbox/);
    });

    test("the result is against the commit and a clean tree, and a test may write in the project as a build does", async () => {
        const result = (await run("echo built > build-output.txt; exit 0", true)).result;
        assert.equal(result.clean, true, "the tree was clean when the run began");
        assert.match(result.head, /^[0-9a-f]{40}$/);
        // The command wrote a file in the project, as a build does: the next run of the plugin sees a tree with changes.
        assert.equal((await inspect(coreHost(), project)).clean, false);
    });

    test("a command that runs out of time is a result with timedOut, not a hang", async () => {
        const host = coreHost();
        const view = await inspect(host, project);
        const plan = {
            ...planTests(settingsFrom({ tests: { "orders-api": "sleep 30" } }), view, path.dirname(project)),
            timeoutSeconds: 1,
        };
        const started = Date.now();
        const run2 = await runTests(host, plan, view, { sandboxed: true });
        assert.equal(run2.result.timedOut, true);
        assert.equal(run2.result.passed, false);
        assert.ok(Date.now() - started < 20_000, "stopped by its limit, not by waiting for the command");
    });
});
