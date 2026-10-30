// Field names a company plugin adds for the masker (`config.addMaskFields`): how they reach the masker, what happens to a
// name the masker refuses, and the backstop masking a production result with them.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig } from "../src/client.ts";
import { jigCore } from "../src/index.ts";
import { fakeMasker } from "./support/fakes.ts";
import { fakePi } from "./support/fake-pi.ts";
import { start } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { startWorld } from "./support/session.ts";
import type { World } from "./support/session.ts";
import { tempState } from "./support/state.ts";

const state = tempState();
beforeEach(() => { state.start(); });
afterEach(() => { state.stop(); });

function load(options: Parameters<typeof jigCore>[0] = {}) {
    const host = fakePi();
    jigCore(options)(host.pi);
    return { host, api: jig() };
}

describe("how the names reach the masker", () => {
    test("the masker is made with the names so far, and again only when names are added", () => {
        const made: string[][] = [];
        const { api } = load({ createMasker: (_dir, _now, fields) => { made.push([...fields]); return fakeMasker; } });
        api.mask.text("one");
        api.mask.text("two");
        assert.deepEqual(made, [[]], "no names yet, and the masker is reused");

        api.config.addMaskFields(["subscriberAlias", "contact_ref"]);
        assert.deepEqual(made, [[]], "a masker is built when it is next needed, not when names are added");
        api.mask.text("three");
        api.mask.text("four");
        assert.deepEqual(made, [[], ["subscriberAlias", "contact_ref"]]);

        api.config.addMaskFields(["accountHolder"]);
        api.mask.text("five");
        assert.deepEqual(made[2], ["subscriberAlias", "contact_ref", "accountHolder"], "names accumulate, in order");
        withdrawJig(api);
    });

    test("a name given twice is listed once, and a call with no names changes nothing the masker sees", () => {
        const made: string[][] = [];
        const { api } = load({ createMasker: (_dir, _now, fields) => { made.push([...fields]); return fakeMasker; } });
        api.config.addMaskFields(["subscriberAlias"]);
        api.config.addMaskFields(["subscriberAlias", "contactRef"]);
        api.config.addMaskFields([]);
        api.mask.text("x");
        assert.deepEqual(made, [["subscriberAlias", "contactRef"]]);
        withdrawJig(api);
    });

    test("the masker gets a copy, so a masker that keeps the list does not see later names", () => {
        const kept: Array<readonly string[]> = [];
        const { api } = load({ createMasker: (_dir, _now, fields) => { kept.push(fields); return fakeMasker; } });
        api.config.addMaskFields(["first"]);
        api.mask.text("x");
        api.config.addMaskFields(["second"]);
        assert.deepEqual(kept[0], ["first"]);
        withdrawJig(api);
    });

    test("the real masker masks the names from then on, and every token stays what it was, because the key is the day's", () => {
        const { api } = load();
        const before = api.mask.value({ email: "jane.doe@example.com", subscriberAlias: "Bobby" });
        assert.equal(before.subscriberAlias, "Bobby", "not a personal field until a company says so");

        api.config.addMaskFields(["subscriberAlias"]);
        const after = api.mask.value({ email: "jane.doe@example.com", subscriberAlias: "Bobby", subscriber_alias: "Bobby", orderId: "ord-1" });
        assert.equal(after.email, before.email, "the same email gives the same token");
        assert.match(after.subscriberAlias, /^personal#[0-9a-f]{6}$/);
        assert.equal(after.subscriber_alias, after.subscriberAlias, "case and separators do not matter, and one value is one token");
        assert.equal(after.orderId, "ord-1");
        withdrawJig(api);
    });

    test("a list that is not a list is a mistake at the call, because a bare string would be read letter by letter", () => {
        const { api } = load();
        assert.throws(() => api.config.addMaskFields("subscriberAlias" as unknown as string[]), TypeError);
        assert.throws(() => api.config.addMaskFields(undefined as unknown as string[]), TypeError);
        withdrawJig(api);
    });
});

describe("a name the masker refuses", () => {
    test("is left out, and the names around it still apply", () => {
        const { api } = load();
        api.config.addMaskFields(["subscriberAlias", "", "---", "contactRef"]);
        const out = api.mask.value({ subscriberAlias: "Bobby", contactRef: "c-42", orderId: "ord-1" });
        assert.match(out.subscriberAlias, /^personal#/);
        assert.match(out.contactRef, /^personal#/);
        assert.equal(out.orderId, "ord-1");
        withdrawJig(api);
    });

    test("does not stop masking: production results are still masked, not withheld", () => {
        const { api } = load();
        api.config.addMaskFields([""]);
        assert.doesNotThrow(() => api.mask.text("customer jane.doe@example.com"));
        assert.match(api.mask.text("customer jane.doe@example.com"), /^customer email#[0-9a-f]{6}$/);
        withdrawJig(api);
    });

    test("is a start-up problem shown to the user and by /jig, not a crash", async () => {
        const harness: Harness = await start({ plugins: (api) => api.config.addMaskFields(["good", "", 42 as unknown as string]) });
        try {
            const [notice] = harness.notifications();
            assert.match(notice ?? "", /^jig-core: 2 configuration problems\n/);
            assert.match(notice ?? "", /addMaskFields ignored "": an extra field name has no letters or digits/);
            assert.match(notice ?? "", /addMaskFields ignored a number: an extra field name has no letters or digits/);

            await harness.host.commands.get("jig")?.handler("", harness.ctx as never);
            const status = harness.notifications().at(-1) ?? "";
            assert.match(status, /Configuration problems \(2\):/);
            assert.match(status, /addMaskFields ignored "": /);
        } finally {
            await harness.shutdown();
        }
    });

    test("is shown as a short line whatever the name holds", async () => {
        const harness = await start({ plugins: (api) => api.config.addMaskFields(["\u0007" + "-".repeat(100)]) });
        try {
            const notice = harness.notifications()[0] ?? "";
            assert.match(notice, /addMaskFields ignored/);
            assert.ok(!notice.includes("\u0007"));
            assert.ok(notice.length < 300, String(notice.length));
        } finally {
            await harness.shutdown();
        }
    });
});

describe("in a Pi session", () => {
    let world: World | undefined;
    afterEach(async () => {
        await world?.close();
        world = undefined;
    });

    const CONFIG = { environments: { prod: { kind: "production" } } };
    const payload = JSON.stringify({ subscriberAlias: "Bobby", orderId: "ord-1" });

    test("a field added with addMaskFields is masked in a production result, and only there", async () => {
        world = await startWorld({ config: CONFIG, realMasker: true });
        jig().config.addMaskFields(["subscriberAlias"]);

        const production = await world.call("fake_tool", { env: "prod", output: payload });
        assert.equal(production.isError, false, production.text);
        assert.match(production.text, /"subscriberAlias":"personal#[0-9a-f]{6}"/);
        assert.ok(production.text.includes('"orderId":"ord-1"'), "an identifier is never masked");
        assert.ok(!production.text.includes("Bobby"));
        assert.deepEqual(production.ended?.result.structuredContent, { text: production.text }, "the structured copy is masked too");

        const local = await world.call("fake_tool", { env: "local", output: payload });
        assert.equal(local.text, payload, "a local result is left alone");
    });

    test("one added after the masker was already in use takes effect on the next result", async () => {
        world = await startWorld({ config: CONFIG, realMasker: true });
        const first = await world.call("fake_tool", { env: "prod", output: payload });
        assert.ok(first.text.includes("Bobby"), "not masked before the company named the field");

        jig().config.addMaskFields(["subscriberAlias"]);
        const second = await world.call("fake_tool", { env: "prod", output: payload });
        assert.ok(!second.text.includes("Bobby"));
        assert.match(second.text, /personal#/);
    });

    test("a refused name leaves the production backstop working for everything else", async () => {
        world = await startWorld({ config: CONFIG, realMasker: true });
        jig().config.addMaskFields(["", "subscriberAlias"]);
        const result = await world.call("fake_tool", { env: "prod", output: `${payload} jane.doe@example.com` });
        assert.equal(result.isError, false, result.text);
        assert.match(result.text, /personal#/);
        assert.match(result.text, /email#/);
    });
});
