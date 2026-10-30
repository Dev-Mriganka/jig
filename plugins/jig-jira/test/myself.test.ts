// A comment without `GET /myself`. Some sites reach Jira only through a sign-in proxy that has no "who am I". The comment
// then still works, and only what needed the person degrades: the preview does not say who posts (and says why), the
// fingerprint holds nothing of the account, and the check after a lost reply goes by the text alone.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Transport } from "../../jig-core/src/contract.ts";
import type { FakeIssue, Recorded } from "./support/fake-jira.ts";
import { ok, setupHarness, SHORT_TIMEOUTS, SITE } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness("cloud", SHORT_TIMEOUTS);
});
after(() => h.close());
beforeEach(() => h.reset());

const issue = (key: string): FakeIssue => h.jira.issues.get(key) as FakeIssue;
const COMMENT = { action: "comment", key: "PROJ-1", text: "Checked on Safari 17." };
const posts = (): Recorded[] => h.jira.sent("POST", "/issue/PROJ-1/comment");
const sameComment = (): number => issue("PROJ-1").comments.filter((comment) => comment.body === COMMENT.text).length;

/** A proxy that forwards everything to the fake Jira, except that it does not serve `/myself`. */
function proxyWithoutMyself(): Transport {
    return {
        async request(request, signal) {
            if (new URL(request.url).pathname.endsWith("/myself"))
                throw new Error("the proxy does not serve this path");
            const response = await fetch(request.url.replace(SITE, h.jira.origin), {
                method: request.method,
                headers: request.headers ?? {},
                body: request.body,
                ...(signal === undefined ? {} : { signal }),
            });
            return {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: await response.text(),
            };
        },
    };
}

describe("a Jira that does not say who is signed in", () => {
    for (const status of [404, 403]) {
        test(`${status} on /myself: the comment is previewed without a name, with a note, and posted once`, async () => {
            h.jira.myselfStatus = status;
            const result = await h.call(COMMENT);
            assert.equal(ok(result), "Added comment 10100 to PROJ-1.");
            assert.equal(
                result.preview?.summary,
                'Add a comment to PROJ-1 "Fix login crash on Safari" (In Progress)',
                "no 'as <name>' when the name is not known",
            );
            assert.match(
                result.preview?.body ?? "",
                new RegExp(
                    `^This Jira does not say who you are signed in as \\(Jira answered ${status} to GET /myself\\), ` +
                        "so the preview cannot show who posts\\. If the reply to the comment is lost, " +
                        "the check afterwards finds a comment by its text only\\.\\n\\nComment \\(Jira wiki markup\\):",
                ),
            );
            assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
            assert.equal(posts().length, 1);
            assert.deepEqual(posts()[0]?.body, { body: COMMENT.text });
            assert.deepEqual(h.jig.facts.get(result.id), [{ issue: "PROJ-1" }]);
        });
    }

    test("a transport that refuses the request for /myself is the same", async () => {
        h.configure({ site: SITE, auth: { transport: "company-proxy" } });
        h.jig.transports.set("company-proxy", proxyWithoutMyself());
        const result = await h.call(COMMENT);
        assert.equal(ok(result), "Added comment 10100 to PROJ-1.");
        assert.match(result.preview?.body ?? "", /\(the transport did not carry GET \/myself\)/);
        assert.doesNotMatch(result.preview?.summary ?? "", /, as /);
        assert.equal(posts().length, 1);
        assert.equal(h.jira.sent("GET", "/myself").length, 0, "the proxy never passed it on");
    });

    test("when /myself works, nothing changes: the name is shown and there is no note", async () => {
        const result = await h.call(COMMENT);
        assert.equal(
            result.preview?.summary,
            'Add a comment to PROJ-1 "Fix login crash on Safari" (In Progress), as Jane Doe',
        );
        assert.doesNotMatch(result.preview?.body ?? "", /does not say who you are/);
    });

    test("only a 403, a 404 or the transport's refusal is let through: any other failure still stops the comment", async () => {
        for (const status of [401, 500]) {
            h.reset();
            h.jira.myselfStatus = status;
            const result = await h.call(COMMENT);
            assert.match(result.error?.message ?? "", new RegExp(`Jira said ${status} to GET /myself`), String(status));
            assert.match(result.preview?.summary ?? "", /^preview unavailable/);
            assert.equal(posts().length, 0);
        }
    });

    test("the preview still names the account when it is known, and the fingerprint tells the two cases apart", async () => {
        const known = await h.call(COMMENT);
        h.reset();
        h.jira.myselfStatus = 404;
        const unknown = await h.call(COMMENT);
        assert.notEqual(known.preview?.fingerprint, unknown.preview?.fingerprint);
    });

    test("a sign-in that stops answering /myself between the preview and the write voids the approval", async () => {
        const result = await h.call(COMMENT, { between: () => void (h.jira.myselfStatus = 404) });
        assert.match(result.error?.message ?? "", /changed since the preview/);
        assert.equal(posts().length, 0);
    });
});

describe("after a lost reply, without knowing who is signed in", () => {
    const lose = (applied: boolean): void =>
        h.jira.misbehave({
            match: (request) => request.method === "POST",
            apply: applied,
            afterMs: 5 * SHORT_TIMEOUTS.normal,
        });

    test("a write that was not carried out is told by the text: no comment holds it", async () => {
        h.jira.myselfStatus = 404;
        lose(false);
        const result = await h.call(COMMENT);
        assert.equal(sameComment(), 0);
        assert.match(
            result.error?.message ?? "",
            /A read afterwards shows that it did not happen: the newest 50 comments on PROJ-1 hold none with this text\. Run it again if it is still wanted\.$/,
        );
        assert.equal(posts().length, 1, "and it was not sent again");
    });

    test("a write that was carried out cannot be told from another comment with the same text, and the tool says so", async () => {
        h.jira.myselfStatus = 404;
        lose(true);
        const result = await h.call(COMMENT);
        assert.equal(sameComment(), 1);
        assert.match(
            result.error?.message ?? "",
            /A read afterwards could not settle it: a comment with this text \(newest 10100, created 2026-10-30 10:00\) is on PROJ-1, but who wrote it cannot be told, as Jira does not say who you are\. Check the issue before trying again\.$/,
        );
        assert.equal(posts().length, 1, "it was not sent again");
    });

    test("several comments with the text are counted", async () => {
        h.jira.myselfStatus = 404;
        issue("PROJ-1").comments.push({
            id: "10050",
            author: h.jira.users[1] as never,
            body: COMMENT.text,
            created: "2026-10-29T09:00:00.000+0000",
            updated: "2026-10-29T09:00:00.000+0000",
        });
        lose(true);
        const result = await h.call(COMMENT);
        assert.match(
            result.error?.message ?? "",
            /2 comments with this text \(newest 10100, created 2026-10-30 10:00\) are on PROJ-1, but who wrote them cannot be told/,
        );
    });

    test("with /myself the check is as before: the comment by you with this text", async () => {
        lose(true);
        const result = await h.call(COMMENT);
        assert.equal(result.error, undefined, "a write that a read afterwards confirms is reported as done");
        assert.match(result.text, /A read afterwards shows that it happened: comment 10100 by you with this text/);
    });
});
