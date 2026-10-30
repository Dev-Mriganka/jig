// No resend on timeout. A write whose result is unknown (the reply is late, the connection drops, Jira answers 5xx) is sent once
// and never again. The issue is read once afterwards, and the tool says whether the write happened. The fake Jira holds the
// reply past the client's timeout, and does or does not carry the write out first.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FakeIssue, Misbehaviour, Recorded } from "./support/fake-jira.ts";
import { ok, setupHarness, SHORT_TIMEOUTS } from "./support/harness.ts";
import type { CallResult, Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness("cloud", SHORT_TIMEOUTS);
});
after(() => h.close());
beforeEach(() => h.reset());

const issue = (key: string): FakeIssue => h.jira.issues.get(key) as FakeIssue;
const isWrite = (request: Recorded): boolean => request.method !== "GET";

/** The write requests, and what was asked after the first of them. */
function afterTheWrite(): { writes: Recorded[]; reads: Recorded[] } {
    const index = h.jira.requests.findIndex(isWrite);
    return { writes: h.jira.requests.filter(isWrite), reads: index < 0 ? [] : h.jira.requests.slice(index + 1) };
}

/** Makes the reply to the write that `match` accepts late: the client gives up after its timeout, long before this. */
const late = (match: (request: Recorded) => boolean, applied: boolean, extra: Partial<Misbehaviour> = {}): void =>
    h.jira.misbehave({ match, apply: applied, afterMs: 5 * SHORT_TIMEOUTS.normal, ...extra });

interface Case {
    name: string;
    call: Record<string, unknown>;
    write: (request: Recorded) => boolean;
    /** What the one read afterwards is. */
    read: string;
    happened: RegExp;
    didNot: RegExp;
    key: string;
    setUp?: () => void;
    done: () => boolean;
}

