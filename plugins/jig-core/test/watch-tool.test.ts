// The `watch` tool and the whole path of a watch inside a real Pi session (the SDK with its scripted model): the tool's
// list and stop, a result that wakes the agent with one message, and the same result reaching other plugins.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { jig } from "../src/client.ts";
import { FIRST_POLL_MS } from "../src/watch/engine.ts";
import { fakeClock } from "./support/clock.ts";
import type { FakeClock } from "./support/clock.ts";
import { startWorld } from "./support/session.ts";
import type { World, WorldOptions } from "./support/session.ts";
import { rawRecords, tempState } from "./support/state.ts";
import { passed, savedFile, scripted } from "./support/watches.ts";

const state = tempState();
beforeEach(() => { state.start(); });

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
    state.stop();
});

const CONFIG = { environments: { prod: { kind: "production" } }, secrets: { backends: ["env"] } };
const SECOND = 1000;
const MINUTE = 60 * SECOND;

async function begin(options: WorldOptions = {}): Promise<{ w: World; clock: FakeClock }> {
    const clock = fakeClock();
    world = await startWorld({ config: CONFIG, ...options, clock });
    return { w: world, clock };
}

/** Waits for something that happens on Pi's own timers, such as a turn the session starts by itself. */
async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const limit = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > limit) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** The custom messages in the session, which is where a watch's message to the agent lands. */
const watchMessages = (w: World) => w.session.messages.filter((message) => message.role === "custom") as Array<{
    customType: string; content: string; display: boolean; details: { watches: Array<Record<string, unknown>> };
}>;

describe("the watch tool", () => {
    test("is a tool of the session, and the tool manager knows what it does", async () => {
        const { w } = await begin();
        const tool = w.session.getAllTools().find((candidate) => candidate.name === "watch");
        assert.ok(tool, "registered with Pi");
        assert.match(tool.description, /plugins start watches from their own tools/i);

        await w.call("watch", { action: "list" });
        await w.call("watch", { action: "stop", id: "zzzzzzzz" });
        assert.deepEqual(
            w.callRecords().map((r) => [r.tool, r.action, r.plugin, r.environment, r.effect, r.decision, r.decisionSource]),
            [
                ["watch", "list", "jig-core", "local", "read", "allow", "table"],
                ["watch", "stop", "jig-core", "local", "write", "allow", "table"],
            ],
        );
    });

    test("list with no watches says so", async () => {
        const { w } = await begin();
        const result = await w.call("watch", { action: "list" });
        assert.equal(result.isError, false);
        assert.equal(result.text, "No open watches, and none finished in the last 24 hours.");
    });

    test("list gives one line per watch: id, title, status, age, and the outcome when there is one", async () => {
        const { w, clock } = await begin();
        const { kind } = scripted(clock, "ci", (n, polled) => ((polled.spec as { done?: boolean }).done === true ? passed("all good") : { state: n }));
        jig().watches.registerKind(kind);
        const open = jig().watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        await clock.advance(30 * SECOND);
        const finished = jig().watches.start({ kind: "ci", spec: { done: true }, title: "deploy of build 17" });
        await clock.advance(3 * MINUTE);

        const result = await w.call("watch", { action: "list" });
        assert.equal(result.isError, false);
        assert.equal(result.text, [
            `${open} | checks of pull request 42 | open | 3 min`,
            `${finished} | deploy of build 17 | done | 3 min | passed`,
        ].join("\n"));
        const listed = (result.details as { watches: Array<{ id: string; status: string; describes?: string }> }).watches;
        assert.deepEqual(listed.map((watch) => [watch.id, watch.status, watch.describes]), [[open, "open", "a test watch"], [finished, "done", "a test watch"]]);
    });

    test("list shows a paused watch as paused", async () => {
        const { w, clock } = await begin();
        jig().watches.registerKind(scripted(clock, "ci", () => { throw new Error("down"); }).kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "checks" });
        await clock.advance(5 * MINUTE);
        assert.equal((await w.call("watch", { action: "list" })).text, `${id} | checks | paused | 5 min`);
    });

    test("stop cancels a watch: it ends as stopped, other plugins hear of it, and the agent is not woken", async () => {
        const { w, clock } = await begin();
        const { kind, polls } = scripted(clock, "ci", (n) => ({ state: n }));
        jig().watches.registerKind(kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        await clock.advance(FIRST_POLL_MS);

        const result = await w.call("watch", { action: "stop", id });
        assert.equal(result.isError, false, result.text);
        assert.equal(result.text, `Stopped watch ${id} (checks of pull request 42).`);
        assert.deepEqual(w.log.watchDone.map((event) => [event.id, event.result.outcome]), [[id, "stopped"]]);
        assert.equal(savedFile(state.dir, id).status, "done");

        await clock.advance(10 * MINUTE);
        assert.equal(polls.length, 1, "no more polls");
        assert.deepEqual(watchMessages(w), [], "nothing was sent to the agent: it asked for this itself");
        assert.equal((await w.call("watch", { action: "list" })).text.split(" | ").slice(2, 3).join(), "done");
    });

    test("stop tells the agent what went wrong in words it can act on", async () => {
        const { w, clock } = await begin();
        jig().watches.registerKind(scripted(clock, "ci", () => passed()).kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "t" });
        await clock.advance(5 * SECOND);

        const unknown = await w.call("watch", { action: "stop", id: "nope" });
        assert.equal(unknown.isError, true);
        assert.equal(unknown.text, 'No open watch has the id "nope": call watch with action "list" to see them.');
        const missing = await w.call("watch", { action: "stop" });
        assert.equal(missing.isError, true);
        assert.match(missing.text, /stop needs the id of a watch/);
        const finished = await w.call("watch", { action: "stop", id });
        assert.equal(finished.isError, true);
        assert.equal(finished.text, `Watch ${id} has already finished (passed).`);
    });

    test("a model that gives an action it does not have is turned away before the tool runs", async () => {
        const { w } = await begin();
        const result = await w.call("watch", { action: "start" });
        assert.equal(result.isError, true);
    });
});

