// Background tasks in the real sandbox: a task has the rules of a foreground command, its process tree under bubblewrap
// stops when it is told to, and the session's end leaves nothing running.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { realSession, until } from "./support/session.ts";
import type { Session } from "./support/session.ts";
import { skipUnlessRealSandbox } from "./support/programs.ts";

const skip = skipUnlessRealSandbox();

const wake = (s: Session) => s.pi.messages.filter((item) => item.message.customType === "jig-sandbox-background");

/** The pids of processes whose whole command line matches. */
function pidsOf(pattern: RegExp): number[] {
    const found: number[] = [];
    for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ").trim();
            if (pattern.test(cmdline)) found.push(Number(name));
        } catch {
            // Gone.
        }
    }
    return found;
}

describe("background tasks in the real sandbox", { skip }, () => {
    let s: Session;
    before(async () => {
        s = realSession({
            options: {
                background: {
                    graceMs: 1_500,
                    timing: { flushMs: 60, inFlightMs: 500, errorGapMs: 30_000, errorWakeups: 3 },
                },
            },
        });
        mkdirSync(path.join(s.home, ".ssh"), { recursive: true });
        writeFileSync(path.join(s.home, ".ssh", "id_test"), "fake-key-text-from-test\n");
        writeFileSync(path.join(s.home, ".bashrc"), "# fake\n");
        await s.start();
    });
    after(() => s.cleanup());

    test("a task has the rules of a foreground command: it cannot read a credential or write a start-up file", async () => {
        const started = await s.bash(`cat ${s.home}/.ssh/id_test; echo planted >> ${s.home}/.bashrc; echo finished`, {
            background: true,
            name: "rules",
        });
        assert.equal(started.isError, false, started.text);
        await until(
            () => wake(s).some((item) => String(item.message.content).includes('"rules": exited')),
            15_000,
            "the exit message",
        );
        const content = String(
            wake(s).find((item) => String(item.message.content).includes('"rules": exited'))?.message.content,
        );
        assert.match(content, /finished/);
        assert.doesNotMatch(content, /fake-key-text-from-test/);
        // The sandbox's explanations travel with the exit message, as they follow a foreground command's output.
        assert.match(content, /\[sandbox\] cannot write ~\/\.bashrc: your shells run it outside the sandbox/);
        assert.match(content, /\[sandbox\] cannot read ~\/\.ssh\/id_test: it holds credentials/);
        assert.equal(readFileSync(path.join(s.home, ".bashrc"), "utf8"), "# fake\n");
    });

    test("stopping a task stops its whole tree, children inside the sandbox included", async () => {
        const started = await s.bash("sleep 311 & sleep 312 & echo children-$((40+2)); wait", { background: true });
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(
            async () => (await s.call("bg_output", { id, tail: 3 })).text.includes("children-42"),
            10_000,
            "the children",
        );
        const pids = pidsOf(/^sleep 31[12]$/);
        assert.equal(pids.length, 2, "the children run");
        const report = await s.call("bg_kill", { id });
        assert.match(report.text, new RegExp(`^${id} stopped by SIGTERM`));
        await until(() => pidsOf(/^sleep 31[12]$/).length === 0, 8_000, "the children to be gone");
    });

    test("the polite stop reaches the task's own trap, so a server can close", async () => {
        const started = await s.bash(
            "trap 'echo cleaned-up-on-term; exit 0' TERM; echo trapped-$((40+2)); while true; do sleep 0.2; done",
            { background: true },
        );
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(async () => (await s.call("bg_output", { id, tail: 3 })).text.includes("trapped-42"), 10_000);
        await s.call("bg_kill", { id });
        const output = await s.call("bg_output", { id, offset: 0 });
        assert.match(output.text, /cleaned-up-on-term/);
    });

    test("a task that ignores the polite stop is killed after the grace period, tree and all", async () => {
        const started = await s.bash(
            "trap '' TERM; sleep 313 & echo stubborn-$((40+2)); while true; do sleep 0.2; done",
            { background: true },
        );
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(async () => (await s.call("bg_output", { id, tail: 3 })).text.includes("stubborn-42"), 10_000);
        const report = await s.call("bg_kill", { id });
        assert.match(report.text, /ignored SIGTERM; killed with SIGKILL/);
        await until(() => pidsOf(/^sleep 313$/).length === 0, 8_000, "the child to be gone");
    });

    test("a server a task starts is reached by a later command in the default network, as outside", async () => {
        const started = await s.bash("python3 -u -m http.server 18731 --bind 127.0.0.1 --directory /tmp", {
            background: true,
            name: "files",
            notifyOn: { ready: ["Serving HTTP"] },
        });
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(
            () => wake(s).some((item) => String(item.message.content).includes('"files": READY')),
            15_000,
            "ready",
        );
        const fetched = await s.bash("curl -s -o /dev/null -w 'status=%{http_code}' http://127.0.0.1:18731/");
        assert.match(fetched.text, /status=200/);
        await s.call("bg_kill", { id });
    });

    test("ending the session stops the tasks that are left, and nothing of them runs afterwards", async () => {
        const second = realSession();
        try {
            await second.start();
            await second.bash("sleep 314 & echo up-$((40+2)); wait", { background: true });
            await until(
                async () => (await second.call("bg_output", { id: "bg-1", tail: 3 })).text.includes("up-42"),
                10_000,
            );
            assert.equal(pidsOf(/^sleep 314$/).length, 1);
            await second.shutdown();
            await until(() => pidsOf(/^sleep 314$/).length === 0, 8_000, "the task to be gone");
        } finally {
            await second.cleanup();
        }
    });
});
