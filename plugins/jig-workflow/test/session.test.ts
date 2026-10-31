// The plugin in a session: the line at its start, the events of other plugins kept as evidence, the /workflow command, what
// follows a compaction, and the folders and files it guards.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fingerprintOf } from "../src/plan.ts";
import { commit, headOf, ok, PASSED, prJson } from "./support.ts";
import { PLAN, useWorlds, world } from "./world.ts";
import type { World } from "./world.ts";

useWorlds();

async function started(t: Parameters<typeof world>[0], options: Parameters<typeof world>[1] = {}): Promise<World> {
    const w = await world(t, options);
    w.activate("PROJ-1");
    w.bind(w.orders);
    assert.equal((await w.call({ action: "start" })).isError, false);
    return w;
}

/** A second session over the same files: what happens when Pi is started again on the ticket. */
async function restart(w: World): Promise<void> {
    w.notices.length = 0;
    await w.pi.fire("session_start", { reason: "resume" }, w.ctx);
}

describe("the line at the start of a session", () => {
    test("says the stage and what is missing, from what is known without the network", async (t) => {
        const w = await started(t);
        await restart(w);
        assert.deepEqual(w.notices, [
            {
                text: "workflow feature on PROJ-1: stage understand; missing: notes-updated (/workflow shows more)",
                level: "info",
            },
        ]);
    });

    test("when nothing is missing, it says so", async (t) => {
        const w = await started(t);
        w.writeNotes("# notes\nlearned\n");
        await restart(w);
        assert.match(w.notices[0]?.text ?? "", /stage understand; nothing is missing to leave it/);
    });

    test("a ticket with no workflow is told which one matches, and a ticket nothing matches is left alone", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        await restart(w);
        assert.equal(w.notices[0]?.text, "PROJ-1 has no workflow; feature matches it: /workflow start feature");
        w.activate("ABC-1");
        await restart(w);
        assert.deepEqual(w.notices, []);
        w.activate(undefined);
        await restart(w);
        assert.deepEqual(w.notices, []);
    });

    test("a state file that cannot be read is said, and a session with no screen says nothing", async (t) => {
        const w = await started(t);
        writeFileSync(path.join(w.ticketDir(), "workflow.json"), "{ torn");
        await restart(w);
        assert.match(w.notices[0]?.text ?? "", /PROJ-1: .*workflow.json cannot be read/);
        const quiet = await world(t, { ui: false });
        quiet.activate("PROJ-1");
        await restart(quiet);
        assert.deepEqual(quiet.notices, []);
    });

    test("the plugin does not start a workflow by itself", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        await restart(w);
        assert.equal(w.state(), undefined);
    });
});

describe("after a compaction", () => {
    test("the agent is told where the work is, as a message and not in the prompt", async (t) => {
        const w = await started(t);
        await w.pi.fire("session_compact", {}, w.ctx);
        assert.equal(w.pi.messages.length, 1);
        const sent = w.pi.messages[0];
        assert.equal(sent?.message.customType, "jig-workflow-status");
        assert.match(
            sent?.message.content ?? "",
            /^Still on the workflow after compaction\.\nPROJ-1 · feature · stage 1 of 7: understand/,
        );
        assert.deepEqual(sent?.options, { triggerTurn: false });
    });

    test("a ticket with no workflow is not told anything", async (t) => {
        const w = await world(t);
        w.activate("PROJ-1");
        await w.pi.fire("session_compact", {}, w.ctx);
        assert.deepEqual(w.pi.messages, []);
    });
});

