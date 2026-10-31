// A child's limits: the arithmetic on its own, and each limit stopping a looping fake child as the design says: told to wrap up, given
// two more turns or two more minutes, then aborted, with its partial report returned and the limit named.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_LIMITS } from "../src/config.ts";
import {
    costText,
    describe as describeLimit,
    GRACE_MS,
    GRACE_TURNS,
    graceOver,
    reached,
    wrapUpMessage,
} from "../src/limits.ts";
import { sleep, startWorld, until } from "./world.ts";
import type { Script, World, WorldOptions } from "./world.ts";

describe("the arithmetic", () => {
    const limits = { maxTurns: 10, maxMinutes: 5, maxCost: 1 };

    test("a limit is reached at its number, and not before", () => {
        assert.equal(reached(limits, { turns: 9, activeMs: 299_999, cost: 0.99 }), undefined);
        assert.equal(reached(limits, { turns: 10, activeMs: 0, cost: 0 }), "turns");
        assert.equal(reached(limits, { turns: 0, activeMs: 300_000, cost: 0 }), "minutes");
        assert.equal(reached(limits, { turns: 0, activeMs: 0, cost: 1 }), "cost");
    });

    test("turns come first, then minutes, then cost, when several are reached at once", () => {
        assert.equal(reached(limits, { turns: 10, activeMs: 999_999, cost: 5 }), "turns");
        assert.equal(reached(limits, { turns: 1, activeMs: 999_999, cost: 5 }), "minutes");
    });

    test("an unpriced model has no cost limit, whatever it spends", () => {
        assert.equal(reached(limits, { turns: 1, activeMs: 1, cost: undefined }), undefined);
        assert.equal(costText(undefined), "cost unknown");
        assert.equal(costText(0.456), "$0.46");
    });

    test("the grace ends after two more turns or two more minutes, whichever comes first", () => {
        const wrap = { limit: "turns" as const, turns: 10, activeMs: 60_000 };
        assert.equal(graceOver(wrap, { turns: 10 + GRACE_TURNS - 1, activeMs: 60_000 + GRACE_MS - 1, cost: 0 }), false);
        assert.equal(graceOver(wrap, { turns: 10 + GRACE_TURNS, activeMs: 60_000, cost: 0 }), true);
        assert.equal(graceOver(wrap, { turns: 10, activeMs: 60_000 + GRACE_MS, cost: 0 }), true);
    });

    test("the defaults and the words", () => {
        assert.deepEqual(DEFAULT_LIMITS, { maxTurns: 40, maxMinutes: 30, maxCost: 2 });
        assert.equal(describeLimit("turns", limits, { turns: 10, activeMs: 0, cost: 0 }), "the turn limit (10 turns)");
        assert.match(wrapUpMessage("cost", limits, { turns: 3, activeMs: 0, cost: 1.2 }), /Stopped at the limit/);
        assert.match(
            wrapUpMessage("cost", limits, { turns: 3, activeMs: 0, cost: 1.2 }),
            /the cost limit \(\$1; \$1\.20 used\)/,
        );
    });
});

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

