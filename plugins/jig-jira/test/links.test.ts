// Links between issues: link_types lists the kinds, link makes one and unlink removes one. Both writes are previewed with
// both issues and the link type, sent once, and (when the reply is lost) checked by one read of the issue.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FakeIssue, Recorded } from "./support/fake-jira.ts";
import { ok, setupHarness, SHORT_TIMEOUTS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
let datacenter: Harness;
let slow: Harness;
before(async () => {
    h = await setupHarness("cloud");
    datacenter = await setupHarness("datacenter");
    slow = await setupHarness("cloud", SHORT_TIMEOUTS);
});
after(async () => {
    await h.close();
    await datacenter.close();
    await slow.close();
});
beforeEach(() => {
    h.reset();
    datacenter.reset();
    slow.reset();
});

const issue = (harness: Harness, key: string): FakeIssue => harness.jira.issues.get(key) as FakeIssue;
const writes = (harness: Harness): Recorded[] => harness.jira.requests.filter((request) => request.method !== "GET");
const linksOf = (harness: Harness, key: string): Array<Record<string, any>> =>
    (issue(harness, key).fields.issuelinks ?? []) as Array<Record<string, any>>;

const BLOCKS = { action: "link", key: "PROJ-1", to: "PROJ-2", linkType: "Blocks" };

describe("link_types", () => {
    test("lists each type with what its two ends read, and how to use them", async () => {
        const text = ok(await h.call({ action: "link_types" }));
        assert.equal(
            text,
            [
                'Link types (3), each as "outward phrase / inward phrase":',
                "- Blocks: blocks / is blocked by",
                "- Relates: relates to / relates to",
                "- Duplicate: duplicates / is duplicated by",
                'link {key, to, linkType} reads "key <phrase> to": linkType is a name or a phrase above, and a phrase from the second half turns the link round (key "is blocked by" to).',
            ].join("\n"),
        );
        assert.deepEqual(
            h.jira.requests.map((request) => `${request.method} ${request.path}`),
            ["GET /issueLinkType"],
        );
    });

    test("is a read: nobody is asked", async () => {
        const result = await h.call({ action: "link_types" });
        assert.deepEqual(result.cls, { action: "link_types", environment: "external", effect: "read" });
        assert.equal(h.jig.approved.size, 0);
    });

    test("a Jira with no types says so", async () => {
        h.jira.linkTypes = [];
        assert.match(ok(await h.call({ action: "link_types" })), /^This Jira has no link types/);
    });
});

describe("link", () => {
    test("is previewed with both issues and the type, then made once", async () => {
        const result = await h.call(BLOCKS);
        assert.equal(ok(result), "Linked: PROJ-1 blocks PROJ-2 (Blocks).");
        assert.deepEqual(result.cls, { action: "link", environment: "external", effect: "write", approval: "dialog" });
        assert.equal(
            result.preview?.summary,
            'Link PROJ-1 "Fix login crash on Safari" blocks PROJ-2 "Update the onboarding guide" (link type Blocks)',
        );
        assert.equal(
            result.preview?.body,
            [
                'Issue: PROJ-1 "Fix login crash on Safari" (In Progress)',
                "Relation: blocks",
                'Other issue: PROJ-2 "Update the onboarding guide" (Open)',
                "Link type: Blocks (blocks / is blocked by)",
                "",
                'Seen from PROJ-2: "is blocked by PROJ-1". Jira receives outwardIssue PROJ-1 (the one that "blocks") and inwardIssue PROJ-2.',
            ].join("\n"),
        );
        assert.equal(result.preview?.html, undefined, "no text, so no page of its own");
        assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [
                [
                    "POST",
                    "/issueLink",
                    { type: { name: "Blocks" }, inwardIssue: { key: "PROJ-2" }, outwardIssue: { key: "PROJ-1" } },
                ],
            ],
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ issue: "PROJ-1" }]);
        // Each issue now lists it from its own side.
        assert.equal(linksOf(h, "PROJ-1").at(-1)?.outwardIssue?.key, "PROJ-2");
        assert.equal(linksOf(h, "PROJ-2").at(-1)?.inwardIssue?.key, "PROJ-1");
        assert.match(
            ok(await h.call({ action: "get", key: "PROJ-2" })),
            /Links:\n- is blocked by PROJ-1 \(In Progress\)/,
        );
    });

    test("the inward phrase turns the link round: PROJ-1 is blocked by PROJ-2", async () => {
        const result = await h.call({ ...BLOCKS, linkType: "is blocked by" });
        assert.equal(ok(result), "Linked: PROJ-1 is blocked by PROJ-2 (Blocks).");
        assert.match(
            result.preview?.summary ?? "",
            /^Link PROJ-1 ".*" is blocked by PROJ-2 ".*" \(link type Blocks\)$/,
        );
        assert.deepEqual(writes(h)[0]?.body, {
            type: { name: "Blocks" },
            inwardIssue: { key: "PROJ-1" },
            outwardIssue: { key: "PROJ-2" },
        });
        assert.equal(linksOf(h, "PROJ-2").at(-1)?.outwardIssue?.key, "PROJ-1");
    });

    test("a type is found by name, outward phrase or id, without regard to case, and means the first issue is outward", async () => {
        for (const linkType of ["blocks", "BLOCKS", "10000", " Blocks "]) {
            h.reset();
            const result = await h.call({ ...BLOCKS, linkType });
            assert.equal(ok(result), "Linked: PROJ-1 blocks PROJ-2 (Blocks).", linkType);
            assert.equal((writes(h)[0]?.body as any)?.outwardIssue?.key, "PROJ-1", linkType);
        }
    });

    test("a type whose two ends read the same has no direction", async () => {
        const result = await h.call({ ...BLOCKS, linkType: "relates to" });
        assert.equal(ok(result), "Linked: PROJ-1 relates to PROJ-2 (Relates).");
        // Making it again from the other side is the same link.
        const again = await h.call({ ...BLOCKS, key: "PROJ-2", to: "PROJ-1", linkType: "Relates" });
        assert.equal(
            again.blocked,
            "Blocked by jig-core: jira cannot run with this input: jira link: PROJ-2 already has this link: PROJ-2 relates to PROJ-1 (link 10200)",
        );
        assert.equal(writes(h).length, 1);
    });

    test("works the same on Data Center", async () => {
        const result = await datacenter.call(BLOCKS);
        assert.equal(ok(result), "Linked: PROJ-1 blocks PROJ-2 (Blocks).");
        assert.equal(linksOf(datacenter, "PROJ-2").at(-1)?.inwardIssue?.key, "PROJ-1");
    });

    test("a link that is already there is refused before anyone is asked", async () => {
        ok(await h.call(BLOCKS));
        h.jig.approved.clear();
        const again = await h.call(BLOCKS);
        assert.equal(
            again.blocked,
            "Blocked by jig-core: jira cannot run with this input: jira link: PROJ-1 already has this link: PROJ-1 blocks PROJ-2 (link 10200)",
        );
        assert.equal(h.jig.approved.size, 0);
        assert.equal(writes(h).length, 1);
        // The other direction is another link.
        assert.equal(
            ok(await h.call({ ...BLOCKS, linkType: "is blocked by" })),
            "Linked: PROJ-1 is blocked by PROJ-2 (Blocks).",
        );
    });

    test("a type that does not exist lists those that do", async () => {
        const result = await h.call({ ...BLOCKS, linkType: "Depends" });
        assert.equal(
            result.blocked,
            'Blocked by jig-core: jira cannot run with this input: jira link: no link type "Depends"; link_types lists them. Available: Blocks (blocks / is blocked by); Relates (relates to / relates to) (and 1 more)',
        );
        assert.equal(writes(h).length, 0);
        assert.equal(h.jig.approved.size, 0);
    });

    test("an issue that does not exist is refused, whichever end it is", async () => {
        for (const call of [
            { ...BLOCKS, key: "PROJ-99" },
            { ...BLOCKS, to: "PROJ-99" },
        ]) {
            const result = await h.call(call);
            assert.equal(
                result.blocked,
                "Blocked by jig-core: jira cannot run with this input: PROJ-99 was not found, or the account cannot see it",
            );
        }
        assert.equal(writes(h).length, 0);
    });

    test("an issue linked to itself is refused by the checks of the call", async () => {
        const result = await h.call({ ...BLOCKS, to: "PROJ-1" });
        assert.match(result.blocked ?? "", /key and to must be two different issues/);
    });

    test("Jira turning the write down is reported, and nothing is recorded", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/issueLink", status: 403, apply: false, afterMs: 0 });
        const result = await h.call(BLOCKS);
        assert.match(
            result.error?.message ?? "",
            /^jira link on PROJ-1: Jira said 403 to POST \/issueLink: .*Jira changed nothing\.$/,
        );
        assert.equal(h.jig.facts.size, 0);
    });

    test("the same link made by someone else while the person read is refused, not made twice", async () => {
        const result = await h.call(BLOCKS, {
            between: () => {
                (issue(h, "PROJ-1").fields.issuelinks as unknown[]).push({
                    id: "10150",
                    type: h.jira.linkTypes[0],
                    outwardIssue: { key: "PROJ-2", fields: { summary: "x", status: { name: "Open" } } },
                });
            },
        });
        assert.match(result.error?.message ?? "", /PROJ-1 already has this link: PROJ-1 blocks PROJ-2 \(link 10150\)/);
        assert.equal(writes(h).length, 0);
    });

    test("a type that was changed while the person read voids the approval", async () => {
        const result = await h.call(BLOCKS, { between: () => void (h.jira.linkTypes[0]!.name = "Blocking") });
        assert.match(result.error?.message ?? "", /no link type "Blocks"|changed since the preview/);
        assert.equal(writes(h).length, 0);
    });
});