describe("a review that was approved", () => {
    const approved = (w: World, over: Record<string, unknown> = {}) => ({
        reviewId: "2026-10-31T09-00-00Z",
        scope: "branch",
        ticket: "PROJ-1",
        repos: [{ repo: "orders-api-PROJ-1", root: w.orders, head: headOf(w.orders) }],
        covered: true,
        files: [],
        method: "passkey",
        ...over,
    });

    test("is kept for the bound repository, and review-done holds at that commit", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.stage = "review";
        });
        assert.match(
            (await w.call({ action: "advance" })).text,
            /review-done\n {4}orders-api-PROJ-1: no approved review covers/,
        );
        w.pi.publish("jig-review:approved", approved(w));
        assert.equal(w.state()?.reviews.length, 1);
        assert.match((await w.call({ action: "advance" })).text, /Moved PROJ-1 from review to deliver/);
    });

    test("a new commit ends it, and the same review is not kept twice", async (t) => {
        const w = await started(t);
        w.pi.publish("jig-review:approved", approved(w));
        w.pi.publish("jig-review:approved", approved(w));
        assert.equal(w.state()?.reviews.length, 1);
        commit(w.orders);
        w.writeState((state) => {
            state.stage = "review";
        });
        assert.match(
            (await w.call({ action: "advance" })).text,
            /no approved review covers [0-9a-f]{7} \(the last one covered [0-9a-f]{7}\)/,
        );
    });

    test("an approval that covers nothing, or is for another ticket or another repository, is ignored", async (t) => {
        const w = await started(t);
        for (const payload of [
            approved(w, { covered: false }),
            approved(w, { ticket: "PROJ-9" }),
            approved(w, { repos: [{ repo: "unbound", root: w.other, head: headOf(w.other) }] }),
            approved(w, { repos: [{ repo: "orders-api-PROJ-1", root: w.orders, head: "short" }] }),
            "not an event",
            null,
        ]) {
            w.pi.publish("jig-review:approved", payload);
        }
        assert.deepEqual(w.state()?.reviews, []);
    });

    test("nothing is kept for a ticket with no workflow, or when no ticket is active", async (t) => {
        const w = await world(t);
        w.bind(w.orders);
        w.activate("PROJ-1");
        w.pi.publish("jig-review:approved", approved(w));
        assert.equal(w.state(), undefined);
        w.activate(undefined);
        w.pi.publish("jig-review:approved", approved(w));
        assert.equal(w.state(), undefined);
    });
});

