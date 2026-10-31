// A worker writes only in a git worktree of its own: made through jig-core's git, on a branch named by configuration, never in the
// parent's folder, and reported by branch name so the parent can review and merge it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { git, startWorld, until } from "./world.ts";
import type { World, WorldOptions } from "./world.ts";

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

async function begin(options: WorldOptions = {}): Promise<World> {
    w = await startWorld({
        script: { steps: [{ settle: { text: "Changed src/total.ts; tests pass." } }] },
        ...options,
    });
    return w;
}

describe("a worker", () => {
    test("works in a new worktree beside the repository, on its own branch, and the report names the branch", {
        timeout: 30_000,
    }, async () => {
        const world = await begin();
        const started = await world.tool({ action: "start", role: "worker", task: "round totals to cents" });
        assert.equal(started.isError, false, started.text);
        const tree = path.join(path.dirname(world.cwd), "orders-api-worker-1");
        assert.equal(started.details.cwd, realpathSync(tree));
        assert.equal(started.details.branch, "agent/worker-1");
        assert.match(
            started.text,
            new RegExp(
                `works in ${realpathSync(tree).replace(/[.+*?^$()[\]{}|\\]/g, "\\$&")}, on the branch agent/worker-1`,
            ),
        );

        // The child runs there, not in the parent's folder, and the tree is a real worktree on the new branch.
        await until(() => world.log().start !== undefined, "the child");
        assert.equal(world.log().start?.cwd, realpathSync(tree));
        assert.notEqual(world.log().start?.cwd, world.cwd);
        assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), "agent/worker-1");
        assert.equal(git(tree, "rev-parse", "HEAD"), git(world.cwd, "rev-parse", "HEAD"), "cut from the parent's HEAD");
        assert.match(git(world.cwd, "worktree", "list"), /orders-api-worker-1/);

        // A worker has the tools to write, and no more tools than its file lists.
        const argv = world.log().start?.argv ?? [];
        assert.equal(argv[argv.indexOf("--tools") + 1], "read,write,edit,bash,git,grep,find,ls");
        // Its task tells it where it is.
        const prompt = world.log().commands.find((c) => c.type === "prompt");
        assert.match(prompt?.message, /git worktree on the branch agent\/worker-1, cut from the parent's HEAD/);
        assert.match(prompt?.message, /Changes the parent has not committed are not here/);

        const message = await world.deliver();
        assert.match(message.content, /Branch: agent\/worker-1 \(worktree .*orders-api-worker-1\)/);
        assert.match(message.content, /Changed src\/total\.ts; tests pass\./);
        const report = readReport(world, started.details.child);
        assert.match(report, /Branch: agent\/worker-1\. Worktree: .*orders-api-worker-1\./);
    });

    test("the branch name comes from configuration, and a branch that exists gets the child's id added", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { branch: "work/{name}" } },
            prepare: ({ cwd }) => {
                git(cwd, "branch", "work/worker-1");
            },
        });
        const started = await world.tool({ action: "start", role: "worker", task: "x" });
        assert.equal(started.isError, false, started.text);
        assert.equal(started.details.branch, `work/worker-1-${started.details.child}`);
        const tree = String(started.details.cwd);
        assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), started.details.branch);
    });

    test("two workers get two worktrees and two branches, and neither is the parent's folder", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        const one = await world.tool({ action: "start", role: "worker", task: "a" });
        const two = await world.tool({ action: "start", role: "worker", task: "b", name: "second" });
        assert.notEqual(one.details.cwd, two.details.cwd);
        assert.equal(two.details.branch, "agent/second");
        for (const cwd of [one.details.cwd, two.details.cwd]) assert.notEqual(cwd, world.cwd);
    });

    test("a worker needs a git repository, and the cwd is the one that holds it", { timeout: 30_000 }, async () => {
        const world = await begin({ repo: false });
        const refused = await world.tool({ action: "start", role: "worker", task: "x" });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /a worker needs a git repository/);
        assert.equal(world.rt.children.size, 0);
    });

    test("a repository with no commit cannot give a worktree", { timeout: 30_000 }, async () => {
        const world = await begin({
            repo: false,
            prepare: ({ cwd }) => {
                git(cwd, "init", "-q", "-b", "main");
            },
        });
        const refused = await world.tool({ action: "start", role: "worker", task: "x" });
        assert.match(refused.text, /has no commit yet/);
    });

    test("a start that fails after the worktree was made takes it away again, with its branch", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { rejectPrompt: true } });
        const refused = await world.tool({ action: "start", role: "worker", task: "x" });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /did not accept its task/);
        const tree = path.join(path.dirname(world.cwd), "orders-api-worker-1");
        assert.equal(existsSync(tree), false, "the worktree is gone");
        assert.equal(git(world.cwd, "branch", "--list", "agent/worker-1"), "", "and so is its branch");
        assert.equal(world.rt.children.size, 0);
    });

    test("a read-only role stays in the folder it is given, with no worktree and no branch", {
        timeout: 30_000,
    }, async () => {
        const world = await begin();
        mkdirSync(path.join(world.cwd, "src"), { recursive: true });
        const started = await world.tool({ action: "start", role: "reviewer", task: "look", cwd: "src" });
        assert.equal(started.isError, false, started.text);
        assert.equal(started.details.branch, undefined);
        assert.equal(started.details.cwd, path.join(world.cwd, "src"));
        assert.equal(git(world.cwd, "worktree", "list").split("\n").length, 1);
    });

    test("git is run through jig-core: its hooks are off, so a hook in the repository does not run", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            prepare: ({ cwd }) => {
                const hook = path.join(cwd, ".git", "hooks", "post-checkout");
                writeFileSync(hook, `#!/bin/sh\ntouch "${cwd}/../hook-ran"\n`, { mode: 0o755 });
            },
        });
        const started = await world.tool({ action: "start", role: "worker", task: "x" });
        assert.equal(started.isError, false, started.text);
        assert.equal(existsSync(path.join(path.dirname(world.cwd), "hook-ran")), false);
    });
});

function readReport(world: World, id: string): string {
    const child = world.rt.children.get(id);
    return readFileSync(child?.reportFile as string, "utf8");
}
