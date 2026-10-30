// The whole path, for real: the plugin in a fake Pi with the real broker, the real runtime and Pi's own local operations.
// A session starts, the agent's bash tool runs commands in the sandbox, the session ends, and the broker is gone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { sandbox } from "../src/index.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";
import type { FakeContext, FakePi } from "./support/fake-pi.ts";
import { skipUnlessRealSandbox, testPrograms } from "./support/programs.ts";
import { REAL_HOME_CREDENTIALS } from "./support/world.ts";

const skip = skipUnlessRealSandbox();
const SIGNALS = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGQUIT",
    "exit",
    "beforeExit",
    "uncaughtException",
    "unhandledRejection",
] as const;

describe("a session with the real sandbox", { skip }, () => {
    let root: string;
    let home: string;
    let project: string;
    let pi: FakePi;
    let context: FakeContext;
    const before0 = SIGNALS.map((name) => process.listenerCount(name));

    async function bash(command: string): Promise<{ text: string; isError: boolean }> {
        const tool = pi.tools.get("bash");
        try {
            const result = await tool?.execute(
                "call-1",
                { command } as never,
                undefined,
                undefined,
                context.ctx as never,
            );
            return {
                text: (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
                isError: false,
            };
        } catch (error) {
            return { text: (error as Error).message, isError: true };
        }
    }

    before(async () => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-real-plugin-")));
        home = path.join(root, "home");
        project = path.join(home, "work", "orders");
        mkdirSync(project, { recursive: true });
        mkdirSync(path.join(home, ".ssh"), { recursive: true });
        writeFileSync(path.join(home, ".ssh", "id_test"), "fake-key-text-from-test\n");
        writeFileSync(path.join(home, ".bashrc"), "# fake\n");
        const programs = testPrograms();
        pi = fakePi();
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
        mkdirSync(path.join(root, "tmp"), { recursive: true });
        context = fakeContext({ cwd: project });
        await pi.fire("session_start", { reason: "startup" }, context.ctx);
    });

    after(async () => {
        await pi.fire("session_shutdown", { reason: "quit" }, context.ctx);
        rmSync(root, { recursive: true, force: true });
    });

    test("the agent's commands run in the project, inside the sandbox", async () => {
        const result = await bash(
            `pwd; echo made > from-bash.txt; cat from-bash.txt; cat ${home}/.ssh/id_test; echo x >> ${home}/.bashrc`,
        );
        assert.equal(result.isError, false);
        assert.match(result.text, new RegExp(`^${project}\\nmade\\n`));
        assert.doesNotMatch(result.text, /fake-key-text-from-test/);
        assert.match(result.text, /\[sandbox\] cannot write ~\/\.bashrc: your shells run it outside the sandbox/);
        assert.match(
            result.text,
            /\[sandbox\] cannot read ~\/\.ssh\/id_test: it holds credentials\. For git over SSH use the git tool/,
        );
        assert.deepEqual(
            readdirSync(project).sort(),
            ["from-bash.txt"],
            "the runtime left nothing else in the project",
        );
    });

    test("the broker is a process of its own, with its own working folder", async () => {
        const shown = await pi.commands.get("sandbox")?.handler("", context.ctx as never);
        void shown;
        const lines = context.screen.notifications
            .map((item) => item.message)
            .concat(context.screen.selects.flatMap((item) => item.options));
        const broker = lines.find((line) => line.includes("broker: process"));
        assert.match(broker ?? "", /broker: process \d+, session folder .*jig-sandbox-/);
        const pid = Number(/process (\d+)/.exec(broker ?? "")?.[1]);
        assert.notEqual(pid, process.pid);
        assert.doesNotThrow(() => process.kill(pid, 0));
    });

    test("the cost of a command through the whole path, with the rules, the broker, the sandbox and the explanations", async () => {
        const times: number[] = [];
        for (let index = 0; index < 20; index++) {
            const started = performance.now();
            const result = await bash("true");
            times.push(performance.now() - started);
            assert.equal(result.isError, false);
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)] as number;
        console.log(
            `    per-command cost through the full path: median ${median.toFixed(0)} ms, fastest ${(times[0] as number).toFixed(0)} ms, slowest ${(times.at(-1) as number).toFixed(0)} ms`,
        );
        assert.ok(median < 1000, `a command took ${median} ms`);
    });

    test("ending the session stops the broker, and Pi's signal handling was never touched", async () => {
        const lines = () =>
            context.screen.notifications
                .map((item) => item.message)
                .concat(context.screen.selects.flatMap((item) => item.options));
        await pi.commands.get("sandbox")?.handler("", context.ctx as never);
        const pid = Number(/process (\d+)/.exec(lines().find((line) => line.includes("broker: process")) ?? "")?.[1]);
        assert.doesNotThrow(() => process.kill(pid, 0));
        await pi.fire("session_shutdown", { reason: "quit" }, context.ctx);
        // The broker leaves when its pipe is closed; give it a moment to clean up and go.
        for (let waited = 0; waited < 5000; waited += 50) {
            try {
                process.kill(pid, 0);
            } catch {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert.deepEqual(
            SIGNALS.map((name) => process.listenerCount(name)),
            before0,
        );
    });
});
