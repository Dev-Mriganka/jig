// "Changed since the preview": what is sent is what was approved. The plan is made again when the write runs, and if its
// fingerprint differs from the approved preview's, nothing is sent.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FakeIssue } from "./support/fake-jira.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness("cloud");
});
after(() => h.close());
beforeEach(() => h.reset());

const issue = (key: string): FakeIssue => h.jira.issues.get(key) as FakeIssue;
const writes = () => h.jira.requests.filter((request) => request.method !== "GET");
const CHANGED = "changed since the preview; run it again to see the new preview. Nothing was sent.";

describe("a write whose plan differs from the approved preview is refused", () => {
    test("transition: the issue moved while the person read", async () => {
        const result = await h.call(
            { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
            { between: () => void (issue("PROJ-1").fields.status = { name: "Open" }) },
        );
        assert.equal(result.error?.message, `jira transition on PROJ-1: ${CHANGED}`);
        assert.equal(writes().length, 0);
        assert.deepEqual(issue("PROJ-1").fields.status, { name: "Open" });
        assert.equal(h.jig.facts.size, 0, "nothing was written, so nothing is recorded");
    });

    test("transition: the same name now leads somewhere else", async () => {
        const result = await h.call(
            { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
            {
                between: () =>
                    void (issue("PROJ-1").transitions[1] = { id: "32", name: "Resolve Issue", to: "Closed" }),
            },
        );
        assert.match(result.error?.message ?? "", /changed since the preview/);
        assert.equal(writes().length, 0);
    });

    test("comment: it would now be posted by someone else", async () => {
        const result = await h.call(
            { action: "comment", key: "PROJ-1", text: "hi" },
            { between: () => void (h.jira.me = h.jira.users[1] as typeof h.jira.me) },
        );
        assert.equal(result.error?.message, `jira comment on PROJ-1: ${CHANGED}`);
        assert.equal(writes().length, 0);
    });

    test("edit_comment and delete_comment: the comment was edited by someone else", async () => {
        const edit = () =>
            void (issue("PROJ-1").comments.find((comment) => comment.id === "10003")!.body = "Edited meanwhile.");
        const edited = await h.call(
            { action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "mine" },
            { between: edit },
        );
        assert.equal(edited.error?.message, `jira edit_comment on PROJ-1: ${CHANGED}`);
        const deleted = await h.call(
            { action: "delete_comment", key: "PROJ-1", commentId: "10003" },
            {
                between: () =>
                    void (issue("PROJ-1").comments.find((comment) => comment.id === "10003")!.body = "Edited again."),
            },
        );
        assert.equal(deleted.error?.message, `jira delete_comment on PROJ-1: ${CHANGED}`);
        assert.equal(writes().length, 0);
        assert.equal(issue("PROJ-1").comments.length, 3, "the comment is still there");
    });

    test("update: a field it changes was changed by someone else", async () => {
        const result = await h.call(
            { action: "update", key: "PROJ-2", fields: { labels: ["docs"], summary: "New title" } },
            { between: () => void (issue("PROJ-2").fields.labels = ["other"]) },
        );
        assert.equal(result.error?.message, `jira update on PROJ-2: ${CHANGED}`);
        assert.equal(writes().length, 0);
    });

    test("update and create: a person now means someone else", async () => {
        const rename = () => void ((h.jira.users[1] as { accountId: string }).accountId = "712020:ffff-1111");
        const update = await h.call(
            { action: "update", key: "PROJ-2", fields: { assignee: "Sam Lee" } },
            { between: rename },
        );
        assert.equal(update.error?.message, `jira update on PROJ-2: ${CHANGED}`);
        h.reset();
        const create = await h.call(
            { action: "create", project: "PROJ", type: "Bug", summary: "A bug", fields: { assignee: "Sam Lee" } },
            { between: rename },
        );
        assert.equal(create.error?.message, `jira create: ${CHANGED}`);
        assert.equal(writes().length, 0);
    });

    test("it is the plan that counts, not the clock: an issue that merely got a new comment is still the same write", async () => {
        const result = await h.call(
            { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
            {
                between: () =>
                    void issue("PROJ-1").comments.push({
                        id: "99",
                        author: h.jira.users[1]!,
                        body: "new",
                        created: "2026-10-30T10:00:00.000+0000",
                        updated: "2026-10-30T10:00:00.000+0000",
                    }),
            },
        );
        assert.equal(ok(result), 'PROJ-1 moved from In Progress to Done (transition "Resolve Issue").');
    });
});

describe("when nothing was approved there is nothing to compare", () => {
    test("a call that did not ask runs on the state it finds", async () => {
        const result = await h.call(
            { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
            { ask: false, between: () => void (issue("PROJ-1").fields.status = { name: "Open" }) },
        );
        assert.equal(result.preview, undefined);
        assert.equal(ok(result), 'PROJ-1 moved from Open to Done (transition "Resolve Issue").');
    });

    test("a preview that could not be built has no fingerprint, and the person's choice stands", async () => {
        h.jira.misbehave({
            match: (request) => request.path === "/issue/PROJ-1",
            status: 502,
            apply: false,
            afterMs: 0,
        });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        assert.match(result.preview?.summary ?? "", /^preview unavailable/);
        assert.equal(result.preview?.fingerprint, undefined);
        assert.equal(ok(result), "Added comment 10100 to PROJ-1.");
    });
});

describe("the refusal", () => {
    test("says what to do, and names the call without the text", async () => {
        const result = await h.call(
            { action: "comment", key: "PROJ-1", text: "SECRET-TEXT" },
            { between: () => void (h.jira.me = h.jira.users[1] as typeof h.jira.me) },
        );
        assert.match(result.error?.message ?? "", /run it again to see the new preview/);
        assert.doesNotMatch(result.error?.message ?? "", /SECRET-TEXT/);
    });

    test("running the call again shows the new preview, and a call that then matches goes through", async () => {
        const call = { action: "transition", key: "PROJ-1", transition: "Resolve Issue" };
        const refused = await h.call(call, { between: () => void (issue("PROJ-1").fields.status = { name: "Open" }) });
        assert.ok(refused.error);
        const again = await h.call(call);
        assert.equal(
            again.preview?.summary,
            'Move PROJ-1 "Fix login crash on Safari" from Open to Done (transition "Resolve Issue")',
        );
        assert.equal(ok(again), 'PROJ-1 moved from Open to Done (transition "Resolve Issue").');
    });
});
