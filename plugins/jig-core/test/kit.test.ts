// The helpers plugins share from `src/kit/`: small, stateless, and the same for every plugin that imports them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { untilAborted } from "../src/kit/abort.ts";
import { printable, stringOf } from "../src/kit/text.ts";
import { InputError, isObject } from "../src/kit/values.ts";

describe("isObject", () => {
    test("is true for plain objects and false for everything else", () => {
        for (const yes of [{}, { a: 1 }, Object.create(null), new Date(), new Map()]) assert.equal(isObject(yes), true);
        for (const no of [null, undefined, [], [1], "text", 0, 7, true, () => {}, Symbol("s")]) {
            assert.equal(isObject(no), false, String(typeof no));
        }
    });
});

describe("InputError", () => {
    test("is a TypeError, which is how jig-core reads `invalid input`, with its own name", () => {
        const error = new InputError("the id is wrong");
        assert.ok(error instanceof TypeError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, "InputError");
        assert.equal(error.message, "the id is wrong");
    });
});

describe("printable", () => {
    test("turns control characters into ? and cuts a long name at 60 characters", () => {
        assert.equal(printable("plain"), "plain");
        assert.equal(printable("a\nb\u001b[31m\u007f"), "a?b?[31m?");
        assert.equal(printable("x".repeat(60)), "x".repeat(60));
        assert.equal(printable("x".repeat(61)), `${"x".repeat(60)}...`);
    });
});

describe("stringOf", () => {
    test("is String(value), and a stand-in when the value cannot be turned into text", () => {
        assert.equal(stringOf(12), "12");
        assert.equal(stringOf(undefined), "undefined");
        assert.equal(stringOf(Object.create(null)), "(cannot be shown)");
        const hostile = {
            toString() {
                throw new Error("boom");
            },
        };
        assert.equal(stringOf(hostile), "(cannot be shown)");
    });
});

describe("untilAborted", () => {
    test("gives the work's answer when the signal does not fire", async () => {
        assert.equal(await untilAborted(Promise.resolve("done"), new AbortController().signal), "done");
        await assert.rejects(untilAborted(Promise.reject(new Error("failed")), new AbortController().signal), /failed/);
    });

    test("rejects with the signal's reason when work that ignores its signal is still running", async () => {
        const controller = new AbortController();
        const never = new Promise<string>(() => {});
        const waiting = untilAborted(never, controller.signal);
        controller.abort(new Error("stopped"));
        await assert.rejects(waiting, /stopped/);
    });

    test("an already aborted signal rejects at once, and a later failure of the work is not left unhandled", async () => {
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", record);
        try {
            const reason = new Error("early");
            const work = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late failure")), 5));
            await assert.rejects(untilAborted(work, AbortSignal.abort(reason)), /early/);
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", record);
        }
    });

    test("stops listening to the signal once the work is over", async () => {
        const controller = new AbortController();
        await untilAborted(Promise.resolve(1), controller.signal);
        // Aborting afterwards changes nothing and throws nothing.
        controller.abort();
    });
});
