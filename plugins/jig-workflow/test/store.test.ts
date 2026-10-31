// The state file: what it holds, how it is written, and what happens to one that is damaged or not ours.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { archiveState, newState, readState, statePath, updateState, whatIsLost, writeState } from "../src/store.ts";
import type { WorkflowState } from "../src/store.ts";

const HEAD = "a".repeat(40);
const NOW = new Date("2026-10-31T10:00:00.000Z");

let dir: string;
beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), "jig-workflow-store-")), "PROJ-123");
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

const fresh = (): WorkflowState =>
    newState({ workflow: "feature", ticket: "PROJ-123", stage: "plan", notesHash: "h0", now: NOW });

describe("writing and reading", () => {
    test("a new state is at its first stage, with the notes as they were and one line of history", () => {
        const state = fresh();
        assert.equal(state.stage, "plan");
        assert.equal(state.notesAtStage, "h0");
        assert.deepEqual(state.history, [{ at: NOW.toISOString(), event: "start", to: "plan" }]);
        assert.deepEqual([state.tests, state.scenarios, state.reviews, state.ci, state.observed], [{}, {}, [], [], {}]);
    });

    test("a state written is the state read, in a private file, and no temporary file is left", () => {
        const state = fresh();
        state.plan = { fingerprint: "f", at: NOW.toISOString(), scenarios: 2 };
        state.tests["/work/orders"] = {
            head: HEAD,
            clean: true,
            passed: true,
            command: "npm test",
            exitCode: 0,
            timedOut: false,
            sandboxed: true,
            at: NOW.toISOString(),
            durationMs: 1200,
        };
        state.scenarios["1"] = {
            result: "pass",
            hash: "s1",
            evidence: { kind: "path", ref: "evidence/a.png" },
            at: NOW.toISOString(),
        };
        state.reviews.push({ reviewId: "r1", at: NOW.toISOString(), repos: [{ root: "/work/orders", head: HEAD }] });
        state.ci.push({
            repo: "acme/orders-api",
            sha: HEAD,
            outcome: "passed",
            finish: "required",
            at: NOW.toISOString(),
        });
        state.observed["/work/orders"] = {
            at: NOW.toISOString(),
            branch: "feature/PROJ-123",
            head: HEAD,
            pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: HEAD, url: "https://example.com/pr/7" },
            checks: { pass: 3, fail: 0, pending: 0, total: 3 },
        };
        writeState(dir, state);
        const read = readState(dir);
        assert.equal(read.kind, "state");
        assert.deepEqual(read.kind === "state" ? read.state : undefined, state);
        assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600);
        assert.deepEqual(readdirSync(dir), ["workflow.json"]);
    });

    test("no file is no state", () => {
        assert.deepEqual(readState(dir), { kind: "none" });
        mkdirSync(dir, { recursive: true });
        assert.deepEqual(readState(dir), { kind: "none" });
    });

    test("updateState changes what is on disk, and does nothing when there is no state", () => {
        assert.equal(
            updateState(dir, () => 1),
            undefined,
        );
        writeState(dir, fresh());
        const got = updateState(dir, (state) => {
            state.stage = "build";
            return state.workflow;
        });
        assert.equal(got, "feature");
        const read = readState(dir);
        assert.equal(read.kind === "state" ? read.state.stage : "", "build");
    });
});

