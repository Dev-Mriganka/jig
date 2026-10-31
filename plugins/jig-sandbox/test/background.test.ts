// Background tasks through the plugin, with a fake Pi and a broker that does not sandbox: the tools, the limits, the wake-ups
// from real processes, stopping, the deadline, the end of the session, the clean-up of a crashed one, `/ps` and the footer.
// What the real sandbox adds (the process tree under bubblewrap, a task that cannot read a credential) is in
// `background-real.test.ts`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { backgroundRoot, ensureSessionFolder, writeManifest, writeOwner } from "../src/background/sessions.ts";
import { realPort } from "../src/background/process.ts";
import { fakeSession } from "./support/fake-session.ts";
import type { FakeSession, FakeSessionOptions } from "./support/fake-session.ts";
import { until } from "./support/session.ts";

let current: FakeSession | undefined;
afterEach(async () => {
    await current?.end();
    current = undefined;
});

async function begin(over: FakeSessionOptions = {}): Promise<FakeSession> {
    current = fakeSession(over);
    await current.start();
    return current;
}

const wake = (s: FakeSession) => s.pi.messages.filter((item) => item.message.customType === "jig-sandbox-background");
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("what the plugin registers", () => {
    test("three tools, /ps and a message hook; bash gains background, name and notifyOn", async () => {
        const s = await begin();
        assert.deepEqual([...s.pi.tools.keys()].sort(), ["bash", "bg_kill", "bg_list", "bg_output"]);
        assert.deepEqual([...s.pi.commands.keys()].sort(), ["ps", "sandbox"]);
        assert.ok(s.pi.handlers.get("message_start"));
        const parameters = s.pi.tools.get("bash")?.parameters as unknown as { properties: object };
        assert.deepEqual(Object.keys(parameters.properties).sort(), [
            "background",
            "command",
            "name",
            "notifyOn",
            "outside",
            "reason",
            "timeout",
        ]);
        const description = s.pi.tools.get("bash")?.description ?? "";
        assert.match(description, /background: true/);
        assert.match(description, /never sleep or poll/);
        assert.match(description, /cannot use outside/);
    });
});

describe("starting a task", () => {
    test("returns its id at once, says what wakes the agent, and the command runs", async () => {
        const s = await begin();
        const started = await s.tool("bash", {
            command: "echo up; sleep 30",
            background: true,
            name: "dev server",
            notifyOn: { ready: ["^up$"], error: ["ERROR|Exception"] },
        });
        assert.equal(started.isError, false);
        assert.equal(
            started.text,
            [
                'Started background task bg-1 "dev server" (sandboxed, at most 4h).',
                "Wakes you on: exit; ready /^up$/; error /ERROR|Exception/.",
                'Read its output with bg_output {"id":"bg-1","tail":40}. Do not sleep or poll.',
            ].join("\n"),
        );
        const list = await s.tool("bg_list", {});
        assert.match(
            list.text,
            /^bg-1 \| running \| [\d.]+s \| dev server \| echo up; sleep 30 \| ready (not )?seen, 0 error matches$/,
        );
    });

    test("the name defaults to the start of the command, and the timeout shortens the longest run", async () => {
        const s = await begin();
        const started = await s.tool("bash", {
            command: "sleep 30 # a long command that is more than forty characters",
            background: true,
            timeout: 90,
        });
        assert.match(started.text, /^Started background task bg-1 "sleep 30 # a long command that is more t\u2026"/);
        assert.match(started.text, /at most 2m\)/);
    });

    test("a task is sandboxed like any command: the broker wrapped it and its environment holds no credential", async () => {
        const s = await begin();
        await s.tool("bash", { command: 'echo "token=[$MY_SERVICE_TOKEN]"; sleep 30', background: true });
        const wraps = s.brokers.log.requests.filter(
            (request) => request.type === "wrap" && String(request.fields.command).includes("token="),
        );
        assert.equal(wraps.length, 1);
        await until(() => /token=\[\]/.test(readTask(s, "bg-1")), 5000, "the task's output");
    });

    test("a task's output has its escape codes and credential values taken out", async () => {
        const s = await begin({ env: { MY_SERVICE_TOKEN: "super-secret-value-123" } });
        await s.tool("bash", {
            command:
                "printf '\\033[31mred\\033[0m \\033]0;title\\007done\\n'; printf '%s\\n' \"$(printenv MY_SERVICE_TOKEN) leaked?\"; sleep 30",
            background: true,
        });
        const text = await until(
            () => {
                const seen = readTask(s, "bg-1");
                return seen.includes("leaked?") ? seen : undefined;
            },
            5000,
            "output",
        );
        assert.match(text, /red done/);
        assert.doesNotMatch(text, /\u001b|super-secret-value/);
    });
});