const PRICED = { provider: "faux", id: "faux-1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };

async function begin(options: WorldOptions & { script: Script }): Promise<World> {
    w = await startWorld(options);
    return w;
}

const childOf = (world: World) => [...world.rt.children.values()][0];
const commandTypes = (world: World) => world.log().commands.map((c) => c.type);

describe("a looping child", () => {
    test("is stopped at the turn limit: told to write its report, given two more turns, then aborted, and the partial report comes back", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxTurns: 3 } } },
            script: { steps: [{ loop: { text: "still working on it", cost: 0, every: 30 } }] },
        });
        await world.tool({ action: "start", role: "scout", task: "loop" });
        await until(() => childOf(world)?.state === "failed", "the child to be stopped");
        const types = commandTypes(world);
        const steer = world.log().commands.find((c) => c.type === "steer");
        assert.match(steer?.message, /You have reached the turn limit \(3 turns\)\. Stop working now\./);
        assert.match(steer?.message, /Start it with "Stopped at the limit"/);
        assert.ok(types.indexOf("steer") < types.indexOf("abort"), "steer first, then abort");
        // Two more turns after the limit, not more: the child had taken 3 + 2 turns at most when it was aborted.
        assert.ok(
            (childOf(world)?.turns ?? 0) >= 5 && (childOf(world)?.turns ?? 0) <= 6,
            `turns: ${childOf(world)?.turns}`,
        );
        const message = await world.deliver();
        assert.match(message.content, /failed\./);
        assert.match(message.content, /scout-1 stopped at the turn limit \(3 turns\): /);
        assert.match(message.content, /still working on it/, "the partial report");
        assert.equal(message.details.watches[0].outcome, "failed");
    });

    test("is stopped at the time limit, which does not count the time spent waiting for you", {
        timeout: 30_000,
    }, async () => {
        let answer: ((value: string) => void) | undefined;
        const world = await begin({
            config: { agents: { limits: { maxMinutes: 1 } } },
            ui: {
                select: () =>
                    new Promise<string>((resolve) => {
                        answer = resolve;
                    }),
            },
            script: {
                steps: [
                    { ask: { id: "q", request: { method: "select", title: "t", options: ["Allow", "Decline"] } } },
                    { turn: { text: "working" } },
                    { hold: true },
                ],
            },
        });
        await world.tool({ action: "start", role: "scout", task: "wait" });
        await until(() => world.ui.selects.length === 1, "the question");
        await world.advance(10 * 60_000);
        assert.equal(commandTypes(world).includes("steer"), false, "ten minutes of waiting for you do not count");
        assert.match(world.rt.statusRows()[0] as string, /waiting for you/);
        answer?.("Allow");
        await until(() => childOf(world)?.turns === 1, "the turn after the answer");
        await world.advance(59_000);
        assert.equal(commandTypes(world).includes("steer"), false, "59 seconds of work is under the limit");
        await world.advance(2_000);
        await until(() => commandTypes(world).includes("steer"), "the wrap-up message");
        assert.match(
            world.log().commands.find((c) => c.type === "steer")?.message,
            /the time limit \(1 minutes; 1\.0 used\)/,
        );
        // The child holds and takes no turns, so the two minutes of grace run out.
        await world.advance(100_000);
        assert.equal(commandTypes(world).includes("abort"), false, "still inside the two minutes of grace");
        await world.advance(30_000);
        await until(() => childOf(world)?.state === "failed", "the abort");
        assert.equal(childOf(world)?.outcome?.kind, "limit");
        assert.equal(childOf(world)?.outcome?.limit, "minutes");
    });

    test("a timer fires even when the child is inside one long call and takes no turn", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxMinutes: 2 } } },
            script: { steps: [{ hold: true }] },
        });
        await world.tool({ action: "start", role: "scout", task: "long call" });
        await world.advance(121_000);
        await until(() => commandTypes(world).includes("steer"), "the wrap-up message");
        assert.equal(childOf(world)?.turns, 0);
    });

    test("is stopped at the cost limit, counted from the cost Pi reports, once the model has a price", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxCost: 0.5 } } },
            script: { model: PRICED, steps: [{ loop: { text: "spending", cost: 0.3, every: 40 } }] },
        });
        await world.tool({ action: "start", role: "scout", task: "spend" });
        await until(() => childOf(world)?.state === "failed", "the child to be stopped");
        assert.equal(childOf(world)?.outcome?.limit, "cost");
        const steer = world.log().commands.find((c) => c.type === "steer");
        assert.match(steer?.message, /the cost limit \(\$0\.5; \$\d\.\d\d used\)/);
        // Cost can overrun by the turns that were in flight: it is known only after the reply.
        assert.ok((childOf(world)?.used().cost ?? 0) >= 0.6);
        const message = await world.deliver();
        assert.match(message.content, /scout-1 stopped at the cost limit/);
    });

    test("an unpriced model reports no cost: only turns and minutes bound it, and status says so", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxCost: 0.01, maxTurns: 4 } } },
            script: { steps: [{ loop: { text: "free", cost: 0, every: 40 } }] },
        });
        await world.tool({ action: "start", role: "scout", task: "free" });
        await until(() => (childOf(world)?.turns ?? 0) >= 2, "two turns");
        const status = await world.tool({ action: "status" });
        assert.match(status.text, /cost unknown of \$0\.01/);
        await until(() => childOf(world)?.state === "failed", "the child to be stopped");
        assert.equal(childOf(world)?.outcome?.limit, "turns", "the turn limit stopped it, not the cost");
    });

    test("a role's own limits win over the general ones", { timeout: 30_000 }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxTurns: 30 }, roles: { scout: { maxTurns: 2 } } } },
            script: { steps: [{ loop: { text: "x", every: 30 } }] },
        });
        const result = await world.tool({ action: "start", role: "scout", task: "loop" });
        assert.match(result.text, /Limits: 2 turns, 30 minutes, \$2\.00/);
        await until(() => childOf(world)?.state === "failed", "the child to be stopped");
        assert.equal(childOf(world)?.outcome?.limit, "turns");
    });

    test("a child that finishes its report during the grace ends at the limit, and is not aborted", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxTurns: 2 } } },
            script: {
                steps: [{ loop: { text: "going", every: 150 } }],
                onSteer: [
                    { turn: { text: "Stopped at the limit: found nothing yet." } },
                    { settle: { text: "Stopped at the limit: found nothing yet." } },
                ],
            },
        });
        await world.tool({ action: "start", role: "scout", task: "loop" });
        await until(() => childOf(world)?.state === "failed", "the child to end");
        assert.equal(commandTypes(world).includes("abort"), false, "it settled by itself");
        assert.equal(childOf(world)?.outcome?.kind, "limit");
        assert.match(childOf(world)?.outcome?.text ?? "", /Stopped at the limit: found nothing yet\./);
    });

    test("a child that ignores abort, its input closing and SIGTERM is killed, in that order", {
        timeout: 40_000,
    }, async () => {
        const world = await begin({
            config: { agents: { limits: { maxTurns: 1 } } },
            script: {
                steps: [{ loop: { text: "stubborn", every: 30 } }],
                ignoreAbort: true,
                ignoreStdinEnd: true,
                ignoreSigterm: true,
            },
        });
        await world.tool({ action: "start", role: "scout", task: "stubborn" });
        const pid = (): number => world.log().start?.pid ?? 0;
        await until(() => commandTypes(world).includes("abort"), "the abort");
        // The waits are the design's: abort 5 s, input closed 5 s, SIGTERM 5 s. The clock moves; the child never answers.
        const seen: string[] = [];
        for (let i = 0; i < 60 && world.rt.host.alive(pid()); i++) {
            await world.advance(1000);
            await sleep(10);
            for (const entry of world.log().all) {
                const mark = entry.type === "command" ? entry.command.type : entry.type;
                if (["abort", "stdin-end", "sigterm-ignored"].includes(mark) && !seen.includes(mark)) seen.push(mark);
            }
        }
        assert.deepEqual(seen, ["abort", "stdin-end", "sigterm-ignored"]);
        assert.equal(world.rt.host.alive(pid()), false, "SIGKILL ended it");
        await childOf(world)?.done;
        assert.equal(childOf(world)?.state, "failed");
        assert.equal(childOf(world)?.outcome?.limit, "turns");
    });
});
