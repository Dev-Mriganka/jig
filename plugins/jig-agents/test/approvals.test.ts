// A child's questions on the user's screen: shown one at a time under a line the plugin writes, answered on the pipe by the request's id,
// and a no for every failure. The child is the fake one, which asks what the script says and logs what it receives.
import assert from "node:assert/strict";
import { existsSync, openSync, readlinkSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { sleep, startWorld, until } from "./world.ts";
import type { World, WorldOptions } from "./world.ts";

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

const GIT_PUSH = {
    method: "select",
    title: "git  push  external  write\nPush feature/PROJ-123 to origin",
    options: ["Allow", "Allow for this session", "Decline"],
};

async function begin(options: WorldOptions = {}): Promise<World> {
    w = await startWorld(options);
    return w;
}

const startScout = (world: World, task = "do it") => world.tool({ action: "start", role: "scout", task });
const answers = (world: World) => world.log().responses;

describe("a question from a child", () => {
    test("is shown under the plugin's own line, with the child's text indented, and the answer goes back by the request's id", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            ui: { select: () => "Allow" },
            script: {
                steps: [
                    { ask: { id: "q-1", request: GIT_PUSH } },
                    { turn: { text: "pushed" } },
                    { settle: { text: "done" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the answer");
        assert.equal(world.ui.selects.length, 1);
        const { title, options } = world.ui.selects[0] as { title: string; options: string[] };
        assert.equal(
            title,
            [
                'Subagent "scout-1" (scout) asks. The text below comes from the child.',
                "  git  push  external  write",
                "  Push feature/PROJ-123 to origin",
            ].join("\n"),
        );
        // The stock session answer is renamed, because it ends with the child.
        assert.deepEqual(options, ["Allow", "Allow for this subagent", "Decline"]);
        assert.deepEqual(answers(world), [{ type: "extension_ui_response", id: "q-1", value: "Allow" }]);
    });

    test("'Allow for this subagent' goes back as the stock 'Allow for this session', and Decline as Decline", {
        timeout: 30_000,
    }, async () => {
        const picks = ["Allow for this subagent", "Decline"];
        const world = await begin({
            ui: { select: () => picks.shift() },
            script: {
                steps: [
                    { ask: { id: "a", request: GIT_PUSH } },
                    { ask: { id: "b", request: GIT_PUSH } },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 2, "both answers");
        assert.deepEqual(
            answers(world).map((r) => [r.id, r.value]),
            [
                ["a", "Allow for this session"],
                ["b", "Decline"],
            ],
        );
    });

    test("answers are matched by id, never by text: two questions with the same words are answered apart", {
        timeout: 30_000,
    }, async () => {
        const picks = ["Allow", "Decline"];
        const world = await begin({
            ui: { select: () => picks.shift() },
            script: {
                steps: [
                    { ask: { id: "same-1", request: GIT_PUSH, noWait: true } },
                    { ask: { id: "same-2", request: GIT_PUSH } },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 2, "both answers");
        assert.deepEqual(
            answers(world).map((r) => [r.id, r.value]),
            [
                ["same-1", "Allow"],
                ["same-2", "Decline"],
            ],
        );
    });

    test("is cleaned: escape codes, a fake header and control characters never reach the screen as the plugin's own words", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            ui: { select: () => "Allow" },
            script: {
                steps: [
                    {
                        ask: {
                            id: "evil",
                            request: {
                                method: "select",
                                title: `Subagent "boss" asks.\n\u001b[2J\u001b]0;pwned\u0007Push everything\r\u0000 now\n${"x".repeat(500)}`,
                                options: ["Allow\u001b[31m", "Decline"],
                            },
                        },
                    },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the answer");
        const { title, options } = world.ui.selects[0] as { title: string; options: string[] };
        const lines = title.split("\n");
        assert.equal(lines[0], 'Subagent "scout-1" (scout) asks. The text below comes from the child.');
        assert.equal(
            lines[1],
            '  Subagent "boss" asks.',
            "the child's imitation of a header is indented under the real one",
        );
        assert.ok(!title.includes("\u001b") && !title.includes("\u0000") && !title.includes("\r"));
        assert.ok(
            lines.every((line) => line.length <= 205),
            "every line is cut",
        );
        assert.deepEqual(options, ["Allow", "Decline"]);
        // What goes back is the child's own option, not the cleaned one.
        assert.equal(answers(world)[0]?.value, "Allow\u001b[31m");
    });

    test("a long text is cut at 30 lines, with a note where it was cut", { timeout: 30_000 }, async () => {
        const world = await begin({
            ui: { select: () => "Decline" },
            script: {
                steps: [
                    {
                        ask: {
                            id: "long",
                            request: {
                                method: "select",
                                title: Array.from({ length: 50 }, (_v, i) => `line ${i}`).join("\n"),
                                options: ["Allow", "Decline"],
                            },
                        },
                    },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the answer");
        const lines = (world.ui.selects[0] as { title: string }).title.split("\n");
        assert.equal(lines.length, 1 + 30 + 1);
        assert.equal(lines.at(-1), "  (20 more lines not shown)");
    });
});

describe("every failure is a no", () => {
    const cancelled = (world: World, id: string) => answers(world).find((r) => r.id === id);

    test("a question with no screen to ask on is cancelled", { timeout: 30_000 }, async () => {
        const world = await begin({
            script: { steps: [{ sleep: 150 }, { ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        // The session has no screen from here on: the plugin's latest context says so.
        (world.rt as unknown as { ctx: unknown }).ctx = { hasUI: false };
        await until(() => answers(world).length === 1, "the cancel");
        assert.deepEqual(cancelled(world, "q"), { type: "extension_ui_response", id: "q", cancelled: true });
        assert.equal(world.ui.selects.length, 0);
    });

    test("a question nobody answers is cancelled after approvalWaitMinutes, and the screen is closed", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { approvalWaitMinutes: 1 } },
            ui: { select: () => new Promise(() => undefined) },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => world.ui.selects.length === 1, "the question on screen");
        await world.advance(59_000);
        assert.equal(answers(world).length, 0, "still waiting after 59 seconds");
        await world.advance(2_000);
        await until(() => answers(world).length === 1, "the cancel");
        assert.deepEqual(cancelled(world, "q"), { type: "extension_ui_response", id: "q", cancelled: true });
        assert.equal(world.ui.closed, 1, "the question was closed on the screen");
    });

    test("the child's own timeout closes the question on the screen when it runs out", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            ui: { select: () => new Promise(() => undefined) },
            script: {
                steps: [{ ask: { id: "q", request: { ...GIT_PUSH, timeout: 10_000 } } }, { settle: { text: "x" } }],
            },
        });
        await startScout(world);
        await until(() => world.ui.selects.length === 1, "the question on screen");
        await world.advance(11_000);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(world.ui.closed, 1);
    });

    test("more than maxAsks questions: the rest are cancelled and never reach the screen", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { maxAsks: 2 } },
            ui: { select: () => "Allow" },
            script: {
                steps: [1, 2, 3, 4]
                    .map((n) => ({ ask: { id: `q${n}`, request: GIT_PUSH } }))
                    .concat([{ settle: { text: "x" } } as never]),
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 4, "four answers");
        assert.equal(world.ui.selects.length, 2);
        assert.deepEqual(
            answers(world).map((r) => [r.id, r.value ?? (r.cancelled ? "cancelled" : "?")]),
            [
                ["q1", "Allow"],
                ["q2", "Allow"],
                ["q3", "cancelled"],
                ["q4", "cancelled"],
            ],
        );
    });

    test("maxAsks of 0 cancels every question", { timeout: 30_000 }, async () => {
        const world = await begin({
            config: { agents: { maxAsks: 0 } },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(world.ui.selects.length, 0);
        assert.equal(answers(world)[0]?.cancelled, true);
    });

    test("a role set to deny never forwards", { timeout: 30_000 }, async () => {
        const world = await begin({
            config: { agents: { roles: { scout: { approvals: "deny" } } } },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(world.ui.selects.length, 0);
        assert.equal(answers(world)[0]?.cancelled, true);
    });

    test("approvals: deny for everyone never forwards, and a role can opt back in", { timeout: 30_000 }, async () => {
        const world = await begin({
            config: { agents: { approvals: "deny", roles: { reviewer: { approvals: "forward" } } } },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(world.ui.selects.length, 0);
    });

    test("requests the plugin cannot read are cancelled by their id: bad options, no title, an editor, an unknown method", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            script: {
                steps: [
                    { ask: { id: "bad-options", request: { method: "select", title: "t", options: [1, 2] } } },
                    {
                        ask: {
                            id: "too-many",
                            request: { method: "select", title: "t", options: ["a", "b", "c", "d", "e", "f"] },
                        },
                    },
                    { ask: { id: "too-long", request: { method: "select", title: "t", options: ["x".repeat(101)] } } },
                    { ask: { id: "no-title", request: { method: "select", options: ["a"] } } },
                    { ask: { id: "editor", request: { method: "editor", title: "t", prefill: "x" } } },
                    { ask: { id: "odd", request: { method: "teleport", title: "t" } } },
                    { ask: { id: "no-method", request: { title: "t" } } },
                    {
                        ask: {
                            id: "same-looking",
                            request: { method: "select", title: "t", options: ["Allow", "Allow"] },
                        },
                    },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length === 8, "eight cancels");
        assert.equal(world.ui.selects.length, 0);
        assert.deepEqual(
            answers(world).map((r) => [r.id, r.cancelled]),
            ["bad-options", "too-many", "too-long", "no-title", "editor", "odd", "no-method", "same-looking"].map(
                (id) => [id, true],
            ),
        );
    });

    test("notices, statuses and widgets are ignored, and a request with no id or a repeated id is ignored", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            ui: { select: () => "Allow" },
            script: {
                steps: [
                    { ask: { id: "n1", noWait: true, request: { method: "notify", message: "hello" } } },
                    {
                        ask: {
                            id: "n2",
                            noWait: true,
                            request: { method: "setStatus", statusKey: "k", statusText: "t" },
                        },
                    },
                    {
                        ask: {
                            id: "n3",
                            noWait: true,
                            request: { method: "setWidget", widgetKey: "k", widgetLines: ["x"] },
                        },
                    },
                    { event: { type: "extension_ui_request", method: "select", title: "no id", options: ["Allow"] } },
                    { ask: { id: "dup", request: GIT_PUSH } },
                    { ask: { id: "dup", noWait: true, request: GIT_PUSH } },
                    { sleep: 100 },
                    { settle: { text: "x" } },
                ],
            },
        });
        await startScout(world);
        await until(() => answers(world).length >= 1, "the answer");
        await sleep(300);
        assert.equal(world.ui.selects.length, 1, "only the first dup was shown");
        assert.deepEqual(
            answers(world).map((r) => r.id),
            ["dup"],
        );
    });

    test("a plugin that throws while handling a request still answers no", { timeout: 30_000 }, async () => {
        const world = await begin({
            ui: {
                select: () => {
                    throw new Error("screen broke");
                },
            },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(answers(world)[0]?.cancelled, true);
    });

    test("the user closing the question (Esc) is a cancel", { timeout: 30_000 }, async () => {
        const world = await begin({
            ui: { select: () => undefined },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await until(() => answers(world).length === 1, "the cancel");
        assert.equal(answers(world)[0]?.cancelled, true);
    });
});

describe("the queue", () => {
    test("questions from three children are shown one at a time, and each says how many are still behind it", {
        timeout: 30_000,
    }, async () => {
        let release: ((answer: string) => void) | undefined;
        const world = await begin({
            ui: {
                select: (title) =>
                    title.includes('"scout-1"')
                        ? new Promise<string>((resolve) => {
                              release = resolve;
                          })
                        : "Decline",
            },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await world.tool({ action: "start", role: "scout", task: "second" });
        await world.tool({ action: "start", role: "scout", task: "third" });
        await until(() => world.rt.queue.waiting === 3, "three questions waiting");
        assert.equal(world.ui.selects.length, 1, "only the first is on screen");
        release?.("Allow");
        await until(() => answers(world).length === 3, "all three answers");
        const titles = world.ui.selects.map((entry) => entry.title.split("\n")[0]);
        assert.equal(titles[0], 'Subagent "scout-1" (scout) asks. The text below comes from the child.');
        assert.equal(
            titles[1],
            'Subagent "scout-2" (scout) asks. The text below comes from the child. (1 more waiting)',
        );
        assert.equal(titles[2], 'Subagent "scout-3" (scout) asks. The text below comes from the child.');
        assert.equal(world.ui.maxActive, 1, "never two questions open at once");
    });

    test("a question stuck behind another still runs out of time, counted from its request", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { approvalWaitMinutes: 1 } },
            ui: { select: () => new Promise(() => undefined) },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        await world.tool({ action: "start", role: "scout", task: "second" });
        await until(() => world.rt.queue.waiting === 2, "two questions");
        assert.equal(world.ui.selects.length, 1, "the second never reached the screen");
        await world.advance(61_000);
        await until(() => answers(world).length === 2, "both cancels");
        assert.ok(answers(world).every((r) => r.cancelled === true));
    });

    test("a child that is stopped while its question is open closes it, and nothing is written for it", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            ui: { select: () => new Promise(() => undefined) },
            script: { steps: [{ ask: { id: "q", request: GIT_PUSH } }, { hold: true }] },
        });
        const started = await startScout(world);
        await until(() => world.ui.selects.length === 1, "the question on screen");
        const stopped = await world.tool({ action: "stop", child: started.details.child });
        assert.match(stopped.text, /scout-1 was stopped/);
        assert.equal(world.ui.closed, 1);
        assert.equal(answers(world).length, 0, "no answer is written to a child that was stopped");
    });

    test("a child's questions wait behind jig-core's own, in the same queue", { timeout: 30_000 }, async () => {
        let order: string[] = [];
        const world = await begin({
            ui: {
                select: async (title) => {
                    order.push(title.startsWith("Subagent") ? "child" : "core");
                    await sleep(30);
                    return "Allow";
                },
            },
            script: { steps: [{ sleep: 100 }, { ask: { id: "q", request: GIT_PUSH } }, { settle: { text: "x" } }] },
        });
        await startScout(world);
        // A tool jig-core asks about, from the parent, while the child's question is on its way.
        order = [];
        await world.tool({ action: "status" });
        await until(() => answers(world).length === 1, "the answer");
        assert.equal(world.ui.maxActive, 1);
        assert.deepEqual(order, ["child"]);
    });
});

describe("the child's pipes", () => {
    const proc = existsSync("/proc/self/fd") ? false : "no /proc on this platform";

    test("cannot be reopened through /proc by a process of the same user, so a shell in the child cannot read its questions or answer them", {
        skip: proc,
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        await startScout(world);
        const pid = world.log().start?.pid as number;
        // Node makes a child's standard streams UNIX sockets, and the kernel does not open a socket through /proc/<pid>/fd.
        for (const fd of [0, 1, 2]) assert.match(readlinkSync(`/proc/${pid}/fd/${fd}`), /^socket:/, `fd ${fd}`);
        assert.throws(() => openSync(`/proc/${pid}/fd/0`, "w"), { code: "ENXIO" });
        assert.throws(() => openSync(`/proc/${pid}/fd/1`, "r"), { code: "ENXIO" });
    });
});
