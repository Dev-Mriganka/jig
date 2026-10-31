// Approvals: the three answers, the reason after a decline, the screens, and one question at a time.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { chooseKind, createApprovals } from "../src/approvals.ts";
import type { AskContext, AskRequest } from "../src/approvals.ts";
import type { Preview } from "../src/contract.ts";
import { fakeTerminal, fakeUi } from "./support/fakes.ts";
import type { FakeUiScript } from "./support/fakes.ts";

const HEADER = "git · push · external · write";

function request(overrides: Partial<AskRequest> = {}): AskRequest {
    return { header: HEADER, preview: { summary: "Push 2 commits to origin/main" }, kind: "dialog", ...overrides };
}

function context(script: FakeUiScript, mode: AskContext["mode"] = "rpc", signal?: AbortSignal) {
    const { ui, log } = fakeUi(script);
    const ctx: AskContext = { ui, mode, signal };
    return { ctx, log };
}

/** A fake review screen, answered by these key presses. */
function pressing(...keys: string[]): NonNullable<FakeUiScript["custom"]> {
    return (factory) =>
        new Promise((resolve) => {
            const terminal = fakeTerminal();
            const component = factory(terminal.tui, terminal.theme, terminal.keybindings, resolve) as Component;
            component.render(80);
            for (const key of keys) component.handleInput?.(key);
        });
}

describe("a dialog question", () => {
    test("shows the header and the summary, and offers three answers", async () => {
        const { ctx, log } = context({ select: () => "Allow" });
        await createApprovals().ask(ctx, request());
        assert.equal(log.selects.length, 1);
        assert.deepEqual(log.selects[0]?.options, ["Allow", "Allow for this session", "Decline"]);
        assert.match(log.selects[0]?.title ?? "", new RegExp(`${HEADER}\\nPush 2 commits to origin/main`));
    });

    test("Allow", async () => {
        const { ctx, log } = context({ select: () => "Allow" });
        const result = await createApprovals().ask(ctx, request());
        assert.deepEqual([result.answer, result.dismissed, result.reason], ["allow", false, undefined]);
        assert.equal(log.inputs.length, 0, "no reason is asked for an allow");
    });

    test("Allow for this session", async () => {
        const { ctx } = context({ select: () => "Allow for this session" });
        const result = await createApprovals().ask(ctx, request());
        assert.deepEqual([result.answer, result.dismissed], ["allow-session", false]);
    });

    test("Decline asks for a reason, which goes back with the answer", async () => {
        const { ctx, log } = context({ select: () => "Decline", input: () => "  not before the review  " });
        const result = await createApprovals().ask(ctx, request());
        assert.deepEqual([result.answer, result.dismissed, result.reason], ["decline", false, "not before the review"]);
        assert.equal(log.inputs.length, 1);
        assert.match(log.inputs[0]?.title ?? "", /model will read this/);
    });

    test("a decline without a reason is still a decline", async () => {
        for (const typed of [undefined, "", "   "]) {
            const { ctx } = context({ select: () => "Decline", input: () => typed });
            const result = await createApprovals().ask(ctx, request());
            assert.deepEqual(
                [result.answer, result.dismissed, result.reason],
                ["decline", false, undefined],
                String(typed),
            );
        }
    });

    test("a long reason is cut", async () => {
        const { ctx } = context({ select: () => "Decline", input: () => "r".repeat(2000) });
        const result = await createApprovals().ask(ctx, request());
        assert.equal(result.reason?.length, 500);
    });

    test("closing the selector is a decline that was never answered, and no reason is asked", async () => {
        const { ctx, log } = context({ select: () => undefined });
        const result = await createApprovals().ask(ctx, request());
        assert.deepEqual([result.answer, result.dismissed, result.reason], ["decline", true, undefined]);
        assert.equal(log.inputs.length, 0);
    });

    test("a screen that fails fails the question, so the call is blocked and not allowed", async () => {
        const { ctx } = context({
            select: () => {
                throw new Error("the connection to the client is gone");
            },
        });
        await assert.rejects(createApprovals().ask(ctx, request()), /connection to the client is gone/);
    });
});

