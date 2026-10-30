// Which repositories a tool call used: the test that decides whose git changes a run is credited with.
import assert from "node:assert/strict";
import { test } from "node:test";

import { repositoriesUsedBy } from "../src/used-repos.ts";

const cwd = "/ws";
const repos = [
    { root: "/ws/api", prefix: "api" },
    { root: "/ws/api-v2", prefix: "api-v2" },
    { root: "/ws/worktrees/PROJ-1/engine", prefix: "worktrees/PROJ-1/engine" },
];
const used = (toolName: string, input: unknown, from: typeof repos = repos, folder = cwd) =>
    repositoriesUsedBy(toolName, input, from, folder).sort();

test("edit and write use the repository that holds their path, absolute or relative to Pi's folder", () => {
    assert.deepEqual(used("edit", { path: "/ws/api/src/A.java" }), ["/ws/api"]);
    assert.deepEqual(used("write", { path: "api-v2/B.java" }), ["/ws/api-v2"]);
    assert.deepEqual(used("edit", { path: "/elsewhere/C.java" }), []);
    assert.deepEqual(used("edit", {}), []);
});

test("the git tool's repo is a name under Pi's folder or an absolute path; without one it names none", () => {
    assert.deepEqual(used("git", { action: "log", repo: "api" }), ["/ws/api"]);
    assert.deepEqual(used("git", { action: "log", repo: "/ws/worktrees/PROJ-1/engine" }), [
        "/ws/worktrees/PROJ-1/engine",
    ]);
    assert.deepEqual(used("git", { action: "status" }), []);
    assert.deepEqual(used("git", { action: "log", repo: "nowhere" }), []);
});

test("bash uses a repository its command names by absolute path, not one whose name only starts the same", () => {
    assert.deepEqual(used("bash", { command: "grep -r foo /ws/api/src" }), ["/ws/api"]);
    assert.deepEqual(used("bash", { command: "ls /ws/api-v2" }), ["/ws/api-v2"]);
    assert.deepEqual(used("bash", { command: "ls /ws/api-v3 /other/ws/api" }), []);
    assert.deepEqual(used("bash", { command: "git -C /ws/worktrees/PROJ-1/engine status" }), [
        "/ws/worktrees/PROJ-1/engine",
    ]);
});

test("bash uses the repository a cd or git -C goes to, relative to Pi's folder; a quoted directory too", () => {
    assert.deepEqual(used("bash", { command: "cd api && ./gradlew build" }), ["/ws/api"]);
    assert.deepEqual(used("bash", { command: "echo hi; cd 'worktrees/PROJ-1/engine/src' && ls" }), [
        "/ws/worktrees/PROJ-1/engine",
    ]);
    assert.deepEqual(used("bash", { command: "git -C api-v2 log" }), ["/ws/api-v2"]);
    assert.deepEqual(used("bash", { command: "cd /tmp && ls" }), []);
    assert.deepEqual(used("bash", { command: "echo cd api" }), []);
});

test("bash without a cd uses the repository Pi's folder is in, and with a cd elsewhere it does not", () => {
    assert.deepEqual(used("bash", { command: "./gradlew build" }, repos, "/ws/api/sub"), ["/ws/api"]);
    assert.deepEqual(used("bash", { command: "cd /tmp && ./gradlew build" }, repos, "/ws/api"), []);
    assert.deepEqual(
        used("bash", { command: "./gradlew build" }),
        [],
        "Pi's folder is the workspace, not a repository",
    );
});

test("other tools use none", () => {
    assert.deepEqual(used("read", { path: "/ws/api/A.java" }), []);
    assert.deepEqual(used("grep", { pattern: "x", path: "/ws/api" }), []);
});
