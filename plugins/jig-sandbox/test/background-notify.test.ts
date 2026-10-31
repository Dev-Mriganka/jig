// Waking the agent: one message for a burst, limits on error floods, one message in flight, and what a message says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Notifier, NOTE_TYPE, WAKE_TYPE } from "../src/background/notify.ts";
import type { NotifierDeps, SendOptions } from "../src/background/notify.ts";
import type { Task } from "../src/background/types.ts";

function task(over: Partial<Task> = {}): Task {
    return {
        id: "bg-1",
        name: "dev server",
        command: "npm run dev",
        cwd: "/work",
        pid: 4242,
        startedAt: 0,
        state: "running",
        deadline: 1e9,
        timeoutMs: 1e9,
        notifyOn: { ready: [], error: [] },
        cursor: 0,
        ready: false,
        errorMatches: 0,
        streamBytes: 0,
        sandboxLines: [],
        ports: [],
        settled: Promise.resolve(),
        markSettled: () => undefined,
        ...over,
    };
}

interface Sent {
    message: { customType: string; content: string; details: unknown };
    options: SendOptions;
}

function notifier(over: Partial<NotifierDeps> & { tasks?: Task[]; clock?: { now: number } } = {}) {
    const sent: Sent[] = [];
    const clock = over.clock ?? { now: 0 };
    const tasks = new Map((over.tasks ?? [task()]).map((item) => [item.id, item]));
    const n = new Notifier({
        send: (message, options) => sent.push({ message: message as Sent["message"], options }),
        now: () => clock.now,
        wake: () => true,
        task: (id) => tasks.get(id),
        tail: () => ({ text: "line one\nline two", cut: false }),
        timing: { flushMs: 30, inFlightMs: 400, errorGapMs: 30_000, errorWakeups: 3 },
        ...over,
    });
    return { n, sent, clock, tasks };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one message for a burst", () => {
    test("events that arrive together are sent as one message that wakes the agent", async () => {
        const { n, sent, tasks } = notifier({ tasks: [task(), task({ id: "bg-2", name: "watcher" })] });
        n.ready(tasks.get("bg-1") as Task, "Listening", "Listening on :8080", 10);
        n.error(tasks.get("bg-2") as Task, "ERROR", "ERROR boom", 20);
        n.exit(tasks.get("bg-1") as Task);
        assert.equal(sent.length, 0, "nothing goes out at once");
        await wait(80);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
        assert.equal(sent[0]?.message.customType, WAKE_TYPE);
        const content = sent[0]?.message.content ?? "";
        assert.match(content, /bg-1 "dev server": READY, matched \/Listening\/ after/);
        assert.match(content, /bg-2 "watcher": ERROR, matched \/ERROR\//);
        assert.match(content, /bg-1 "dev server": running, ran/);
        const details = sent[0]?.message.details as { events: unknown[] };
        assert.equal(details.events.length, 3);
    });

    test("a build that prints three errors wakes the agent once", async () => {
        const { n, sent, tasks } = notifier();
        const t = tasks.get("bg-1") as Task;
        n.error(t, "ERROR", "ERROR one", 0);
        n.error(t, "ERROR", "ERROR two", 10);
        n.error(t, "ERROR", "ERROR three", 20);
        await wait(80);
        assert.equal(sent.length, 1);
        assert.match(sent[0]?.message.content ?? "", /ERROR one/);
        assert.doesNotMatch(sent[0]?.message.content ?? "", /ERROR two/);
    });

    test("the message says the task, the event, the matching line and the last lines", async () => {
        const { n, sent, tasks } = notifier();
        n.ready(tasks.get("bg-1") as Task, "Listening on", "Listening on http://localhost:8080", 0);
        await wait(80);
        assert.equal(
            sent[0]?.message.content,
            [
                'Background task bg-1 "dev server": READY, matched /Listening on/ after 0.0s (still running).',
                "Matched line: Listening on http://localhost:8080",
                "Last output:\nline one\nline two",
            ].join("\n"),
        );
    });

    test("the exit message says how it ended, and carries the sandbox's lines", async () => {
        const t = task({
            state: "exited",
            exitCode: 2,
            endedAt: 4_200,
            errorMatches: 2,
            sandboxLines: ["[sandbox] cannot write ~/.bashrc: your shells run it outside the sandbox."],
        });
        const { n, sent } = notifier({ tasks: [t] });
        n.exit(t);
        await wait(80);
        const content = sent[0]?.message.content ?? "";
        assert.match(content, /bg-1 "dev server": exited \(code 2\), ran 4\.2s\. 2 error matches while running\./);
        assert.match(content, /\[sandbox\] cannot write ~\/\.bashrc/);
    });

    test("a message longer than 8 KiB is cut", async () => {
        const { n, sent, tasks } = notifier({ tail: () => ({ text: "x".repeat(20_000), cut: false }) });
        n.ready(tasks.get("bg-1") as Task, "up", "up", 0);
        await wait(80);
        const content = sent[0]?.message.content ?? "";
        assert.ok(Buffer.byteLength(content) <= 8_192);
        assert.match(content, /message cut to 8 KiB/);
    });
});

