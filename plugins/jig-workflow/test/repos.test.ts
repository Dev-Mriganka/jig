// A repository as the conditions see it, and which bound repository a tool call acts in.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { containingRepo, inspect, parseRemote, scopeOf, short, workspaceOf } from "../src/repos.ts";
import { commit, fakeHost, git, headOf, makeRepo, tempFolder } from "./support.ts";

describe("the name origin gives a repository", () => {
    test("in the forms git accepts", () => {
        for (const url of [
            "git@github.example.com:Acme/Orders-API.git",
            "https://github.example.com/Acme/Orders-API.git",
            "https://github.example.com/Acme/Orders-API/",
            "ssh://git@github.example.com:2222/Acme/Orders-API",
        ]) {
            assert.deepEqual(parseRemote(url), { slug: "acme/orders-api", name: "Orders-API" }, url);
        }
        assert.equal(parseRemote(""), undefined);
        assert.equal(parseRemote("name"), undefined);
    });
});

describe("inspecting a repository", () => {
    test("HEAD, the branch, a clean tree and the name origin gives", async (t) => {
        const root = makeRepo(tempFolder(t), "orders-api-PROJ-1", "git@github.example.com:acme/orders-api.git");
        const view = await inspect(fakeHost(), root);
        assert.equal(view.root, root);
        assert.equal(view.name, "orders-api-PROJ-1");
        assert.equal(view.head, headOf(root));
        assert.equal(view.branch, "main");
        assert.equal(view.clean, true);
        assert.equal(view.slug, "acme/orders-api");
        assert.equal(view.remoteName, "orders-api");
        assert.equal(view.problem, undefined);
    });

    test("a tracked change, and an untracked file, both make the tree not clean", async (t) => {
        const root = makeRepo(tempFolder(t), "r");
        writeFileSync(path.join(root, "README.md"), "changed\n");
        assert.equal((await inspect(fakeHost(), root)).clean, false);
        git(root, "checkout", "--", "README.md");
        assert.equal((await inspect(fakeHost(), root)).clean, true);
        writeFileSync(path.join(root, "new.txt"), "x");
        assert.equal((await inspect(fakeHost(), root)).clean, false);
    });

    test("a detached HEAD has no branch; a repository without an origin has no name from it", async (t) => {
        const root = makeRepo(tempFolder(t), "r");
        git(root, "checkout", "-q", "--detach");
        const view = await inspect(fakeHost(), root);
        assert.equal(view.branch, undefined);
        assert.equal(view.slug, undefined);
        assert.ok(view.head);
    });

    test("a repository with no commit has no HEAD, and says so", async (t) => {
        const dir = path.join(tempFolder(t), "empty");
        mkdirSync(dir);
        git(dir, "init", "-q", "-b", "main");
        const view = await inspect(fakeHost(), dir);
        assert.equal(view.head, undefined);
        assert.equal(view.problem, "there is no commit yet");
    });

    test("a folder that is not a repository gives a reason, not an exception", async (t) => {
        const view = await inspect(fakeHost(), tempFolder(t));
        assert.equal(view.head, undefined);
        assert.match(view.problem ?? "", /not a git repository/);
    });

    test("a commit is shown short", () => {
        assert.equal(short("1234567890abcdef"), "1234567");
        assert.equal(short(undefined), "no commit");
    });
});

describe("finding the repository around a folder", () => {
    test("the nearest folder above with a .git, as a real path, and the workspace beside it", (t) => {
        const parent = tempFolder(t);
        const root = makeRepo(parent, "orders-api");
        mkdirSync(path.join(root, "src", "deep"), { recursive: true });
        assert.equal(containingRepo(path.join(root, "src", "deep")), root);
        assert.equal(workspaceOf(path.join(root, "src")), parent);
        assert.equal(workspaceOf(parent), parent, "a folder that is not in a repository is the workspace itself");
        assert.equal(containingRepo(parent), undefined);
    });

    test("a worktree has a .git file and counts", (t) => {
        const parent = tempFolder(t);
        const root = makeRepo(parent, "orders-api");
        git(root, "worktree", "add", "-q", "-b", "feature/PROJ-1", path.join(parent, "orders-api-PROJ-1"));
        assert.equal(containingRepo(path.join(parent, "orders-api-PROJ-1")), path.join(parent, "orders-api-PROJ-1"));
    });
});

