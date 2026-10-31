// What a company adds beyond its environments, defaults and credentials: the field names that hold personal data in its own systems,
// and the files its own tools keep a login in. Both are additions only: jig-core's built-in masking and protected paths stay.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { MASK_FIELDS } from "../src/masking.ts";
import { ACME_LOGIN } from "../src/protection.ts";
import { call } from "./support/call.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
});

const ORDER = JSON.stringify({
    orderId: "ORD-7",
    status: "shipped",
    memberAlias: "mango-tree-44",
    loyaltyCardHolder: "Jane Doe",
    note: "reach me at jane.doe@example.org",
});

function declareOrdersDb(w: World): void {
    w.api.declareTool({
        tool: "orders_db",
        plugin: "jig-acme-test",
        classify: (input) => ({ environment: String(input.env), effect: "read" }),
    });
}

describe("masking the company's own field names", () => {
    test("two names are the company's", () => {
        assert.deepEqual([...MASK_FIELDS], ["memberAlias", "loyaltyCardHolder"]);
    });

    test("without the company plugin, jig-core's masking does not know them", async () => {
        world = await startWorld({ company: false, plugins: false });
        declareOrdersDb(world);
        const text = (await call(world, "orders_db", { env: "prod" }, ORDER)).text;
        assert.ok(text.includes("mango-tree-44") && text.includes("Jane Doe"), text);
        assert.equal(text.includes("jane.doe@example.org"), false, "its own rules still mask an email");
    });

    test("with it, their values become tokens in a production result, and identifiers stay", async () => {
        world = await startWorld();
        declareOrdersDb(world);
        const text = (await call(world, "orders_db", { env: "prod" }, ORDER)).text;
        const result = JSON.parse(text) as Record<string, string>;
        assert.match(result.memberAlias ?? "", /^personal#[0-9a-f]{6}$/);
        assert.match(result.loyaltyCardHolder ?? "", /^personal#[0-9a-f]{6}$/);
        assert.equal(result.orderId, "ORD-7");
        assert.equal(result.status, "shipped");
        assert.match(result.note ?? "", /email#/);
    });

    test("the names match without case or separators", async () => {
        world = await startWorld();
        const masked = world.api.mask.value({ member_alias: "mango-tree-44", LoyaltyCardHolder: "Jane Doe" });
        assert.match(masked.member_alias, /^personal#/);
        assert.match(masked.LoyaltyCardHolder, /^personal#/);
    });

    test("a dev result is not masked", async () => {
        world = await startWorld();
        declareOrdersDb(world);
        assert.equal((await call(world, "orders_db", { env: "dev" }, ORDER)).text, ORDER);
    });
});

describe("the company's protected path", () => {
    test("is a secret path, listed with the company as its source, next to the built-in ones", async () => {
        world = await startWorld();
        const entry = world.api.protectedPaths.list().find((item) => item.shown === ACME_LOGIN);
        assert.equal(entry?.kind, "secret");
        assert.equal(entry?.source, "company");
        assert.ok(entry?.path.endsWith("/.acme/credentials.json"));
        assert.ok(world.api.protectedPaths.list().some((item) => item.shown === "~/.ssh" && item.source === "default"));
    });

    test("Pi's file tools refuse to read or write it", async () => {
        world = await startWorld({ answer: "Allow" });
        for (const [tool, input] of [
            ["read", { path: ACME_LOGIN }],
            ["grep", { pattern: "token", path: ACME_LOGIN }],
            ["write", { path: ACME_LOGIN, content: "x" }],
            ["edit", { path: ACME_LOGIN, edits: [] }],
        ] as const) {
            const outcome = await call(world, tool, input);
            assert.equal(outcome.blocked, true, tool);
            assert.match(outcome.reason ?? "", /protected|credential|secret/i, tool);
        }
    });

    test("/jig rules lists it, so the user can see what the company protects", async () => {
        world = await startWorld();
        const lines = await world.jigLines("rules");
        assert.ok(
            lines.some((line) => line.includes(ACME_LOGIN) && line.includes("a company plugin")),
            lines.filter((line) => line.includes("acme")).join("\n"),
        );
    });
});