describe("the review screen", () => {
    const review = request({
        kind: "review",
        preview: { summary: "Comment on PR 7", body: "The comment text\nsecond line", format: "markdown" },
    });

    test("is used in the terminal interface, and y allows", async () => {
        const { ctx, log } = context({ custom: pressing("y") }, "tui");
        const result = await createApprovals().ask(ctx, review);
        assert.deepEqual([result.answer, result.dismissed], ["allow", false]);
        assert.deepEqual([log.customs, log.selects.length], [1, 0]);
    });

    test("s allows for the session", async () => {
        const { ctx } = context({ custom: pressing("s") }, "tui");
        assert.equal((await createApprovals().ask(ctx, review)).answer, "allow-session");
    });

    test("n and Esc decline, and then the reason is asked", async () => {
        for (const key of ["n", "\u001b"]) {
            const { ctx, log } = context({ custom: pressing(key), input: () => "wrong branch" }, "tui");
            const result = await createApprovals().ask(ctx, review);
            assert.deepEqual(
                [result.answer, result.reason, result.dismissed],
                ["decline", "wrong branch", false],
                JSON.stringify(key),
            );
            assert.equal(log.inputs.length, 1);
        }
    });

    test("the o key opens the rendered preview in the browser and leaves the question open", async () => {
        const opened: Array<[Preview, string]> = [];
        const approvals = createApprovals({
            openPreview: async (preview, header) => {
                opened.push([preview, header]);
                return "opened in the browser";
            },
        });
        const { ctx } = context({ custom: pressing("o", "y") }, "tui");
        const result = await approvals.ask(ctx, review);
        assert.equal(result.answer, "allow");
        assert.deepEqual(opened, [[review.preview, HEADER]]);
    });

    test("a run that is aborted while the screen is open closes it", async () => {
        const controller = new AbortController();
        const { ctx } = context({ custom: pressing() }, "tui", controller.signal);
        const pending = createApprovals().ask(ctx, review);
        setTimeout(() => controller.abort(), 20);
        const result = await pending;
        assert.deepEqual([result.answer, result.dismissed], ["decline", true]);
    });

    test("is used only for the review kind: a dialog stays a selector even with a body", async () => {
        const { ctx, log } = context({ select: () => "Allow", custom: pressing("n") }, "tui");
        await createApprovals().ask(ctx, request({ kind: "dialog", preview: review.preview }));
        assert.deepEqual([log.customs, log.selects.length], [0, 1]);
    });
});

describe("hosts without the terminal interface, and the form kind", () => {
    const longBody = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const review = request({
        kind: "review",
        preview: { summary: "Update the description", body: longBody, format: "text" },
    });

    test("a review question in RPC mode is a selector, with the summary and the start of the body", async () => {
        const { ctx, log } = context({ select: () => "Allow for this session" }, "rpc");
        const result = await createApprovals().ask(ctx, review);
        assert.equal(result.answer, "allow-session");
        assert.deepEqual([log.customs, log.selects.length], [0, 1]);
        const title = log.selects[0]?.title ?? "";
        assert.ok(title.includes("Update the description"));
        assert.ok(title.includes("line 1\n") && title.includes("line 20"));
        assert.ok(!title.includes("line 21"));
        assert.match(title, /the rest is not shown here/);
    });

    test("a short body is shown whole, with no note", async () => {
        const { ctx, log } = context({ select: () => "Allow" }, "rpc");
        await createApprovals().ask(
            ctx,
            request({ kind: "review", preview: { summary: "s", body: "only\nthree\nlines" } }),
        );
        assert.ok(log.selects[0]?.title.includes("only\nthree\nlines"));
        assert.ok(!(log.selects[0]?.title ?? "").includes("the rest is not shown"));
    });

    test("a very long line in the body is cut too", async () => {
        const { ctx, log } = context({ select: () => "Allow" }, "rpc");
        await createApprovals().ask(
            ctx,
            request({ kind: "review", preview: { summary: "s", body: "x".repeat(5000) } }),
        );
        assert.ok((log.selects[0]?.title ?? "").length < 2500);
    });

    test("the form kind is a selector in this version, in the terminal too", async () => {
        for (const mode of ["rpc", "tui"] as const) {
            const { ctx, log } = context({ select: () => "Allow", custom: pressing("y") }, mode);
            const result = await createApprovals().ask(ctx, request({ kind: "form" }));
            assert.equal(result.answer, "allow", mode);
            assert.deepEqual([log.customs, log.selects.length], [0, 1], mode);
        }
    });
});

