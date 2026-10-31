// What the company's environments do to a call. jig-core decides from the kind of environment a call acts in: a test environment asks
// before a write, production refuses one, and a result from production (or from a test environment that asks for it) is masked.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { CallClass } from "../src/jig/types.ts";
import { call } from "./support/call.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
});

/** A tool of the company's own, as a stand-in: it acts in the environment its `env` names. */
function declareOrdersDb(w: World): void {
    w.api.declareTool({
        tool: "orders_db",
        plugin: "jig-acme-test",
        classify: (input): CallClass => ({
            environment: String(input.env),
            effect: input.effect === "write" ? "write" : "read",
        }),
    });
}

const WITH_EMAIL = "order 7 was placed by jane.doe@example.org";

describe("a call in the company's environments", () => {
    test("a write to dev or staging asks, and goes ahead when the user allows it", async () => {
        const w = await startWorld({ answer: "Allow" });
        world = w;
        declareOrdersDb(w);
        for (const env of ["dev", "staging"]) {
            const asked = w.ui.selects.length;
            const outcome = await call(w, "orders_db", { env, effect: "write" });
            assert.equal(outcome.blocked, false, env);
            assert.equal(w.ui.selects.length, asked + 1, `${env}: the user was asked`);
        }
    });

    test("a write to dev that the user declines does not run", async () => {
        world = await startWorld();
        declareOrdersDb(world);
        assert.equal((await call(world, "orders_db", { env: "dev", effect: "write" })).blocked, true);
    });

    test("a write to prod is refused outright, and the user is not even asked", async () => {
        world = await startWorld({ answer: "Allow" });
        declareOrdersDb(world);
        const outcome = await call(world, "orders_db", { env: "prod", effect: "write" });
        assert.equal(outcome.blocked, true);
        assert.equal(world.ui.selects.length, 0);
    });

    test("an environment the company never named counts as production", async () => {
        world = await startWorld({ answer: "Allow" });
        declareOrdersDb(world);
        assert.equal((await call(world, "orders_db", { env: "qa", effect: "write" })).blocked, true);
    });

    test("reads are not asked about; prod and staging results are masked, dev's is not", async () => {
        world = await startWorld();
        declareOrdersDb(world);
        const seen: Record<string, string> = {};
        for (const env of ["dev", "staging", "prod"]) {
            const outcome = await call(world, "orders_db", { env, effect: "read" }, WITH_EMAIL);
            assert.equal(outcome.blocked, false, env);
            seen[env] = outcome.text;
        }
        assert.equal(world.ui.selects.length, 0);
        assert.equal(seen.dev, WITH_EMAIL, "dev is a plain test environment");
        assert.match(seen.staging ?? "", /order 7 was placed by email#[0-9a-f]{6}$/, "staging asked to be masked");
        assert.match(seen.prod ?? "", /order 7 was placed by email#[0-9a-f]{6}$/, "production always is");
        assert.equal(seen.staging, seen.prod, "and the same address gets the same token everywhere");
    });
});
