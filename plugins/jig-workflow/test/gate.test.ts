// Holds, through the real jig-core: a call a workflow lists is denied until the hold's condition holds, in the bound repositories
// only, and the gate never makes anything looser.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fingerprintOf } from "../src/plan.ts";
import { commit, headOf, ok, prJson, PASSED } from "./support.ts";
import { PLAN, useWorlds, world } from "./world.ts";
import type { World } from "./world.ts";

useWorlds();

/** A world with PROJ-1 active, the orders repository bound, and the example `feature` workflow started. */
async function started(t: Parameters<typeof world>[0], options: Parameters<typeof world>[1] = {}): Promise<World> {
    const w = await world(t, options);
    w.activate("PROJ-1");
    w.bind(w.orders);
    const result = await w.call({ action: "start" });
    assert.equal(result.isError, false, result.text);
    return w;
}

const inOrders = (w: World, file = "src/A.java") => path.join(w.orders, file);

function approvePlan(w: World): void {
    w.writePlan(PLAN);
    w.writeState((state) => {
        state.plan = { fingerprint: fingerprintOf(PLAN), at: "t", scenarios: 2 };
    });
}

function passTests(w: World, root = w.orders): void {
    w.writeState((state) => {
        state.tests[root] = {
            head: headOf(root),
            clean: true,
            passed: true,
            command: "npm test",
            exitCode: 0,
            timedOut: false,
            sandboxed: true,
            at: "t",
            durationMs: 1,
        };
    });
}

describe("holds on write and edit", () => {
    test("held in a bound repository until the plan is approved, with a reason that names the condition and the fix", async (t) => {
        const w = await started(t);
        for (const tool of ["write", "edit"]) {
            const held = await w.other_(tool, { path: inOrders(w), content: "x" });
            assert.equal(held.blocked, true, tool);
            assert.match(held.reason ?? "", /^Blocked by jig-core: held by workflow feature on PROJ-1: /);
            assert.match(
                held.reason ?? "",
                new RegExp(`${tool} waits for plan-approved, which is not met: .*plan.md does not exist`),
            );
        }
    });

    test("not held anywhere else: another repository, the workspace, or the ticket folder where the plan is written", async (t) => {
        const w = await started(t);
        for (const file of [
            path.join(w.other, "A.java"),
            path.join(w.workspace, "scratch.txt"),
            path.join(w.ticketDir(), "plan.md"),
            path.join(w.ticketDir(), "notes.md"),
        ]) {
            assert.equal((await w.other_("write", { path: file, content: "x" })).blocked, false, file);
        }
    });

    test("a relative path counts from Pi's folder, and ../ does not get out", async (t) => {
        const w = await started(t);
        assert.equal((await w.other_("write", { path: "orders-api-PROJ-1/src/A.java", content: "x" })).blocked, true);
        assert.equal(
            (await w.other_("write", { path: "unbound/../orders-api-PROJ-1/A.java", content: "x" })).blocked,
            true,
        );
        assert.equal(
            (await w.other_("write", { path: "orders-api-PROJ-1/../unbound/A.java", content: "x" })).blocked,
            false,
        );
    });

    test("released when the plan is approved, and back when the plan is edited", async (t) => {
        const w = await started(t);
        approvePlan(w);
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
        w.writePlan(PLAN.replace("Cache the price list.", "Cache the price list, per tenant."));
        const again = await w.other_("edit", { path: inOrders(w) });
        assert.equal(again.blocked, true);
        assert.match(again.reason ?? "", /plan.md changed since you approved it: run workflow submit-plan again/);
    });

    test("a link into a bound repository is held too", async (t) => {
        const w = await started(t);
        const { symlinkSync } = await import("node:fs");
        symlinkSync(w.orders, path.join(w.workspace, "shortcut"));
        assert.equal((await w.other_("write", { path: "shortcut/A.java", content: "x" })).blocked, true);
    });
});