describe("a watch that ends, inside a session", () => {
    test("wakes the agent with one message, once, and tells other plugins", async () => {
        const { w, clock } = await begin();
        jig().watches.registerKind(scripted(clock, "ci", () => ({
            state: 1,
            done: { outcome: "failed", summary: "2 of 12 checks failed: build, lint", details: "build: TS2304\nlint: 3 problems", links: ["https://ci.example/runs/9"] },
        })).kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });

        let context = "";
        w.faux.setResponses([(request) => { context = JSON.stringify(request.messages); return fauxAssistantMessage("I will look at the failed checks."); }]);

        await clock.advance(FIRST_POLL_MS);
        assert.equal(w.log.watchDone.length, 1, "other plugins hear of it at once");
        assert.deepEqual(w.log.watchDone[0], {
            id, kind: "ci", plugin: "jig-test", title: "checks of pull request 42",
            result: { outcome: "failed", summary: "2 of 12 checks failed: build, lint", details: "build: TS2304\nlint: 3 problems", links: ["https://ci.example/runs/9"] },
        });
        assert.deepEqual(watchMessages(w), [], "and the agent a second later");

        await clock.advance(SECOND);
        await until(() => w.session.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("failed checks")), "the turn");
        await w.session.waitForIdle();

        const messages = watchMessages(w);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.customType, "jig-watch");
        assert.equal(messages[0]?.display, true);
        assert.equal(messages[0]?.content, [
            'The watch "checks of pull request 42" failed.',
            "2 of 12 checks failed: build, lint",
            "Details:",
            "  build: TS2304",
            "  lint: 3 problems",
            "Links:",
            "  https://ci.example/runs/9",
        ].join("\n"));
        assert.deepEqual(messages[0]?.details, { watches: [{ id, kind: "ci", plugin: "jig-test", title: "checks of pull request 42", event: "finished", outcome: "failed" }] });
        assert.match(context, /The watch \\"checks of pull request 42\\" failed\./, "the model was given it");
        assert.equal(w.faux.state.callCount, 1, "and it took one turn");

        await clock.advance(10 * MINUTE);
        assert.equal(watchMessages(w).length, 1);
        assert.equal(w.log.watchDone.length, 1);
    });

    test("two that end together are one message and one turn", async () => {
        const { w, clock } = await begin();
        jig().watches.registerKind(scripted(clock, "ci", (_n, polled) => passed(`${(polled.spec as { name: string }).name} passed`)).kind);
        jig().watches.start({ kind: "ci", spec: { name: "build" }, title: "the build" });
        await clock.advance(400);
        jig().watches.start({ kind: "ci", spec: { name: "lint" }, title: "the lint" });

        w.faux.setResponses([fauxAssistantMessage("both are done")]);
        await clock.advance(FIRST_POLL_MS + 2 * SECOND);
        await until(() => w.session.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("both are done")), "the turn");
        await w.session.waitForIdle();

        const messages = watchMessages(w);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.content, 'The watch "the build" passed.\nbuild passed\n\nThe watch "the lint" passed.\nlint passed');
        assert.equal(w.log.watchDone.length, 2);
        assert.equal(w.faux.state.callCount, 1);
    });

    test("the user is told on the screen that a watch is still waiting, and the agent is not", async () => {
        const { w, clock } = await begin({ ui: { select: () => "Allow" } });
        jig().watches.registerKind(scripted(clock, "ci", (n) => ({ state: n })).kind);
        jig().watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        await clock.advance(31 * MINUTE);
        assert.deepEqual(
            w.ui?.notifications.filter((notice) => notice.message.startsWith("Still waiting")),
            [{ message: 'Still waiting for "checks of pull request 42": it has been running for 30 min.', type: "warning" }],
        );
        assert.deepEqual(watchMessages(w), []);
    });

    test("a watch that cannot be polled is paused: a notice on the screen and one message to the agent", async () => {
        const { w, clock } = await begin({ ui: { select: () => "Allow" } });
        jig().watches.registerKind(scripted(clock, "ci", () => { throw new Error("the login expired"); }).kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        w.faux.setResponses([fauxAssistantMessage("I will ask you to sign in again.")]);
        await clock.advance(3 * MINUTE);
        await until(() => w.session.messages.some((message) => message.role === "assistant"), "the turn");
        await w.session.waitForIdle();

        assert.match(w.ui?.notifications.find((notice) => notice.message.startsWith("Paused"))?.message ?? "", /^Paused "checks of pull request 42": 3 polls in a row failed \(the login expired\)/);
        const messages = watchMessages(w);
        assert.equal(messages.length, 1);
        assert.match(messages[0]?.content ?? "", /is paused: its last 3 polls in a row failed\. The last error was: the login expired/);
        assert.match(messages[0]?.content ?? "", new RegExp(`stop it with the watch tool \\(id ${id}\\)`));
        assert.equal(w.log.watchDone.length, 0);
    });

    test("what the agent is told has been redacted and masked, like a tool result: a secret and personal data never reach it", async () => {
        const { w, clock } = await begin({ realMasker: true, env: { JIG_TEST_TOKEN: "ci-token-7f3a9d2c41" } });
        const token = await jig().secrets.resolve("env:JIG_TEST_TOKEN");
        jig().watches.registerKind(scripted(clock, "ci", () => ({
            state: 1,
            done: {
                outcome: "failed",
                summary: `deploy by jane.doe@example.com failed with ${token}`,
                details: `\u001b[31merror\u001b[0m token=${token}\ncustomer contact jane.doe@example.com`,
                links: [`https://ci.example/run?token=${token}`],
            },
        })).kind);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "deploy" });
        w.faux.setResponses([fauxAssistantMessage("understood")]);
        await clock.advance(FIRST_POLL_MS + SECOND);
        await until(() => w.session.messages.some((message) => message.role === "assistant"), "the turn");
        await w.session.waitForIdle();

        const content = watchMessages(w)[0]?.content ?? "";
        assert.ok(!content.includes(token) && !content.includes("jane.doe@example.com") && !content.includes("\u001b"), content);
        assert.match(content, /deploy by email#[0-9a-f]{6} failed with \[redacted\]/);
        // The secret is removed first; the masker then sees `token=[redacted]` and drops that whole credential field.
        assert.match(content, /Details:\n {2}error \[removed:credential\]\n {2}customer contact email#[0-9a-f]{6}/);
        assert.equal(content.match(/email#[0-9a-f]{6}/g)?.[0], content.match(/email#[0-9a-f]{6}/g)?.[1], "one address, one token");
        assert.match(content, /https:\/\/ci\.example\/run\?token=\[redacted\]/);
        const saved = JSON.stringify(savedFile(state.dir, id));
        assert.ok(!saved.includes(token) && !saved.includes("jane.doe@example.com"), "and the saved result and the event are clean too");
        assert.ok(!JSON.stringify(w.log.watchDone).includes(token));
        assert.ok(!rawRecords(state.dir).includes(token));
    });
});