describe("where a call acts", () => {
    function world(t: Parameters<typeof tempFolder>[0]) {
        const workspace = tempFolder(t);
        const orders = makeRepo(workspace, "orders-api-PROJ-1");
        const billing = makeRepo(workspace, "billing-api");
        const other = makeRepo(workspace, "unbound");
        return { workspace, orders, billing, other, bound: [orders, billing] };
    }
    const call = (tool: string, input: Record<string, unknown>, cwd: string, paths: string[] = []) => ({
        tool,
        input,
        cwd,
        paths,
    });

    test("write and edit act where their paths are: in a bound repository, or elsewhere", (t) => {
        const { workspace, orders, other, bound } = world(t);
        assert.deepEqual(scopeOf(call("write", {}, workspace, [path.join(orders, "src", "A.java")]), bound), {
            kind: "repository",
            root: orders,
        });
        assert.deepEqual(scopeOf(call("edit", {}, workspace, [path.join(other, "A.java")]), bound), {
            kind: "elsewhere",
        });
        assert.deepEqual(scopeOf(call("write", {}, workspace, [path.join(workspace, "notes.md")]), bound), {
            kind: "elsewhere",
        });
        assert.deepEqual(scopeOf(call("write", {}, workspace, []), bound), { kind: "elsewhere" });
    });

    test("a path that only starts like a repository's is not inside it", (t) => {
        const { workspace, orders, bound } = world(t);
        assert.deepEqual(scopeOf(call("write", {}, workspace, [`${orders}-copy/A.java`]), bound), {
            kind: "elsewhere",
        });
    });

    test("a link into a bound repository is followed by jig-core's paths, and both forms are tried", (t) => {
        const { workspace, orders, bound } = world(t);
        symlinkSync(orders, path.join(workspace, "shortcut"));
        assert.deepEqual(
            scopeOf(
                call("write", {}, workspace, [path.join(workspace, "shortcut", "A.java"), path.join(orders, "A.java")]),
                bound,
            ),
            { kind: "repository", root: orders },
        );
    });

    test("git and pr act in the repository they name: a folder in the workspace, or an absolute path", (t) => {
        const { workspace, orders, other, bound } = world(t);
        mkdirSync(path.join(orders, "src"));
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: "orders-api-PROJ-1" }, workspace), bound), {
            kind: "repository",
            root: orders,
        });
        assert.deepEqual(scopeOf(call("pr", { action: "create", repo: orders }, workspace), bound), {
            kind: "repository",
            root: orders,
        });
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: path.join(orders, "src") }, workspace), bound), {
            kind: "repository",
            root: orders,
        });
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: "unbound" }, workspace), bound), {
            kind: "elsewhere",
        });
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: other }, workspace), bound), {
            kind: "elsewhere",
        });
    });

    test("with no repo named, the repository Pi runs in; the workspace names a folder relative to the repository's parent", (t) => {
        const { workspace, orders, billing, bound } = world(t);
        mkdirSync(path.join(orders, "src"), { recursive: true });
        assert.deepEqual(scopeOf(call("git", { action: "commit" }, path.join(orders, "src")), bound), {
            kind: "repository",
            root: orders,
        });
        assert.deepEqual(scopeOf(call("git", { action: "commit" }, workspace), bound), { kind: "elsewhere" });
        // Pi runs inside orders-api-PROJ-1, so the workspace is its parent and "billing-api" names the sibling.
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: "billing-api" }, orders), bound), {
            kind: "repository",
            root: billing,
        });
    });

    test("a repo that cannot be worked out is elsewhere, and the tool fails on it by itself", (t) => {
        const { workspace, bound } = world(t);
        for (const repo of ["missing", "../x", "a\0b", 3, ""]) {
            const scope = scopeOf(call("git", { action: "push", repo }, workspace), bound);
            assert.equal(scope.kind, "elsewhere", String(repo));
        }
    });

    test("any other tool names no repository: the work as a whole", (t) => {
        const { workspace, bound } = world(t);
        assert.deepEqual(scopeOf(call("deploy", { action: "run" }, workspace), bound), { kind: "work" });
        assert.deepEqual(scopeOf(call("bash", { command: "ls" }, workspace), bound), { kind: "work" });
    });

    test("a commit moves a bound repository's HEAD without moving its root", (t) => {
        const { workspace, orders, bound } = world(t);
        commit(orders);
        assert.deepEqual(scopeOf(call("git", { action: "push", repo: "orders-api-PROJ-1" }, workspace), bound), {
            kind: "repository",
            root: orders,
        });
    });
});