describe("error floods", () => {
    test("at most three error wake-ups, 30 seconds apart; the matches between are counted and reported with the next one", async () => {
        const clock = { now: 0 };
        const { n, sent, tasks } = notifier({
            clock,
            timing: { flushMs: 10, inFlightMs: 5, errorGapMs: 30_000, errorWakeups: 3 },
        });
        const t = tasks.get("bg-1") as Task;
        n.error(t, "ERROR", "first", 0);
        clock.now = 5_000;
        n.error(t, "ERROR", "second, too soon", 1);
        n.error(t, "ERROR", "third, too soon", 2);
        await wait(60);
        assert.equal(sent.length, 1);
        clock.now = 31_000;
        n.error(t, "ERROR", "after the gap", 3);
        await wait(60);
        assert.equal(sent.length, 2);
        assert.match(sent[1]?.message.content ?? "", /\(\+2 similar matches since the last message; still running\)/);
        clock.now = 62_000;
        n.error(t, "ERROR", "the third wake-up", 4);
        await wait(60);
        assert.equal(sent.length, 3);
        clock.now = 100_000;
        n.error(t, "ERROR", "a fourth: no more wake-ups", 5);
        await wait(60);
        assert.equal(sent.length, 3, "three is the limit for a task");
        // The ones that did not wake it are reported when the task ends.
        n.exit(t);
        await wait(60);
        assert.equal(sent.length, 4);
    });

    test("the limit is per task", async () => {
        const clock = { now: 0 };
        const { n, sent, tasks } = notifier({
            clock,
            tasks: [task(), task({ id: "bg-2", name: "other" })],
            timing: { flushMs: 10, inFlightMs: 5, errorGapMs: 30_000, errorWakeups: 1 },
        });
        n.error(tasks.get("bg-1") as Task, "ERROR", "a", 0);
        n.error(tasks.get("bg-2") as Task, "ERROR", "b", 0);
        await wait(60);
        assert.equal(sent.length, 1);
        assert.match(sent[0]?.message.content ?? "", /bg-1[\s\S]*bg-2/);
    });
});