const CASES: Case[] = [
    {
        name: "comment", call: { action: "comment", key: "PROJ-1", text: "Checked on Safari 17." },
        write: (request) => request.method === "POST" && request.path === "/issue/PROJ-1/comment", read: "GET /issue/PROJ-1/comment",
        happened: /A read afterwards shows that it happened: comment 10100 by you with this text is on PROJ-1 \(created 2026-10-30 10:00\)\.$/,
        didNot: /A read afterwards shows that it did not happen: the newest 50 comments on PROJ-1 hold none by you with this text\. Run it again if it is still wanted\.$/,
        key: "PROJ-1", done: () => issue("PROJ-1").comments.some((comment) => comment.body === "Checked on Safari 17."),
    },
    {
        name: "edit_comment", call: { action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "Verified twice." },
        write: (request) => request.method === "PUT" && request.path === "/issue/PROJ-1/comment/10003", read: "GET /issue/PROJ-1/comment/10003",
        happened: /A read afterwards shows that it happened: comment 10003 now holds the new text\.$/,
        didNot: /A read afterwards shows that it did not happen: comment 10003 still holds the old text\./,
        key: "PROJ-1", done: () => issue("PROJ-1").comments.find((comment) => comment.id === "10003")?.body === "Verified twice.",
    },
    {
        name: "delete_comment", call: { action: "delete_comment", key: "PROJ-1", commentId: "10002" },
        write: (request) => request.method === "DELETE", read: "GET /issue/PROJ-1/comment/10002",
        happened: /A read afterwards shows that it happened: comment 10002 is no longer on PROJ-1\.$/,
        didNot: /A read afterwards shows that it did not happen: comment 10002 is still on PROJ-1\./,
        key: "PROJ-1", done: () => !issue("PROJ-1").comments.some((comment) => comment.id === "10002"),
    },
    {
        name: "transition", call: { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
        write: (request) => request.method === "POST" && request.path === "/issue/PROJ-1/transitions", read: "GET /issue/PROJ-1",
        happened: /A read afterwards shows that it happened: PROJ-1 is now in Done\.$/,
        didNot: /A read afterwards shows that it did not happen: PROJ-1 is still in In Progress\./,
        key: "PROJ-1", done: () => (issue("PROJ-1").fields.status as { name: string }).name === "Done",
    },
    {
        name: "update", call: { action: "update", key: "PROJ-2", fields: { summary: "New title", labels: ["docs"] } },
        write: (request) => request.method === "PUT" && request.path === "/issue/PROJ-2", read: "GET /issue/PROJ-2",
        happened: /A read afterwards shows that it happened: PROJ-2 holds the new value of summary, labels\.$/,
        didNot: /A read afterwards shows that it did not happen: PROJ-2 still holds the old value of summary, labels\./,
        key: "PROJ-2", done: () => issue("PROJ-2").fields.summary === "New title",
    },
    {
        name: "create", call: { action: "create", project: "PROJ", type: "Bug", summary: "Login button does nothing" },
        write: (request) => request.method === "POST" && request.path === "/issue", read: "GET /search/jql",
        happened: /A read afterwards shows that it happened: PROJ-100 in PROJ has exactly this summary and was created in the last 10 minutes\.$/,
        didNot: /A read afterwards shows that it did not happen: no issue in PROJ with exactly this summary was created in the last 10 minutes\./,
        key: "PROJ-100", setUp: () => void (h.jira.duplicates = ["PROJ-100"]), done: () => h.jira.issues.has("PROJ-100"),
    },
];

describe("a reply that arrives after the timeout", () => {
    for (const c of CASES) {
        test(`${c.name}: the write was carried out, the reply was lost: one send, one read, and the tool says it happened`, async () => {
            c.setUp?.();
            late(c.write, true);
            const result = await h.call(c.call);
            const { writes, reads } = afterTheWrite();
            assert.equal(writes.length, 1, "the write is sent once");
            assert.deepEqual(reads.map((request) => `${request.method} ${request.path}`), [c.read], "one read follows it");
            assert.equal(result.error, undefined, "the write happened, so the call worked");
            assert.match(result.text, new RegExp(`^jira ${c.name}(?: on ${c.key})?: no answer from Jira \\(timed out after ${SHORT_TIMEOUTS.normal} ms\\)\\. The write was not sent again\\. `));
            assert.match(result.text, c.happened);
            assert.ok(c.done(), "the write is on the server exactly once");
            assert.deepEqual(h.jig.facts.get(result.id), [{ issue: c.key }]);
        });

        test(`${c.name}: the write never arrived: one send, one read, and the tool says it did not happen`, async () => {
            c.setUp?.();
            late(c.write, false);
            const result = await h.call(c.call);
            const { writes, reads } = afterTheWrite();
            assert.equal(writes.length, 1);
            assert.deepEqual(reads.map((request) => `${request.method} ${request.path}`), [c.read]);
            assert.match(result.error?.message ?? "", c.didNot);
            assert.match(result.error?.message ?? "", /The write was not sent again\./);
            assert.equal(c.done(), false);
            assert.equal(h.jig.facts.size, 0, "nothing happened, so nothing is recorded");
        });
    }
});

describe("other ways to lose the reply", () => {
    test("Jira answering 5xx or 408 leaves the result unknown: one read, no resend", async () => {
        for (const status of [500, 502, 503, 504, 408]) {
            h.reset();
            h.jira.misbehave({ match: (request) => request.method === "POST", status, apply: true, afterMs: 0 });
            const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
            const { writes, reads } = afterTheWrite();
            assert.equal(writes.length, 1, String(status));
            assert.equal(reads.length, 1, String(status));
            const said = `Jira said ${status} to POST /issue/PROJ-1/comment: Service Unavailable`;
            assert.ok(
                result.text.startsWith(`jira comment on PROJ-1: ${said}. The write was not sent again. A read afterwards shows that it happened`),
                `${status}: ${result.text}`,
            );
        }
    });

    test("a dropped connection is the same", async () => {
        h.jira.misbehave({ match: (request) => request.method === "POST", drop: true, apply: true, afterMs: 0 });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        const { writes, reads } = afterTheWrite();
        assert.equal(writes.length, 1);
        assert.equal(reads.length, 1);
        assert.match(result.text, /^jira comment on PROJ-1: no answer from Jira \(UND_ERR_SOCKET\)\. The write was not sent again\. A read afterwards shows that it happened/);
    });

    test("an answer that is not JSON, such as a sign-in page, is a lost reply too", async () => {
        h.jira.misbehave({ match: (request) => request.method === "POST", html: "<html><body>Please sign in</body></html>", apply: false, afterMs: 0 });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        const { writes, reads } = afterTheWrite();
        assert.equal(writes.length, 1);
        assert.equal(reads.length, 1);
        assert.match(
            result.error?.message ?? "",
            /^jira comment on PROJ-1: Jira answered with something that is not JSON, such as a sign-in page\. The write was not sent again\. A read afterwards shows that it did not happen/,
        );
    });

    test("a redirect is never followed, and means that the write was not carried out", async () => {
        h.jira.misbehave({ match: (request) => request.method === "POST", redirect: "https://sso.example.test/login?state=SECRET-STATE", apply: false, afterMs: 0 });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        const { writes, reads } = afterTheWrite();
        assert.equal(writes.length, 1);
        assert.equal(reads.length, 0);
        assert.equal(h.jira.requests.filter((request) => request.path.startsWith("/login")).length, 0, "the redirect was not followed");
        assert.match(result.error?.message ?? "", /^jira comment on PROJ-1: Jira said 302 to POST \/issue\/PROJ-1\/comment: Jira redirected the request to sso\.example\.test; it was not followed\./);
        assert.doesNotMatch(result.error?.message ?? "", /SECRET-STATE|login/, "only the host of a redirect is named");
    });

    test("Jira turning the write down (4xx) is final: no read afterwards, and the tool says nothing changed", async () => {
        for (const status of [400, 401, 403, 404, 409, 422, 429]) {
            h.reset();
            h.jira.misbehave({ match: (request) => request.method === "POST", status, apply: false, afterMs: 0 });
            const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
            const { writes, reads } = afterTheWrite();
            assert.equal(writes.length, 1, String(status));
            assert.equal(reads.length, 0, `${status}: nothing to check`);
            assert.match(result.error?.message ?? "", new RegExp(`^jira comment on PROJ-1: Jira said ${status} to POST /issue/PROJ-1/comment: .*\\. Jira changed nothing\\.$`), String(status));
            assert.equal(h.jig.facts.size, 0);
        }
    });

    test("if the read afterwards fails too, the tool says it could not settle it, and still does not resend", async () => {
        late((request) => request.method === "POST", true);
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1/comment" && request.method === "GET", drop: true, afterMs: 0 });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        const { writes, reads } = afterTheWrite();
        assert.equal(writes.length, 1);
        assert.equal(reads.length, 1);
        assert.match(
            result.error?.message ?? "",
            /A read afterwards could not settle it: the read after it failed too \(no answer from Jira \(UND_ERR_SOCKET\)\)\. Check the issue before trying again\.$/,
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ issue: "PROJ-1" }], "the issue may have been touched, so it is recorded");
    });

    test("a transition that left the issue in neither status, and an update that landed in part, are not settled", async () => {
        late((request) => request.method === "POST" && request.path.endsWith("/transitions"), false, { effect: () => void (issue("PROJ-1").fields.status = { name: "Closed" }) });
        const moved = await h.call({ action: "transition", key: "PROJ-1", transition: "Resolve Issue" }, { ask: false });
        assert.match(moved.error?.message ?? "", /could not settle it: PROJ-1 is now in Closed, which is neither In Progress nor Done\./);

        h.reset();
        late((request) => request.method === "PUT" && request.path === "/issue/PROJ-2", false, { effect: () => void (issue("PROJ-2").fields.summary = "New title") });
        const updated = await h.call({ action: "update", key: "PROJ-2", fields: { summary: "New title", labels: ["docs"] } }, { ask: false });
        assert.match(updated.error?.message ?? "", /could not settle it: PROJ-2 holds the new value of summary but not of labels\./);
    });

    test("a comment that someone else changed is not settled either", async () => {
        late((request) => request.method === "PUT", false, { effect: () => void (issue("PROJ-1").comments.find((comment) => comment.id === "10003")!.body = "Someone else's words.") });
        const result = await h.call({ action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "Mine." }, { ask: false });
        assert.match(result.error?.message ?? "", /could not settle it: comment 10003 holds neither the old nor the new text; someone else may have changed it\./);
    });

    test("when the call is cancelled nothing is read afterwards", async () => {
        const controller = new AbortController();
        // The call is cancelled at the moment the write reaches the server, so the reply is what it was waiting for.
        late((request) => request.method === "POST", true, { effect: () => controller.abort() });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" }, { signal: controller.signal });
        const { writes, reads } = afterTheWrite();
        assert.equal(writes.length, 1);
        assert.equal(reads.length, 0);
        assert.match(
            result.error?.message ?? "",
            /no answer from Jira \(cancelled\)\. The write was not sent again\. A read afterwards could not settle it: the call was cancelled, so nothing was read again\./,
        );
    });

    test("several tries never add up: each call sends its write once", async () => {
        late((request) => request.method === "POST", true);
        ok(await h.call({ action: "comment", key: "PROJ-1", text: "first" }));
        ok(await h.call({ action: "comment", key: "PROJ-1", text: "second" }));
        assert.equal(afterTheWrite().writes.length, 2, "one write per call");
        assert.deepEqual(issue("PROJ-1").comments.slice(3).map((comment) => comment.body), ["first", "second"]);
    });
});

describe("a read that fails is just an error, and may be asked again", () => {
    test("a late reply to a read is a timeout, and nothing is written", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1", afterMs: 5 * SHORT_TIMEOUTS.normal });
        const result: CallResult = await h.call({ action: "get", key: "PROJ-1" });
        assert.equal(result.error?.message, `no answer from Jira (timed out after ${SHORT_TIMEOUTS.normal} ms)`);
        assert.equal(h.jira.requests.filter(isWrite).length, 0);
        assert.match(ok(await h.call({ action: "get", key: "PROJ-1" })), /^PROJ-1 \| Bug/);
    });
});