describe("unlink", () => {
    test("is previewed with both issues and the type, then removes that link once", async () => {
        const result = await h.call({ action: "unlink", key: "PROJ-1", to: "PROJ-3" });
        assert.equal(ok(result), "Removed the link: PROJ-1 blocks PROJ-3 (Blocks).");
        assert.deepEqual(result.cls, {
            action: "unlink",
            environment: "external",
            effect: "write",
            approval: "dialog",
        });
        assert.equal(
            result.preview?.summary,
            'Remove the link "PROJ-1 blocks PROJ-3" between PROJ-1 "Fix login crash on Safari" and PROJ-3 "Release 1.2" (link type Blocks)',
        );
        assert.equal(
            result.preview?.body,
            [
                'Issue: PROJ-1 "Fix login crash on Safari" (In Progress)',
                "Relation: blocks",
                'Other issue: PROJ-3 "Release 1.2" (Open)',
                "Link type: Blocks (blocks / is blocked by)",
                "Link id: 10100",
                "",
                "Only this link is removed; neither issue is changed otherwise. Linking again brings it back.",
            ].join("\n"),
        );
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [["DELETE", "/issueLink/10100", undefined]],
        );
        assert.equal(linksOf(h, "PROJ-1").length, 0);
        assert.deepEqual(h.jig.facts.get(result.id), [{ issue: "PROJ-1" }]);
    });

    test("works from either end: the other end reads the inward phrase", async () => {
        ok(await h.call(BLOCKS));
        const result = await h.call({ action: "unlink", key: "PROJ-2", to: "PROJ-1" });
        assert.equal(ok(result), "Removed the link: PROJ-2 is blocked by PROJ-1 (Blocks).");
        assert.equal(
            linksOf(h, "PROJ-1").some((link) => link.outwardIssue?.key === "PROJ-2"),
            false,
        );
        assert.equal(linksOf(h, "PROJ-2").length, 0);
    });

    test("with several links between two issues, linkType says which; it takes a name or a phrase", async () => {
        ok(await h.call(BLOCKS));
        ok(await h.call({ ...BLOCKS, linkType: "Duplicate" }));
        const unclear = await h.call({ action: "unlink", key: "PROJ-1", to: "PROJ-2" });
        assert.equal(
            unclear.blocked,
            "Blocked by jig-core: jira cannot run with this input: jira unlink: PROJ-1 has 2 links to PROJ-2 (blocks PROJ-2 [Blocks]; duplicates PROJ-2 [Duplicate]); name one with linkType",
        );
        const one = await h.call({ action: "unlink", key: "PROJ-1", to: "PROJ-2", linkType: "duplicates" });
        assert.equal(ok(one), "Removed the link: PROJ-1 duplicates PROJ-2 (Duplicate).");
        assert.equal(
            linksOf(h, "PROJ-1").filter((link) => link.outwardIssue?.key === "PROJ-2").length,
            1,
            "Blocks stays",
        );
    });

    test("a link that is not there is refused with the links the issue has", async () => {
        const none = await h.call({ action: "unlink", key: "PROJ-1", to: "PROJ-2" });
        assert.equal(
            none.blocked,
            "Blocked by jig-core: jira cannot run with this input: jira unlink: PROJ-1 has no link to PROJ-2; its links: blocks PROJ-3 [Blocks]",
        );
        const wrong = await h.call({ action: "unlink", key: "PROJ-1", to: "PROJ-3", linkType: "Duplicate" });
        assert.equal(
            wrong.blocked,
            'Blocked by jig-core: jira cannot run with this input: jira unlink: PROJ-1 has no link to PROJ-3 of type "Duplicate"; its links to PROJ-3: blocks PROJ-3 [Blocks]',
        );
        const empty = await h.call({ action: "unlink", key: "PROJ-2", to: "PROJ-1" });
        assert.match(empty.blocked ?? "", /PROJ-2 has no link to PROJ-1; its links: none$/);
        assert.equal(writes(h).length, 0);
        assert.equal(h.jig.approved.size, 0);
    });

    test("an issue that does not exist is refused", async () => {
        const result = await h.call({ action: "unlink", key: "PROJ-99", to: "PROJ-1" });
        assert.match(result.blocked ?? "", /PROJ-99 was not found, or the account cannot see it$/);
    });

    test("a link removed by someone else while the person read is refused, not retried", async () => {
        const result = await h.call(
            { action: "unlink", key: "PROJ-1", to: "PROJ-3" },
            { between: () => void (issue(h, "PROJ-1").fields.issuelinks = []) },
        );
        assert.match(result.error?.message ?? "", /PROJ-1 has no link to PROJ-3/);
        assert.equal(writes(h).length, 0);
    });
});