describe("one message at a time", () => {
    test("a new message waits until the agent has received the previous one", async () => {
        const { n, sent, tasks } = notifier();
        const t = tasks.get("bg-1") as Task;
        n.ready(t, "up", "up", 0);
        await wait(80);
        assert.equal(sent.length, 1);
        n.exit(t);
        await wait(120);
        assert.equal(sent.length, 1, "the first message has not been received yet");
        n.delivered();
        await wait(80);
        assert.equal(sent.length, 2);
    });

    test("a message that is never seen to arrive does not hold the next one for ever", async () => {
        const { n, sent, tasks } = notifier({
            timing: { flushMs: 10, inFlightMs: 100, errorGapMs: 30_000, errorWakeups: 3 },
        });
        const t = tasks.get("bg-1") as Task;
        n.ready(t, "up", "up", 0);
        await wait(40);
        n.exit(t);
        await wait(60);
        assert.equal(sent.length, 1);
        await wait(150);
        assert.equal(sent.length, 2);
    });

    test("a send that throws is tried again", async () => {
        let attempts = 0;
        const sent: string[] = [];
        const t = task();
        const n = new Notifier({
            send: (message) => {
                if (++attempts === 1) throw new Error("no session");
                sent.push(message.content);
            },
            now: () => 0,
            wake: () => true,
            task: () => t,
            tail: () => ({ text: "", cut: false }),
            timing: { flushMs: 15, inFlightMs: 50, errorGapMs: 30_000, errorWakeups: 3 },
        });
        n.ready(t, "up", "up", 0);
        await wait(120);
        assert.equal(sent.length, 1);
    });
});

describe("what makes an event unnecessary", () => {
    test("output the agent read that covers the matching line drops the wake-up, but not the exit", async () => {
        const { n, sent, tasks } = notifier();
        const t = tasks.get("bg-1") as Task;
        n.ready(t, "up", "up", 100);
        n.error(t, "ERROR", "boom", 200);
        n.seen("bg-1", 0, 150);
        n.exit(t);
        await wait(80);
        const content = sent[0]?.message.content ?? "";
        assert.doesNotMatch(content, /READY/);
        assert.match(content, /ERROR/);
        assert.match(content, /running, ran/);
        n.seen("bg-1", 0, 1_000);
    });

    test("stopping a task yourself leaves nothing to say about it", async () => {
        const { n, sent, tasks } = notifier();
        const t = tasks.get("bg-1") as Task;
        n.error(t, "ERROR", "boom", 0);
        n.exit(t);
        n.forget("bg-1");
        await wait(80);
        assert.equal(sent.length, 0);
    });

    test("you stopping a task is one line that does not wake the agent, sent at once", () => {
        const t = task({ state: "killed", reason: "by user", exitCode: 143 });
        const { n, sent } = notifier({ tasks: [t] });
        n.userKilled(t);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]?.message.customType, NOTE_TYPE);
        assert.deepEqual(sent[0]?.options, { triggerTurn: false });
        assert.match(sent[0]?.message.content ?? "", /stopped by the user: killed \(by user\)/);
    });

    test("wake off sends the message without waking the agent", async () => {
        const { n, sent, tasks } = notifier({ wake: () => false });
        n.ready(tasks.get("bg-1") as Task, "up", "up", 0);
        await wait(80);
        assert.deepEqual(sent[0]?.options, { triggerTurn: false });
    });

    test("a closed notifier says nothing, and a reopened one speaks again", async () => {
        const { n, sent, tasks } = notifier();
        const t = tasks.get("bg-1") as Task;
        n.ready(t, "up", "up", 0);
        n.close();
        await wait(80);
        assert.equal(sent.length, 0);
        n.ready(t, "up", "up", 0);
        assert.equal(n.pendingCount, 0);
        n.reopen();
        n.ready(t, "up", "up", 0);
        await wait(80);
        assert.equal(sent.length, 1);
    });

    test("more than twenty waiting events are counted and not kept", async () => {
        const { n, sent, tasks } = notifier({
            timing: { flushMs: 50, inFlightMs: 400, errorGapMs: 0, errorWakeups: 100 },
        });
        const t = tasks.get("bg-1") as Task;
        for (let index = 0; index < 25; index++) n.error(t, "ERROR", `line ${index}`, index);
        await wait(120);
        assert.match(sent[0]?.message.content ?? "", /^5 earlier background events omitted\./);
    });
});
