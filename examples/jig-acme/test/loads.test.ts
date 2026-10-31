// jig-acme loaded as Pi loads it: after the real jig-core and every built Jig plugin, in the fake Pi that jig-core's own tests use.
// What matters to a company is that nothing is reported as wrong, that each section it gave defaults for is valid, and that
// `/jig` shows what it set up.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DEFAULTS } from "../src/defaults/index.ts";
import { ENVIRONMENTS } from "../src/environments.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
});

describe("loaded after jig-core and every built plugin", () => {
    test("nothing is reported as wrong, at start-up or in /jig", async () => {
        world = await startWorld();
        assert.deepEqual(await world.problems(), []);
        const announced = world.ui.notifications.filter((item) => /configuration problem/.test(item.message));
        assert.deepEqual(announced, [], "the session start announces no problem");
        const lines = await world.jigLines();
        assert.equal(
            lines.some((line) => /incomplete/.test(line)),
            false,
            "no company default is left incomplete",
        );
    });

    test("every section the company gives defaults for is valid, as the plugin checks it, and /jig says it is loaded", async () => {
        world = await startWorld();
        const lines = await world.jigLines();
        const sections = lines.find((line) => line.startsWith("Plugin sections in the file:")) ?? "";
        assert.deepEqual(Object.keys(DEFAULTS).sort(), [
            "api",
            "git",
            "jira",
            "logs",
            "memory",
            "mongo",
            "ops",
            "sandbox",
            "theme",
        ]);
        for (const [name, defaults] of Object.entries(DEFAULTS)) {
            assert.deepEqual(world.api.config.section(name), defaults, `${name}: the plugin got the defaults as given`);
            assert.ok(sections.includes(`${name} (loaded)`), `${name}: /jig says it is loaded; it says: ${sections}`);
        }
    });

    test("/jig lists the environments, and says what is still missing for this user", async () => {
        world = await startWorld();
        const lines = await world.jigLines();
        assert.ok(
            lines.includes(
                "jig-acme: environments dev (test), staging (test), prod (production); sign-in acme-sso; transport acme-gateway; tunnel acme-bastion",
            ),
            lines.join("\n"),
        );
        assert.ok(lines.some((line) => /acme\.bastion\.user is not set/.test(line)));

        const set = await startWorld({ personal: { acme: { bastion: { user: "jdoe" } } } });
        const after = await set.jigLines();
        await set.close();
        assert.equal(
            after.some((line) => /acme\.bastion\.user/.test(line)),
            false,
            "the reminder goes when the setting is there",
        );
    });

    test("the environments are the kinds the company named, and a name nobody defined is production", async () => {
        world = await startWorld();
        for (const [name, config] of Object.entries(ENVIRONMENTS)) {
            assert.equal(world.api.environments.kindOf(name), config.kind, name);
        }
        assert.equal(world.api.environments.kindOf("qa"), "production", "a name nobody defined counts as production");
    });

    test("it does not matter whether jig-acme loads before jig-core or after it", async () => {
        const after = await startWorld();
        const linesAfter = await after.jigLines();
        const sectionsAfter = after.api.config.section("logs");
        await after.close();

        world = await startWorld({ acmeFirst: true });
        assert.deepEqual(await world.problems(), []);
        assert.deepEqual(world.api.config.section("logs"), sectionsAfter);
        assert.deepEqual(
            (await world.jigLines()).filter((line) => line.startsWith("jig-acme:")),
            linesAfter.filter((line) => line.startsWith("jig-acme:")),
        );
    });

    test("with only jig-core loaded it still starts, and has nothing to complain about", async () => {
        // A user may load some Jig plugins only; defaults for a section nobody registered change nothing.
        world = await startWorld({ plugins: false });
        assert.deepEqual(await world.problems(), []);
        assert.ok((await world.jigLines()).some((line) => line.startsWith("jig-acme: environments")));
    });
});