describe("a reply that is lost", () => {
    const late = (path: RegExp, applied: boolean): void =>
        slow.jira.misbehave({
            match: (request) => request.method !== "GET" && path.test(request.path),
            apply: applied,
            afterMs: 5 * SHORT_TIMEOUTS.normal,
        });

    test("link: it is not sent again, and one read of the issue says it happened", async () => {
        late(/^\/issueLink$/, true);
        const result = await slow.call(BLOCKS);
        assert.equal(result.error, undefined);
        assert.match(
            result.text,
            /^jira link on PROJ-1: no answer from Jira \(timed out after \d+ ms\)\. The write was not sent again\. A read afterwards shows that it happened: PROJ-1 now blocks PROJ-2 \(link 10200\)\.$/,
        );
        assert.equal(writes(slow).length, 1);
        assert.deepEqual(slow.jig.facts.get(result.id), [{ issue: "PROJ-1" }]);
    });

    test("link: when it did not happen the tool says so", async () => {
        late(/^\/issueLink$/, false);
        const result = await slow.call(BLOCKS);
        assert.match(
            result.error?.message ?? "",
            /A read afterwards shows that it did not happen: PROJ-1 holds no Blocks link to PROJ-2\. Run it again if it is still wanted\.$/,
        );
        assert.equal(linksOf(slow, "PROJ-2").length, 0);
        assert.equal(writes(slow).length, 1);
    });

    test("link: a link that is there but reads the other way is not settled", async () => {
        late(/^\/issueLink$/, false);
        const result = await slow.call(BLOCKS, {
            between: () => {
                (issue(slow, "PROJ-1").fields.issuelinks as unknown[]).push({
                    id: "10160",
                    type: slow.jira.linkTypes[0],
                    inwardIssue: { key: "PROJ-2", fields: { summary: "x", status: { name: "Open" } } },
                });
            },
        });
        assert.match(
            result.error?.message ?? "",
            /could not settle it: PROJ-1 holds a Blocks link to PROJ-2, but it reads "is blocked by", not "blocks"\./,
        );
    });

    test("unlink: it is not sent again, and one read says the link is gone", async () => {
        late(/^\/issueLink\/10100$/, true);
        const result = await slow.call({ action: "unlink", key: "PROJ-1", to: "PROJ-3" });
        assert.match(result.text, /A read afterwards shows that it happened: link 10100 is no longer on PROJ-1\.$/);
        assert.equal(writes(slow).length, 1);
    });

    test("unlink: when it did not happen the tool says so", async () => {
        late(/^\/issueLink\/10100$/, false);
        const result = await slow.call({ action: "unlink", key: "PROJ-1", to: "PROJ-3" });
        assert.match(
            result.error?.message ?? "",
            /A read afterwards shows that it did not happen: link 10100 is still on PROJ-1\./,
        );
        assert.equal(linksOf(slow, "PROJ-1").length, 1);
    });
});