describe("a CI watch that ended", () => {
    const finished = (w: World, over: Record<string, unknown> = {}) => ({
        repo: "acme/orders-api",
        service: "orders-api",
        system: "github-actions",
        sha: headOf(w.orders),
        finish: "required",
        outcome: "passed",
        summary: "ok",
        ...over,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

    test("a pull request at HEAD with checks still running passes once the required checks passed in the watch", async (t) => {
        const custom = {
            delivery: { name: "delivery", stages: [{ id: "deliver", exit: ["checks-pass"] }, { id: "done" }] },
        };
        const w = await world(t, { workflows: custom });
        w.activate("PROJ-1");
        w.bind(w.orders);
        await w.call({ action: "start", name: "delivery" });
        (w.host as unknown as { run: unknown }).run = async () =>
            ok(prJson({ headRefOid: headOf(w.orders), statusCheckRollup: [{ status: "IN_PROGRESS" }, ...PASSED] }));
        assert.match(
            (await w.call({ action: "advance" })).text,
            /checks-pass\n {4}orders-api-PROJ-1: 1 of 3 checks are still running/,
        );
        w.pi.publish("jig-ops:ci-finished", finished(w));
        await settle();
        assert.equal(w.state()?.ci.length, 1);
        assert.match((await w.call({ action: "advance" })).text, /Moved PROJ-1 from deliver to done/);
    });

    test("another repository, a short commit, or a watch of one check is ignored", async (t) => {
        const w = await started(t);
        for (const payload of [
            finished(w, { repo: "acme/other" }),
            finished(w, { sha: "abc" }),
            finished(w, { finish: "check" }),
            finished(w, { outcome: "timed-out" }),
            "x",
        ]) {
            w.pi.publish("jig-ops:ci-finished", payload);
        }
        await settle();
        assert.deepEqual(w.state()?.ci, []);
    });

    test("the same watch result is kept once", async (t) => {
        const w = await started(t);
        w.pi.publish("jig-ops:ci-finished", finished(w));
        await settle();
        w.pi.publish("jig-ops:ci-finished", finished(w));
        await settle();
        assert.equal(w.state()?.ci.length, 1);
    });
});

describe("the /workflow command", () => {
    test("alone it shows the status of this session's work", async (t) => {
        const w = await started(t);
        const [said] = await w.command("");
        assert.match(said?.text ?? "", /^PROJ-1 · feature · stage 1 of 7: understand/);
    });

    test("list shows the workflows and the files that failed", async (t) => {
        const w = await world(t, { workflows: { broken: "{ nope" } });
        const [said] = await w.command("list");
        assert.match(said?.text ?? "", /^feature:/);
        assert.match(said?.text ?? "", /broken.json: not valid JSON/);
    });

    test("reload reads the files again, and counts what failed", async (t) => {
        const w = await world(t);
        writeFileSync(
            path.join(w.workflows, "bugfix.json"),
            JSON.stringify({ name: "bugfix", stages: [{ id: "fix" }] }),
        );
        writeFileSync(path.join(w.workflows, "bad.json"), "[]");
        assert.deepEqual(await w.command("reload"), [
            { text: "Read 2 workflows; 1 file could not be used (/workflow list says why).", level: "warning" },
        ]);
        writeFileSync(path.join(w.workflows, "bad.json"), JSON.stringify({ name: "bad", stages: [{ id: "x" }] }));
        assert.deepEqual(await w.command("reload"), [{ text: "Read 3 workflows.", level: "info" }]);
    });

    test("start takes a name, a ticket, both or neither", async (t) => {
        const w = await world(t, { workflows: { bugfix: { name: "bugfix", stages: [{ id: "fix" }] } } });
        w.activate("PROJ-1");
        assert.match((await w.command("start bugfix"))[0]?.text ?? "", /^Started bugfix on PROJ-1\./);
        assert.match((await w.command("start feature PROJ-2"))[0]?.text ?? "", /^Started feature on PROJ-2\./);
        assert.match((await w.command("start PROJ-3"))[0]?.text ?? "", /^Started feature on PROJ-3\./);
        w.writeNotes("", "PROJ-4");
        w.activate("PROJ-4");
        assert.match((await w.command("start"))[0]?.text ?? "", /^Started feature on PROJ-4\./);
        assert.equal(w.state("PROJ-1")?.workflow, "bugfix");
    });

    test("start over a workflow that has state asks you, with what would be lost", async (t) => {
        const w = await started(t);
        w.writeState((state) => {
            state.plan = { fingerprint: fingerprintOf(PLAN), at: "t", scenarios: 2 };
        });
        w.confirm = false;
        assert.match((await w.command("start feature"))[0]?.text ?? "", /Nothing changed: PROJ-1 keeps its workflow/);
        assert.ok(w.state()?.plan);
        w.confirm = true;
        const [said] = await w.command("start feature");
        assert.match(said?.text ?? "", /^Started feature on PROJ-1\./);
        assert.equal(w.state()?.plan, undefined);
    });

    test("mistakes are said in a line, and an unknown word shows the usage", async (t) => {
        const w = await world(t);
        // One word that is no workflow's name is taken for a ticket, and nothing matches it.
        assert.match((await w.command("start nope"))[0]?.text ?? "", /no workflow matches nope: name one\. feature/);
        assert.match((await w.command("start nope PROJ-1"))[0]?.text ?? "", /no workflow is called "nope" \(feature\)/);
        assert.match((await w.command("start a b c"))[0]?.text ?? "", /Use \/workflow/);
        assert.match(
            (await w.command("bogus"))[0]?.text ?? "",
            /Use \/workflow, \/workflow list, \/workflow start \[name\] \[ticket\], or \/workflow reload\./,
        );
        const [warned] = await w.command("start feature");
        assert.equal(warned?.level, "warning", "no active ticket is a mistake in the input, not a fault");
    });
});

describe("the folders and files it guards", () => {
    test("the folders workflows are read from, and the project's, cannot be written by Pi's file tools", async (t) => {
        const w = await world(t);
        const guarded = w.core.api.protectedPaths
            .list()
            .filter((entry) => entry.kind === "guarded")
            .map((entry) => entry.path);
        assert.ok(guarded.includes(w.workflows), "the configured folder");
        assert.ok(guarded.includes(path.join(w.workspace, ".pi", "workflows")), "the project's folder, trusted or not");
        const refused = await w.other_("write", { path: path.join(w.workflows, "feature.json"), content: "{}" });
        assert.equal(refused.blocked, true);
        assert.match(refused.reason ?? "", /is guarded/);
    });

    test("a ticket that becomes active later has its state file guarded the first time it is looked at", async (t) => {
        const w = await started(t);
        mkdirSync(w.ticketDir("PROJ-2"), { recursive: true });
        const copy = { ...(w.state() as Record<string, unknown>), ticket: "PROJ-2" };
        writeFileSync(path.join(w.ticketDir("PROJ-2"), "workflow.json"), JSON.stringify(copy));
        const state = path.join(w.ticketDir("PROJ-2"), "workflow.json");
        assert.equal(
            w.core.api.protectedPaths.list().some((entry) => entry.path === state),
            false,
        );
        w.activate("PROJ-2");
        await w.call({ action: "status" });
        assert.ok(w.core.api.protectedPaths.list().some((entry) => entry.path === state && entry.kind === "guarded"));
    });

    test("a ticket's state file is guarded when the session finds its workflow at start", async (t) => {
        const w = await started(t);
        const state = path.join(w.ticketDir(), "workflow.json");
        await restart(w);
        assert.ok(w.core.api.protectedPaths.list().some((entry) => entry.path === state));
    });
});

describe("where workflow files are read from", () => {
    test("the project's .pi/workflows only when Pi trusts the project, and it replaces an earlier file of the same name", async (t) => {
        const make = (w: World) => {
            const folder = path.join(w.workspace, ".pi", "workflows");
            mkdirSync(folder, { recursive: true });
            writeFileSync(
                path.join(folder, "feature.json"),
                JSON.stringify({ name: "feature", description: "the project's", stages: [{ id: "only" }] }),
            );
        };
        const untrusted = await world(t);
        make(untrusted);
        await untrusted.command("reload");
        assert.match((await untrusted.call({ action: "list" })).text, /^feature: A change to a service/);
        const trusted = await world(t, { trusted: true });
        make(trusted);
        await trusted.command("reload");
        const text = (await trusted.call({ action: "list" })).text;
        assert.match(text, /^feature: the project's/);
        assert.match(text, /from the project:/);
    });

    test("the agent folder's workflows replace the configured folder's, as the docs say", async (t) => {
        const w = await world(t);
        const agent = path.join(w.core.agentDir, "workflows");
        mkdirSync(agent, { recursive: true });
        writeFileSync(
            path.join(agent, "feature.json"),
            JSON.stringify({ name: "feature", description: "mine", stages: [{ id: "only" }] }),
        );
        await w.command("reload");
        assert.match(
            (await w.call({ action: "list" })).text,
            /^feature: mine\n {2}stages: only\n {2}from the agent folder:/,
        );
    });
});

describe("a company's files", () => {
    test("a folder and test commands given through section defaults are used, whatever the order the plugins load in", async (t) => {
        let folder = "";
        const w = await world(t, {
            company: (api, workspace) => {
                folder = path.join(workspace, "company-workflows");
                mkdirSync(folder, { recursive: true });
                writeFileSync(
                    path.join(folder, "policy.json"),
                    JSON.stringify({
                        name: "policy",
                        match: { ticket: "^PROJ-" },
                        stages: [{ id: "only", goal: "the company's" }],
                    }),
                );
                // A company plugin may load before or after jig-workflow; the defaults reach it either way.
                api.config.addSectionDefaults("workflow", { folders: [folder], tests: { "orders-api": "make check" } });
            },
        });
        assert.match((await w.call({ action: "list" })).text, /^policy$/m);
        assert.match(
            (await w.call({ action: "list" })).text,
            new RegExp(`from the configured: ${folder.replace(/[.\\/]/g, "\\$&")}/policy.json`),
        );
        // The company's test command is the default for the repository.
        w.activate("PROJ-1");
        w.bind(w.orders);
        await w.call({ action: "start", name: "policy" });
        await w.call({ action: "test" });
        assert.deepEqual(
            w.host.sandboxed.map((run) => run.command),
            ["make check"],
        );
    });
});

describe("a company's folders and yours add up", () => {
    type Company = NonNullable<Parameters<typeof world>[1]>["company"];

    /** A company plugin with a `policy` workflow and a `feature` of its own, in a folder of its package. */
    function company(over: { tests?: Record<string, unknown> } = {}): NonNullable<Company> {
        return (api, workspace) => {
            const folder = path.join(workspace, "company-workflows");
            mkdirSync(folder, { recursive: true });
            for (const [name, description] of [
                ["policy", "the company's"],
                ["feature", "the company's feature"],
            ] as const) {
                writeFileSync(
                    path.join(folder, `${name}.json`),
                    JSON.stringify({ name, description, match: { ticket: "^PROJ-" }, stages: [{ id: "only" }] }),
                );
            }
            api.config.addSectionDefaults("workflow", { folders: [folder], ...over });
        };
    }

    test("a folder of yours does not take the company's away: both are read", async (t) => {
        const w = await world(t, { company: company(), userWorkflow: { folders: ["$workflows"] } });
        const text = (await w.call({ action: "list" })).text;
        assert.match(text, /^policy: the company's$/m, "the company's workflow is still there");
        assert.match(text, /^feature: /m, "and the one from your folder");
    });

    test("when both have a file of one name, yours wins, because your folders are read after the company's", async (t) => {
        const w = await world(t, { company: company(), userWorkflow: { folders: ["$workflows"] } });
        const text = (await w.call({ action: "list" })).text;
        assert.doesNotMatch(text, /the company's feature/);
        assert.match(text, /^feature: A change to a service/m, "the example feature file of your folder");
        assert.match(
            text,
            /^policy: the company's\n.*\n.*\n {2}from the configured: .*company-workflows\/policy\.json$/m,
        );
    });

    test("with no folders of yours, the company's alone, as before", async (t) => {
        const w = await world(t, { company: company(), userWorkflow: {} });
        const text = (await w.call({ action: "list" })).text;
        assert.match(text, /^feature: the company's feature$/m);
        assert.match(text, /^policy: the company's$/m);
    });

    test("workflow.disabled drops a company workflow, and the list says so", async (t) => {
        const w = await world(t, {
            company: company(),
            userWorkflow: { folders: ["$workflows"], disabled: ["policy"] },
        });
        const text = (await w.call({ action: "list" })).text;
        assert.doesNotMatch(text, /^policy/m);
        assert.match(
            text,
            /Left out by workflow\.disabled in jig\.json:\n {2}policy: .*company-workflows\/policy\.json/,
        );
        w.activate("PROJ-1");
        const started = await w.call({ action: "start", name: "policy" });
        assert.equal(started.isError, true, "it cannot be started either");
    });

    test("a ticket that already runs a workflow that is turned off is told so, and its holds are not enforced", async (t) => {
        // The same ticket, first on a world where the company's `policy` is on, then on one where it is turned off.
        const on = await world(t, { company: company(), userWorkflow: { folders: ["$workflows"] } });
        on.activate("PROJ-1");
        on.bind(on.orders);
        assert.equal((await on.call({ action: "start", name: "policy" })).isError, false);
        const off = await world(t, {
            company: company(),
            userWorkflow: { folders: ["$workflows"], disabled: ["policy"] },
        });
        off.activate("PROJ-1");
        off.bind(off.orders);
        copyFileSync(path.join(on.ticketDir(), "workflow.json"), path.join(off.ticketDir(), "workflow.json"));
        assert.match(
            (await off.call({ action: "status" })).text,
            /the workflow policy is at stage only, and workflow\.disabled in jig\.json turns it off\. Its holds are not enforced while it is off\./,
        );
        assert.match(
            (await off.call({ action: "test" })).text,
            /the workflow policy of PROJ-1 is turned off by workflow\.disabled in jig\.json/,
        );
    });

    test("the company's test commands and yours merge by repository, as before", async (t) => {
        const w = await world(t, {
            company: company({ tests: { "orders-api": "make check", unbound: "make other" } }),
            userWorkflow: { folders: ["$workflows"], tests: { "orders-api": "make mine" } },
        });
        w.activate("PROJ-1");
        w.bind(w.orders);
        await w.call({ action: "start", name: "policy" });
        await w.call({ action: "test" });
        assert.deepEqual(
            w.host.sandboxed.map((run) => run.command),
            ["make mine"],
        );
    });
});

describe("a session that ends", () => {
    test("stops listening to the bus", async (t) => {
        const w = await world(t);
        await w.pi.fire("session_shutdown", {}, w.ctx);
        assert.equal(w.pi.unsubscribedCount, 2);
    });
});

test("the state of a ticket survives the plugin: a second plugin instance over the same files sees the same work", async (t) => {
    const w = await started(t);
    w.writeNotes("# notes\nmore\n");
    const raw = readFileSync(path.join(w.ticketDir(), "workflow.json"), "utf8");
    assert.equal(JSON.parse(raw).stage, "understand");
    await restart(w);
    assert.match((await w.call({ action: "status" })).text, /stage 1 of 7: understand/);
});