describe("one question at a time", () => {
    test("two questions asked together are shown one after the other, in order", async () => {
        const order: string[] = [];
        const { ctx, log } = context({
            select: async (title) => {
                order.push(`start ${title.split("\n")[1]}`);
                await new Promise((resolve) => setTimeout(resolve, 30));
                order.push(`end ${title.split("\n")[1]}`);
                return "Allow";
            },
        });
        const approvals = createApprovals();
        const [first, second, third] = await Promise.all([
            approvals.ask(ctx, request({ preview: { summary: "first" } })),
            approvals.ask(ctx, request({ preview: { summary: "second" } })),
            approvals.ask(ctx, request({ preview: { summary: "third" } })),
        ]);
        assert.equal(log.maxActive, 1, "never two screens at once");
        assert.deepEqual(order, ["start first", "end first", "start second", "end second", "start third", "end third"]);
        assert.deepEqual([first.answer, second.answer, third.answer], ["allow", "allow", "allow"]);
    });

    test("a decline and its reason are one turn: the next question waits for the reason too", async () => {
        const order: string[] = [];
        const { ctx, log } = context({
            select: async (title) => {
                order.push(`select ${title.split("\n")[1]}`);
                return title.includes("first") ? "Decline" : "Allow";
            },
            input: async () => {
                order.push("reason");
                await new Promise((resolve) => setTimeout(resolve, 20));
                return "because";
            },
        });
        const approvals = createApprovals();
        await Promise.all([
            approvals.ask(ctx, request({ preview: { summary: "first" } })),
            approvals.ask(ctx, request({ preview: { summary: "second" } })),
        ]);
        assert.deepEqual(order, ["select first", "reason", "select second"]);
        assert.equal(log.maxActive, 1);
    });

    test("a review screen and a selector are not shown together either", async () => {
        const { ctx, log } = context(
            {
                select: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return "Allow";
                },
                custom: async (factory) => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return pressing("y")(factory);
                },
            },
            "tui",
        );
        const approvals = createApprovals();
        await Promise.all([
            approvals.ask(ctx, request({ kind: "review", preview: { summary: "a", body: "b" } })),
            approvals.ask(ctx, request({ kind: "dialog" })),
            approvals.ask(ctx, request({ kind: "review", preview: { summary: "c", body: "d" } })),
        ]);
        assert.equal(log.maxActive, 1);
    });

    test("a question that fails does not stop the ones behind it", async () => {
        let calls = 0;
        const { ctx } = context({
            select: () => {
                calls++;
                if (calls === 1) throw new Error("first one broke");
                return "Allow";
            },
        });
        const approvals = createApprovals();
        const [first, second] = await Promise.allSettled([
            approvals.ask(ctx, request()),
            approvals.ask(ctx, request()),
        ]);
        assert.equal(first.status, "rejected");
        assert.equal(second.status, "fulfilled");
    });

    test("a plugin's own question takes a turn in the same queue (inTurn)", async () => {
        let open = 0;
        let mostOpen = 0;
        const held = async <T>(value: T): Promise<T> => {
            open++;
            mostOpen = Math.max(mostOpen, open);
            await new Promise((resolve) => setTimeout(resolve, 20));
            open--;
            return value;
        };
        const { ctx } = context({ select: () => held("Allow") });
        const approvals = createApprovals();
        const results = await Promise.all([
            approvals.ask(ctx, request()),
            approvals.inTurn(() => held("done")),
            approvals.ask(ctx, request()),
            approvals.inTurn(() => held("done")),
        ]);
        assert.equal(results[1], "done");
        assert.equal(mostOpen, 1, "a question of the plugin's and one of jig-core's are never open together");
    });

    test("a job that fails in its turn does not stop the ones behind it", async () => {
        const approvals = createApprovals();
        const [first, second] = await Promise.allSettled([
            approvals.inTurn(async () => {
                throw new Error("broke");
            }),
            approvals.inTurn(async () => "fine"),
        ]);
        assert.equal(first.status, "rejected");
        assert.deepEqual(second.status === "fulfilled" ? second.value : undefined, "fine");
    });

    test("a question whose run was aborted while it waited is not shown", async () => {
        const controller = new AbortController();
        const gate: { release?: () => void } = {};
        const { ctx: slow, log } = context({
            select: () =>
                new Promise<string>((resolve) => {
                    gate.release = () => resolve("Allow");
                }),
        });
        const { ctx: abortable, log: abortableLog } = context({ select: () => "Allow" }, "rpc", controller.signal);
        // The abortable question uses its own fake, but shares the queue through the same approvals object.
        const approvals = createApprovals();
        const firstQuestion = approvals.ask(slow, request({ preview: { summary: "first" } }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const secondQuestion = approvals.ask(abortable, request({ preview: { summary: "second" } }));
        controller.abort();
        gate.release?.();
        const [first, second] = await Promise.all([firstQuestion, secondQuestion]);
        assert.equal(first.answer, "allow");
        assert.deepEqual([second.answer, second.dismissed], ["decline", true]);
        assert.equal(log.selects.length, 1);
        assert.equal(abortableLog.selects.length, 0, "the aborted question never reached the screen");
    });
});