describe("holds on git", () => {
    test("commit and push in the bound repository are held by the plan, named by folder or by path", async (t) => {
        const w = await started(t);
        for (const repo of ["orders-api-PROJ-1", w.orders]) {
            assert.equal((await w.other_("git", { action: "commit", repo, message: "m" })).blocked, true, repo);
            assert.equal((await w.other_("git", { action: "push", repo })).blocked, true, repo);
        }
    });

    test("other git actions, and other repositories, are not held", async (t) => {
        const w = await started(t);
        assert.equal((await w.other_("git", { action: "status", repo: "orders-api-PROJ-1" })).blocked, false);
        assert.equal((await w.other_("git", { action: "commit", repo: "unbound", message: "m" })).blocked, false);
        assert.equal((await w.other_("git", { action: "push", repo: w.other })).blocked, false);
        assert.equal(
            (await w.other_("git", { action: "commit", repo: "does-not-exist", message: "m" })).blocked,
            false,
            "the tool fails on it by itself",
        );
    });

    test("a push also waits for tests at HEAD, in that repository alone, and a new commit brings the hold back", async (t) => {
        const w = await started(t);
        w.bind(w.orders, w.other);
        approvePlan(w);
        assert.equal(
            (await w.other_("git", { action: "commit", repo: "orders-api-PROJ-1", message: "m" })).blocked,
            false,
            "the plan is approved",
        );
        const noTests = await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" });
        assert.equal(noTests.blocked, true);
        assert.match(
            noTests.reason ?? "",
            /git push waits for tests-pass-at-head, which is not met: orders-api-PROJ-1: no test run at [0-9a-f]{7}: run workflow test/,
        );
        passTests(w);
        assert.equal((await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" })).blocked, false);
        const unbound = await w.other_("git", { action: "push", repo: "unbound" });
        assert.equal(unbound.blocked, true, "the other bound repository has no test run, whatever orders has");
        assert.match(unbound.reason ?? "", /unbound: no test run/);
        commit(w.orders);
        assert.equal((await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" })).blocked, true);
    });
});

describe("holds on other tools, and on pull requests", () => {
    const custom = (holds: unknown[]) => ({
        shipping: {
            name: "shipping",
            match: { ticket: "^SHIP-\\d+$" },
            stages: [{ id: "build" }, { id: "done" }],
            holds,
        },
    });

    async function shipping(t: Parameters<typeof world>[0], holds: unknown[], run?: Parameters<typeof world>[1]) {
        const w = await world(t, { workflows: custom(holds), ...run });
        w.activate("PROJ-1");
        w.bind(w.orders);
        assert.equal((await w.call({ action: "start", name: "shipping" })).isError, false);
        return w;
    }

    test("a tool that names no repository is held for the work as a whole", async (t) => {
        const w = await shipping(t, [{ until: "review-done", calls: ["deploy run"] }]);
        const held = await w.other_("deploy", { action: "run" });
        assert.equal(held.blocked, true);
        assert.match(held.reason ?? "", /deploy run waits for review-done/);
        assert.equal(
            (await w.other_("deploy", { action: "status" })).blocked,
            false,
            "another action is not on the list",
        );
    });

    test("a hold on a per-repository condition with nothing bound says so", async (t) => {
        const w = await world(t, { workflows: custom([{ until: "tests-pass-at-head", calls: ["deploy"] }]) });
        w.activate("PROJ-1");
        await w.call({ action: "start", name: "shipping" });
        assert.match((await w.other_("deploy", { action: "run" })).reason ?? "", /no repository is bound to PROJ-1/);
    });

    test("pull-request-open is read from the last reading: the network is not touched, and status makes the reading", async (t) => {
        const w = await shipping(t, [{ until: "pull-request-open", calls: ["git push"] }], {
            run: () => ok(prJson({ headRefOid: "0".repeat(40), statusCheckRollup: PASSED })),
        });
        w.host.ran.length = 0;
        const before = await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" });
        assert.equal(before.blocked, true);
        assert.match(before.reason ?? "", /has not been looked up yet: run workflow status/);
        assert.equal(w.host.ran.length, 0, "a hold never waits on gh");
        // status reads the pull request for the conditions the stage and the holds need, and keeps the reading.
        const status = await w.call({ action: "status" });
        assert.equal(status.isError, false, status.text);
        assert.equal(w.host.ran.filter((run) => run.file === "gh").length, 1);
        const after = await w.other_("git", { action: "push", repo: "orders-api-PROJ-1" });
        assert.equal(after.blocked, false, after.reason ?? "");
        assert.equal(w.host.ran.filter((run) => run.file === "gh").length, 1, "the hold used the saved reading");
    });

    test("the workflow tool is never held, even by a workflow that lists it", async (t) => {
        const w = await shipping(t, [{ until: "review-done", calls: ["workflow"] }]);
        const status = await w.call({ action: "status" });
        assert.equal(status.blocked, false);
        assert.equal(status.isError, false);
    });
});

describe("when there is nothing to hold", () => {
    test("no active ticket: nothing is held", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        w.bind(w.orders);
        await w.call({ action: "start" });
        w.activate(undefined);
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
    });

    test("the active ticket is another one, with no workflow: nothing is held", async (t) => {
        const w = await started(t);
        w.activate("PROJ-2");
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
        w.activate("PROJ-1");
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, true);
    });

    test("a state file that cannot be read holds nothing, and status says so", async (t) => {
        const w = await started(t);
        writeFileSync(path.join(w.ticketDir(), "workflow.json"), "{ torn");
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
        assert.match((await w.call({ action: "status" })).text, /treated as not started; mend or delete the file/);
    });

    test("a workflow whose file is gone cannot be enforced, and status says so", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.workflow = "ghost";
        });
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
        assert.match(
            (await w.call({ action: "status" })).text,
            /no workflow file of that name is loaded.*holds are not enforced/,
        );
    });

    test("a hold that is satisfied loosens nothing: a rule that denies the call still denies it", async (t) => {
        const w = await started(t);
        approvePlan(w);
        assert.equal((await w.other_("write", { path: inOrders(w), content: "x" })).blocked, false);
        w.core.api.config.addRules([{ tool: "write", decision: "deny" }]);
        const denied = await w.other_("write", { path: inOrders(w), content: "x" });
        assert.equal(denied.blocked, true);
        assert.match(denied.reason ?? "", /a rule in the configuration denies this call/);
        // And a call the rules ask about still asks, with the hold satisfied.
        w.core.api.config.addRules([{ tool: "deploy", decision: "ask" }]);
        w.answers.push("decline");
        assert.equal((await w.other_("deploy", { action: "run" })).blocked, true);
        assert.equal(w.asked.length, 1);
    });

    test("a call that jig-core already denies stays denied, and one that it asks about still asks", async (t) => {
        const w = await started(t, { config: {} });
        approvePlan(w);
        passTests(w);
        // The agent folder is guarded: a hold that is satisfied does not open it.
        assert.equal(
            (await w.other_("write", { path: path.join(w.core.agentDir, "jig.json"), content: "{}" })).blocked,
            true,
        );
    });
});