function readTask(s: FakeSession, id: string): string {
    const folder = path.join(backgroundRoot(s.agentDir));
    const [session] = existsSync(folder) ? readdirSync(folder) : [];
    if (session === undefined) return "";
    const file = path.join(folder, session, `${id}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("refused before anything starts", () => {
    test("bad patterns are refused with the reason, and no task is made", async () => {
        const s = await begin();
        for (const [pattern, reason] of [
            ["(a+)+", /repeat inside a repeat/],
            ["(x)\\1", /back-reference/],
            ["(?<=a)b", /look-behind/],
            ["(unclosed", /not a valid regular expression/],
        ] as const) {
            const result = await s.tool("bash", {
                command: "sleep 30",
                background: true,
                notifyOn: { error: [pattern] },
            });
            assert.equal(result.isError, true);
            assert.match(result.text, reason);
        }
        const six = await s.tool("bash", {
            command: "sleep 30",
            background: true,
            notifyOn: { ready: ["a", "b", "c", "d", "e", "f"] },
        });
        assert.match(six.text, /at most 5/);
        assert.equal((await s.tool("bg_list", {})).text, "No background tasks.");
    });

    test("notifyOn and name need background", async () => {
        const s = await begin();
        assert.match(
            (await s.tool("bash", { command: "true", notifyOn: { ready: ["x"] } })).text,
            /add background: true/,
        );
        assert.match((await s.tool("bash", { command: "true", name: "x" })).text, /add background: true/);
    });

    test("a name with odd characters is refused", async () => {
        const s = await begin();
        const result = await s.tool("bash", { command: "sleep 30", background: true, name: "a\nb" });
        assert.match(result.text, /name must be up to 40 characters/);
    });

    test("outside is refused: by the tool, and by jig-core before it asks anybody", async () => {
        const s = await begin({ core: true, select: () => "Run once" });
        const direct = await s.tool("bash", { command: "sleep 30", background: true, outside: true, reason: "x" });
        assert.equal(direct.isError, true);
        assert.match(direct.text, /a background task cannot run outside the sandbox/);
        const gated = await s.gated("bash", { command: "sleep 30", background: true, outside: true, reason: "x" });
        assert.equal(gated.blocked, true);
        assert.match(gated.text, /cannot run outside the sandbox/);
        assert.equal(gated.asked, 0, "nobody was asked");
        assert.equal((await s.tool("bg_list", {})).text, "No background tasks.");
    });

    test("without a screen to talk to (print or json mode) a task is refused, with the way on", async () => {
        const s = await begin({ mode: "print" });
        const result = await s.tool("bash", { command: "sleep 30", background: true });
        assert.match(result.text, /need an interactive Pi session: run the command in the foreground/);
    });

    test("with the sandbox switched off a task is refused, and the foreground still runs", async () => {
        const s = await begin();
        await s.command("sandbox", "off");
        const result = await s.tool("bash", { command: "sleep 30", background: true });
        assert.match(result.text, /run only in the sandbox, and the user switched it off/);
    });

    test("a timeout that is not a positive number is refused", async () => {
        const s = await begin();
        assert.match(
            (await s.tool("bash", { command: "sleep 30", background: true, timeout: -1 })).text,
            /timeout must be/,
        );
    });
});

describe("limits", () => {
    test("no more than maxTasks run at once, and a stopped one makes room", async () => {
        const s = await begin({
            settings: { background: { maxTasks: 2, maxRuntimeMinutes: 240, keepFinished: 12, wake: "on" } },
        });
        assert.equal((await s.tool("bash", { command: "sleep 30", background: true })).isError, false);
        assert.equal((await s.tool("bash", { command: "sleep 30", background: true })).isError, false);
        const third = await s.tool("bash", { command: "sleep 30", background: true });
        assert.equal(third.isError, true);
        assert.match(third.text, /Background limit reached \(2 running\)\. bg_list shows them; bg_kill one first\./);
        await s.tool("bg_kill", { id: "bg-1" });
        assert.equal((await s.tool("bash", { command: "sleep 30", background: true })).isError, false);
    });

    test("the task's longest run is cut to maxRuntimeMinutes", async () => {
        const s = await begin({
            settings: { background: { maxTasks: 4, maxRuntimeMinutes: 1, keepFinished: 12, wake: "on" } },
        });
        const started = await s.tool("bash", { command: "sleep 30", background: true, timeout: 7200 });
        assert.match(started.text, /at most 1m\)/);
    });

    test("only keepFinished finished tasks are kept, the oldest forgotten with their logs", async () => {
        const s = await begin({
            settings: { background: { maxTasks: 4, maxRuntimeMinutes: 240, keepFinished: 2, wake: "on" } },
        });
        for (let index = 1; index <= 4; index++) {
            await s.tool("bash", { command: `echo done-${index}`, background: true });
            await until(
                async () => (await s.tool("bg_list", {})).text.includes(`bg-${index} | exited`) || undefined,
                5000,
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const list = (await s.tool("bg_list", {})).text.split("\n");
        assert.equal(list.length, 2);
        assert.match(list[0] ?? "", /^bg-4/);
        assert.equal((await s.tool("bg_output", { id: "bg-1" })).isError, true);
    });
});

describe("waking the agent from real output", () => {
    test("ready wakes once, with the matching line and the last lines", async () => {
        const s = await begin();
        await s.tool("bash", {
            command:
                "echo starting; sleep 0.2; echo 'Listening on :8080'; sleep 0.2; echo 'Listening on :8080 again'; sleep 30",
            background: true,
            name: "server",
            notifyOn: { ready: ["Listening on"] },
        });
        await until(() => wake(s).length > 0, 8000, "the ready message");
        // Wait for the second matching line to be in the log rather than for a fixed time: on a loaded machine the task's
        // output can lag, and the point is that the second match does not wake the agent again.
        await until(
            async () => (await s.tool("bg_output", { id: "bg-1", tail: 5 })).text.includes("again"),
            8000,
            "the second ready line",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(wake(s).length, 1, "ready matches once per task");
        const message = wake(s)[0];
        assert.deepEqual(message?.options, { deliverAs: "followUp", triggerTurn: true });
        assert.match(
            String(message?.message.content),
            /Background task bg-1 "server": READY, matched \/Listening on\/ after [\d.]+s \(still running\)\./,
        );
        assert.match(String(message?.message.content), /Matched line: Listening on :8080\n/);
        assert.match(String(message?.message.content), /Last output:\nstarting\nListening on :8080/);
    });

    test("an error wakes with its line; a burst of errors is one message that counts the rest", async () => {
        const s = await begin();
        await s.tool("bash", {
            command: "echo ok; echo 'ERROR one'; echo 'ERROR two'; echo 'ERROR three'; sleep 30",
            background: true,
            notifyOn: { error: ["ERROR"] },
        });
        await until(() => wake(s).length > 0, 8000, "the error message");
        // All three lines counted, however long the output took on a loaded machine; then still one message.
        await until(
            async () => /3 error matches/.test((await s.tool("bg_list", {})).text),
            8000,
            "all three errors counted",
        );
        assert.equal(wake(s).length, 1);
        const content = String(wake(s)[0]?.message.content);
        assert.match(content, /ERROR, matched \/ERROR\/ at \d+s \(still running\)\./);
        assert.match(content, /Matched line: ERROR one/);
    });

    test("the end of the task wakes the agent with how it ended", async () => {
        const s = await begin();
        await s.tool("bash", { command: "echo working; exit 3", background: true, name: "build" });
        await until(() => wake(s).length > 0, 8000, "the exit message");
        const content = String(wake(s)[0]?.message.content);
        assert.match(content, /Background task bg-1 "build": exited \(code 3\), ran [\d.]+s\./);
        assert.match(content, /Last output:\nworking/);
        assert.match((await s.tool("bg_list", {})).text, /^bg-1 \| exited \(code 3\)/);
    });

    test("a message waits until the agent has received the one before", async () => {
        const s = await begin();
        await s.tool("bash", { command: "echo one; sleep 0.1; exit 0", background: true, name: "first" });
        await until(() => wake(s).length === 1, 8000);
        await s.tool("bash", { command: "echo two; exit 1", background: true, name: "second" });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(wake(s).length, 1, "the first has not been received");
        await s.pi.fire(
            "message_start",
            { message: { role: "custom", customType: "jig-sandbox-background" } },
            s.ctx.ctx,
        );
        await until(() => wake(s).length === 2, 8000, "the second message");
        assert.match(String(wake(s)[1]?.message.content), /"second": exited \(code 1\)/);
    });

    test("wake off sends the message without waking the agent", async () => {
        const s = await begin({
            settings: { background: { maxTasks: 4, maxRuntimeMinutes: 240, keepFinished: 12, wake: "off" } },
        });
        await s.tool("bash", { command: "exit 0", background: true });
        await until(() => wake(s).length > 0, 8000);
        assert.deepEqual(wake(s)[0]?.options, { triggerTurn: false });
    });

    test("output the agent already read does not wake it again, but the end of the task does", async () => {
        // The burst is held for a second and a half here, a wide margin for the agent's read on a busy machine: it has to be read
        // before the burst is sent, and the task's own end is what shows, without a fixed wait, that the burst was sent.
        const s = await begin({
            options: {
                background: {
                    shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
                    timing: { flushMs: 1_500, inFlightMs: 400, errorGapMs: 30_000, errorWakeups: 3 },
                    graceMs: 300,
                },
            },
        });
        // A name of its own, because the header of a read repeats the command, and the command holds the line that is waited for.
        await s.tool("bash", {
            command: "echo 'READY now'; sleep 0.3; exit 0",
            background: true,
            name: "server",
            notifyOn: { ready: ["READY"] },
        });
        await until(
            async () => (await s.tool("bg_output", { id: "bg-1", tail: 5 })).text.includes("READY now") || undefined,
            8000,
            "the matching line to be there to read",
        );
        await until(() => wake(s).length > 0, 8000, "the message that ends the burst");
        assert.equal(wake(s).length, 1);
        const content = String(wake(s)[0]?.message.content);
        assert.match(content, /bg-1 "server": exited \(code 0\)/);
        assert.doesNotMatch(content, /: READY, matched/, "the line was read, so it is not told as news");
    });
});

describe("reading output", () => {
    test("the unread lines, the last lines, a filter and an offset, as the design says", async () => {
        const s = await begin();
        await s.tool("bash", {
            command: "for i in 1 2 3 4 5 6; do echo line $i; done; echo WARN seven; sleep 30",
            background: true,
        });
        await until(
            async () => (await s.tool("bg_output", { id: "bg-1", tail: 1 })).text.includes("WARN seven") || undefined,
            5000,
            "the output",
        );
        assert.match((await s.tool("bg_output", { id: "bg-1" })).text, /\(no new output\)/, "tail moved the position");
        const tail = await s.tool("bg_output", { id: "bg-1", tail: 2 });
        assert.match(tail.text, /line 6\nWARN seven/);
        const filtered = await s.tool("bg_output", { id: "bg-1", filter: "warn", offset: 0 });
        assert.match(filtered.text, /\nWARN seven\n\[filter: 1 of 7 lines matched\]/);
        const offset = await s.tool("bg_output", { id: "bg-1", offset: 14 });
        assert.match(offset.text, /line 3\nline 4/);
        assert.match((await s.tool("bg_output", { id: "bg-1", tail: 1, offset: 1 })).text, /exclusive/);
        assert.match((await s.tool("bg_output", { id: "bg-9" })).text, /Unknown task id bg-9\. bg_list shows/);
    });
});

describe("stopping", () => {
    test("bg_kill stops a task and its children (the whole process group), and no wake-up follows", async () => {
        const s = await begin();
        await s.tool("bash", { command: "sleep 301 & sleep 302 & echo 'children started'; wait", background: true });
        await until(() => readTask(s, "bg-1").includes("children started"), 5000);
        const pids = pidsOf("sleep 30[12]");
        assert.equal(pids.length, 2);
        const report = await s.tool("bg_kill", { id: "bg-1" });
        assert.match(report.text, /^bg-1 stopped by SIGTERM after [\d.]+s \(exited, code 143\)\.$/);
        await until(() => pids.every((pid) => !alive(pid)), 5000, "the children to be gone");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(wake(s).length, 0, "the agent stopped it itself, so nothing wakes it");
        assert.match((await s.tool("bg_list", {})).text, /^bg-1 \| killed \(by agent\)/);
        assert.match((await s.tool("bg_kill", { id: "bg-1" })).text, /had already finished: killed \(by agent\)/);
    });

    test("a task that ignores the polite stop is killed after the grace period", async () => {
        const s = await begin();
        await s.tool("bash", { command: "trap '' TERM; echo ready; while true; do sleep 0.1; done", background: true });
        await until(() => readTask(s, "bg-1").includes("ready"), 5000);
        const report = await s.tool("bg_kill", { id: "bg-1" });
        assert.match(report.text, /ignored SIGTERM; killed with SIGKILL after \d+s\./);
    });

    test("bg_kill all stops every running task", async () => {
        const s = await begin();
        await s.tool("bash", { command: "sleep 30", background: true });
        await s.tool("bash", { command: "sleep 30", background: true });
        const report = await s.tool("bg_kill", { id: "all" });
        assert.equal(report.text.split("\n").length, 2);
        assert.equal((await s.tool("bg_kill", { id: "all" })).text, "No running background tasks.");
    });

    test("the deadline stops a task and tells the agent", async () => {
        const s = await begin({
            options: {
                background: {
                    graceMs: 200,
                    shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
                    timing: { flushMs: 40, inFlightMs: 400 },
                },
            },
        });
        await s.tool("bash", { command: "echo working; sleep 60", background: true, timeout: 0.4, name: "slow build" });
        await until(() => wake(s).length > 0, 8000, "the deadline message");
        const content = String(wake(s)[0]?.message.content);
        assert.match(content, /"slow build": killed \(max runtime\), ran [\d.]+s\./);
        assert.match((await s.tool("bg_list", {})).text, /killed \(max runtime\)/);
    });

    test("ending the session stops every task, removes the logs and says nothing", async () => {
        const s = await begin();
        await s.tool("bash", { command: "sleep 303 & echo started; wait", background: true });
        await until(() => readTask(s, "bg-1").includes("started"), 5000);
        const pids = pidsOf("sleep 303");
        assert.equal(pids.length, 1);
        const folder = backgroundRoot(s.agentDir);
        assert.ok(readdirSync(folder).length > 0);
        await s.shutdown();
        await until(() => !alive(pids[0] as number), 5000, "the task's child to be gone");
        assert.equal(wake(s).length, 0);
        assert.deepEqual(readdirSync(folder), [], "the session's folder is gone");
    });

    test("a new session starts with no tasks, and a task cannot be started while one shuts down", async () => {
        const s = await begin();
        await s.shutdown();
        const refused = await s.tool("bash", { command: "sleep 30", background: true });
        assert.equal(refused.isError, true);
    });
});

/** The pids of processes whose command line matches. */
function pidsOf(pattern: string): number[] {
    const found: number[] = [];
    for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ").trim();
            if (new RegExp(`^${pattern}$`).test(cmdline)) found.push(Number(name));
        } catch {
            // Gone.
        }
    }
    return found;
}

describe("a crashed session", () => {
    test("is found at the next session start: its tasks are stopped and its folder removed", async () => {
        const s = await begin();
        // A task as a Pi that died would have left it: a live process in a group of its own, a manifest naming it, a dead owner.
        const orphan = spawn("/bin/bash", ["-c", "sleep 304"], { detached: true, stdio: "ignore" });
        orphan.unref();
        await until(() => pidsOf("sleep 304").length === 1 || orphan.pid !== undefined, 3000);
        const folder = path.join(backgroundRoot(s.agentDir), "crashed");
        ensureSessionFolder(s.agentDir, "crashed");
        writeOwner(folder, 99_999_999, "1");
        writeManifest(folder, [
            { id: "bg-1", pid: orphan.pid as number, startTicks: realPort.startTicks(orphan.pid as number) as string },
        ]);
        writeFileSync(path.join(folder, "bg-1.log"), "left over\n");
        assert.ok(alive(orphan.pid as number));
        await s.pi.fire("session_start", { reason: "startup" }, s.ctx.ctx);
        await until(() => !alive(orphan.pid as number), 5000, "the orphan to be stopped");
        assert.equal(existsSync(folder), false);
    });
});

describe("/ps", () => {
    test("list and view say what the tools say", async () => {
        const s = await begin();
        assert.deepEqual(await s.command("ps", ""), ["No background tasks."]);
        await s.tool("bash", { command: "echo hello from the task; sleep 30", background: true, name: "demo" });
        await until(() => readTask(s, "bg-1").includes("hello"), 5000);
        await new Promise((resolve) => setTimeout(resolve, 550));
        const list = await s.command("ps", "list");
        assert.match(list[0] ?? "", /^bg-1 \| running \| [\d.]+s \| demo \|/);
        const view = await s.command("ps", "view bg-1");
        assert.match(view.join("\n"), /hello from the task/);
        assert.match((await s.command("ps", "view bg-7")).join("\n"), /Unknown task id bg-7/);
        assert.match((await s.command("ps", "frob")).join("\n"), /Usage: \/ps/);
    });

    test("stopping a task from /ps asks first, and the agent hears one line that does not wake it", async () => {
        const s = await begin();
        (s.ctx.ctx.ui as unknown as { confirm: () => Promise<boolean> }).confirm = async () => true;
        await s.tool("bash", { command: "sleep 30", background: true, name: "demo" });
        const said = await s.command("ps", "kill bg-1");
        assert.match(said.join("\n"), /bg-1 stopped by SIGTERM/);
        await until(() => s.pi.messages.length > 0, 3000);
        const note = s.pi.messages.at(-1);
        assert.equal(note?.message.customType, "jig-sandbox-background-note");
        assert.deepEqual(note?.options, { triggerTurn: false });
        assert.match(String(note?.message.content), /bg-1 "demo" was stopped by the user/);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(wake(s).length, 0);
    });

    test("not confirmed, nothing is stopped", async () => {
        const s = await begin();
        await s.tool("bash", { command: "sleep 30", background: true });
        await s.command("ps", "kill bg-1");
        assert.match((await s.tool("bg_list", {})).text, /^bg-1 \| running/);
    });

    test("the menu lists tasks, offers to view or stop one, and forgets the finished", async () => {
        const answers = ["demo", "View its output", undefined] as const;
        let step = 0;
        const s = await begin({
            select: (title, options) => {
                if (title === "Background tasks")
                    return step === 0 ? options.find((option) => option.includes("| demo |")) : undefined;
                step++;
                return answers[1];
            },
        });
        await s.tool("bash", { command: "echo shown; sleep 30", background: true, name: "demo" });
        await s.command("ps", "");
        const titles = s.ctx.screen.selects.map((item) => item.title);
        assert.equal(titles[0], "Background tasks");
        assert.match(titles[1] ?? "", /bg-1 \| running/);
        assert.deepEqual(s.ctx.screen.selects[1]?.options, ["View its output", "Stop it", "Back"]);
    });

    test("the Background tasks menu offers to forget finished tasks", async () => {
        let clear = false;
        const s = await begin({
            select: (title, options) => {
                if (title !== "Background tasks") return undefined;
                if (!clear) {
                    clear = true;
                    return options.includes("Forget the finished tasks") ? "Forget the finished tasks" : undefined;
                }
                return undefined;
            },
        });
        await s.tool("bash", { command: "exit 0", background: true });
        await until(async () => (await s.tool("bg_list", {})).text.includes("exited") || undefined, 5000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await s.command("ps", "");
        assert.equal((await s.tool("bg_list", {})).text, "No background tasks.");
    });
});

describe("the footer", () => {
    test("shows how many tasks run through jig-theme's segment, and takes it away when none do", async () => {
        const s = await begin();
        const segments = () =>
            s.pi.emitted
                .filter((item) => item.channel === "jig-theme:segment")
                .map((item) => item.data as { id: string; label: string; tone: string });
        await s.tool("bash", { command: "sleep 30", background: true });
        await s.tool("bash", { command: "sleep 30", background: true });
        assert.deepEqual(segments().at(-1), { id: "jig-sandbox-tasks", label: "2 bg tasks", tone: "accent" });
        await s.tool("bg_kill", { id: "bg-1" });
        assert.equal(segments().at(-1)?.label, "1 bg task");
        await s.tool("bg_kill", { id: "bg-2" });
        assert.equal(segments().at(-1)?.label, "");
    });

    test("ending the session takes the part away", async () => {
        const s = await begin();
        await s.tool("bash", { command: "sleep 30", background: true });
        await s.shutdown();
        const last = s.pi.emitted.filter((item) => item.channel === "jig-theme:segment").at(-1)?.data as {
            label: string;
        };
        assert.equal(last.label, "");
    });
});

describe("what jig-core is told", () => {
    test("bg_output and bg_list read, bg_kill writes, all of them on this machine and none asks", async () => {
        const s = await begin({ core: true });
        await s.tool("bash", { command: "sleep 30", background: true });
        for (const [name, input] of [
            ["bg_list", {}],
            ["bg_output", { id: "bg-1", tail: 1 }],
            ["bg_kill", { id: "bg-1" }],
        ] as const) {
            const result = await s.gated(name, input);
            assert.equal(result.blocked, false, `${name}: ${result.text}`);
            assert.equal(result.asked, 0, `${name} asked`);
        }
        const records = s.pi.emitted
            .filter((item) => item.channel === "jig:decision")
            .map((item) => item.data as { tool: string; environment: string; effect: string; decision: string });
        const byTool = Object.fromEntries(records.map((record) => [record.tool, record]));
        assert.deepEqual(
            [byTool.bg_output?.environment, byTool.bg_output?.effect, byTool.bg_output?.decision],
            ["local", "read", "allow"],
        );
        assert.deepEqual(
            [byTool.bg_list?.environment, byTool.bg_list?.effect, byTool.bg_list?.decision],
            ["local", "read", "allow"],
        );
        assert.deepEqual(
            [byTool.bg_kill?.environment, byTool.bg_kill?.effect, byTool.bg_kill?.decision],
            ["local", "write", "allow"],
        );
    });

    test("a background bash is the ordinary local write that bash is", async () => {
        const s = await begin({ core: true });
        const result = await s.gated("bash", { command: "sleep 30", background: true });
        assert.equal(result.blocked, false);
        assert.equal(result.asked, 0);
        const record = s.pi.emitted
            .filter((item) => item.channel === "jig:decision")
            .map((item) => item.data as { tool: string; action?: string; decision: string })
            .at(-1);
        assert.equal(record?.tool, "bash");
        assert.equal(record?.action, undefined);
        assert.equal(record?.decision, "allow");
    });
});