describe("how long the call waited", () => {
    test("is the time from the question being asked to the answer", async () => {
        let clock = 1_000;
        const { ctx } = context({
            select: () => {
                clock += 250;
                return "Allow";
            },
        });
        const result = await createApprovals({ now: () => clock }).ask(ctx, request());
        assert.equal(result.waitedMs, 250);
    });

    test("includes the time spent typing a reason", async () => {
        let clock = 0;
        const { ctx } = context({
            select: () => {
                clock += 100;
                return "Decline";
            },
            input: () => {
                clock += 900;
                return "no";
            },
        });
        const result = await createApprovals({ now: () => clock }).ask(ctx, request());
        assert.equal(result.waitedMs, 1000);
    });

    test("includes the time spent in the queue behind another question", async () => {
        let clock = 0;
        const { ctx } = context({
            select: () => {
                clock += 100;
                return "Allow";
            },
        });
        const approvals = createApprovals({ now: () => clock });
        const [first, second] = await Promise.all([approvals.ask(ctx, request()), approvals.ask(ctx, request())]);
        assert.equal(first.waitedMs, 100);
        assert.equal(second.waitedMs, 200);
    });
});

describe("which screen a call uses", () => {
    const withBody: Preview = { summary: "s", body: "b" };
    const withoutBody: Preview = { summary: "s" };

    test("the screen a rule or the tool chose, else a review when the preview has a body, else a dialog", () => {
        assert.equal(chooseKind(undefined, withBody), "review");
        assert.equal(chooseKind(undefined, withoutBody), "dialog");
        assert.equal(chooseKind("dialog", withBody), "dialog");
        assert.equal(chooseKind("review", withoutBody), "review");
        assert.equal(chooseKind("form", withBody), "form");
    });
});