describe("a file that is damaged or not ours", () => {
    function put(content: string): void {
        mkdirSync(dir, { recursive: true });
        writeFileSync(statePath(dir), content);
    }

    test("not JSON, not an object, another version, a field missing", () => {
        put("{ nope");
        assert.match((readState(dir) as { problem: string }).problem, /cannot be read/);
        put("[]");
        assert.match((readState(dir) as { problem: string }).problem, /not an object/);
        put(JSON.stringify({ ...fresh(), version: 2 }));
        assert.match((readState(dir) as { problem: string }).problem, /version 2 is not one this plugin reads/);
        const { stage: _stage, ...without } = fresh();
        put(JSON.stringify(without));
        assert.match((readState(dir) as { problem: string }).problem, /stage is missing/);
        assert.match(
            (readState(dir) as { problem: string }).problem,
            new RegExp(statePath(dir).replace(/[.\\]/g, "\\$&")),
        );
    });

    test("a malformed entry of a collection is dropped and the rest is kept", () => {
        const state = fresh();
        put(
            JSON.stringify({
                ...state,
                tests: {
                    "/a": { head: "not-a-commit", clean: true, passed: true, command: "x", at: "t" },
                    "/b": { head: HEAD, clean: true, passed: true, command: "x", at: "t" },
                },
                reviews: [
                    {
                        reviewId: "r",
                        at: "t",
                        repos: [
                            { root: "/a", head: "short" },
                            { root: "/b", head: HEAD },
                        ],
                    },
                    "junk",
                ],
                ci: [{ repo: "a/b", sha: "short", outcome: "passed", finish: "x", at: "t" }],
                scenarios: { "1": { result: "maybe", hash: "h", at: "t" } },
                history: [{ at: "t", event: "start", to: "plan" }, { event: "weird" }],
            }),
        );
        const read = readState(dir);
        const loaded = read.kind === "state" ? read.state : undefined;
        assert.deepEqual(Object.keys(loaded?.tests ?? {}), ["/b"]);
        assert.deepEqual(loaded?.reviews[0]?.repos, [{ root: "/b", head: HEAD }]);
        assert.equal(loaded?.reviews.length, 1);
        assert.deepEqual(loaded?.ci, []);
        assert.deepEqual(loaded?.scenarios, {});
        assert.equal(loaded?.history.length, 1);
    });
});

describe("keeping it small", () => {
    test("old history, reviews and CI results fall off the front", () => {
        const state = fresh();
        for (let n = 0; n < 250; n++) state.history.push({ at: String(n), event: "advance", to: "x" });
        for (let n = 0; n < 30; n++) {
            state.reviews.push({ reviewId: `r${n}`, at: "t", repos: [] });
            state.ci.push({ repo: "a/b", sha: HEAD, outcome: "passed", finish: "x", at: String(n) });
        }
        writeState(dir, state);
        const read = readState(dir);
        const loaded = read.kind === "state" ? read.state : undefined;
        assert.equal(loaded?.history.length, 200);
        assert.equal(loaded?.reviews.length, 20);
        assert.equal(loaded?.reviews.at(-1)?.reviewId, "r29");
        assert.equal(loaded?.ci.length, 20);
    });
});

describe("switching", () => {
    test("the old state is kept in the history folder, under the time and the workflow's name", () => {
        const state = fresh();
        writeState(dir, state);
        const file = archiveState(dir, state, NOW);
        assert.equal(path.basename(file), "2026-10-31T10-00-00.000Z-feature.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
        assert.ok(existsSync(statePath(dir)), "the archive copies; the caller writes the new state");
        assert.throws(() => archiveState(dir, state, NOW), /EEXIST/, "an archive is never overwritten");
    });

    test("what a switch loses, with counts, and nothing for what was never recorded", () => {
        const state = fresh();
        assert.deepEqual(whatIsLost(state), ["the stage (plan)"]);
        state.plan = { fingerprint: "f", at: "t", scenarios: 1 };
        state.tests["/a"] = {
            head: HEAD,
            clean: true,
            passed: true,
            command: "x",
            exitCode: 0,
            timedOut: false,
            sandboxed: true,
            at: "t",
            durationMs: 1,
        };
        state.scenarios["1"] = { result: "pass", hash: "h", at: "t" };
        state.scenarios["2"] = { result: "fail", hash: "h", at: "t" };
        state.reviews.push({ reviewId: "r", at: "t", repos: [] });
        assert.deepEqual(whatIsLost(state), [
            "the stage (plan)",
            "the plan approval",
            "1 test result",
            "2 scenario results",
            "1 review record",
        ]);
    });
});
