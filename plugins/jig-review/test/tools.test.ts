// The factory, the two tools and their declarations: what Pi loads, what jig-core is told, what the agent is given.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import plugin, { DECLARATIONS } from "../src/index.ts";
import { OPENED_TEXT, RESOLUTION_TOOL, START_TOOL } from "../src/tools.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";
import { fakeHost, openReview } from "./support/harness.ts";
import type { ReviewSession } from "./support/harness.ts";

let jig: FakeJig;
let agentDir = "";
const saved = process.env.PI_CODING_AGENT_DIR;
let session: ReviewSession | undefined;

beforeEach(() => {
    agentDir = mkdtempSync(path.join(os.tmpdir(), "jig-review-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(async () => {
    jig?.remove();
    await session?.close();
    session = undefined;
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(agentDir, { recursive: true, force: true });
});

test("the factory registers the command and both tools, declares them to jig-core as local writes, and writes nothing", () => {
    jig = installFakeJig();
    const host = fakeHost();
    const commands: string[] = [];
    (host.pi as unknown as { registerCommand: (name: string) => void }).registerCommand = (name) => void commands.push(name);
    plugin(host.pi);

    assert.deepEqual(host.toolNames().sort(), [RESOLUTION_TOOL, START_TOOL].sort());
    assert.deepEqual(commands, ["code-review"]);
    assert.deepEqual(readdirSync(agentDir), [], "no folder, settings or key is created by loading");
    assert.deepEqual([...jig.declared.keys()].sort(), ["record_interactive_review_resolution", "start_interactive_code_review"]);
    for (const declaration of DECLARATIONS) {
        assert.equal(declaration.plugin, "jig-review");
        assert.deepEqual(declaration.classify({}), { environment: "local", effect: "write" }, `${declaration.tool} only writes this plugin's own files`);
    }
});

test("the tool names are the ones the agent was taught", () => {
    assert.equal(START_TOOL, "start_interactive_code_review");
    assert.equal(RESOLUTION_TOOL, "record_interactive_review_resolution");
});

test("the start tool's result never holds the link, whatever the outcome", async () => {
    session = await openReview("", { byAgent: true });
    const result = await session.host.tool("start_interactive_code_review", {}, session.session.ctx);
    const text = result.content[0]!.text;
    assert.equal(text, OPENED_TEXT);
    const secret = new URL(session.link).searchParams.get("k")!;
    for (const forbidden of [secret, session.link, session.base, new URL(session.base).port, "localhost", "127.0.0.1", "k="]) {
        assert.ok(!JSON.stringify(result).includes(forbidden), `the result must not contain ${forbidden}`);
    }
    // The user, by contrast, got the link.
    assert.ok(session.session.notices.some((notice) => notice.includes(secret)));
});

test("the resolution tool records how the agent handled a comment, and the page sees it", async () => {
    session = await openReview("--branch");
    assert.equal((await session.post("/api/ask", { comments: [{ body: "Why this?", filePath: "orders-api/Service.java", line: 2, side: "new" }] })).status, 200);
    const [comment] = (session.records()[0] as { comments: Array<{ id: string }> }).comments;
    const result = await session.host.tool(
        "record_interactive_review_resolution",
        { commentIds: [comment!.id], kind: "answered", summary: "Because the old name clashed.", addressedLocations: [{ filePath: "orders-api/Service.java", line: 2, side: "new" }] },
        session.session.ctx,
    );
    assert.equal(result.content[0]!.text, "Recorded interactive review resolution.");
    const [record] = session.records() as Array<{ comments: Array<{ status: string; resolutionId: string }>; resolutions: Array<{ id: string; kind: string; summary: string }> }>;
    assert.equal(record!.comments[0]!.status, "answered");
    assert.equal(record!.comments[0]!.resolutionId, record!.resolutions[0]!.id);
    assert.equal(record!.resolutions[0]!.kind, "answered");
});

test("the resolution tool without an open review says so and records nothing", async () => {
    jig = installFakeJig();
    const host = fakeHost();
    plugin(host.pi);
    const result = await host.tool("record_interactive_review_resolution", { commentIds: ["x"], kind: "fixed", summary: "s" }, {});
    assert.equal(result.content[0]!.text, "No active interactive review is open.");
    assert.ok(!existsSync(path.join(agentDir, "jig-review", "workspaces")));
});

test("what a comment sends the agent is the comment, with its location and the commits the review was made against", async () => {
    session = await openReview("--branch");
    await session.post("/api/comments", { comments: [{ body: "Rename this.", filePath: "orders-api/Service.java", line: 2, side: "new" }, { body: "General note" }] });
    const [message] = session.host.sent;
    assert.match(message!, /Interactive code review \S+ was submitted against these commits: orders-api@[0-9a-f]{12}, worktrees\/PROJ-1\/orders-engine@[0-9a-f]{12}\./);
    assert.match(message!, /location: orders-api\/Service\.java:2 new\n {2}comment: Rename this\./);
    assert.match(message!, /location: General\n {2}comment: General note/);
    assert.match(message!, /call the record_interactive_review_resolution tool/);
    assert.equal(session.host.sent.length, 1, "both comments went in one message");
});
