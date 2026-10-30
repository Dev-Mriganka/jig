// The six writes against a fake Jira: each is previewed, approved, and sent once. What the preview shows, the request that is
// sent, what the tool says afterwards, and what is recorded.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FakeIssue, Recorded } from "./support/fake-jira.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { CallResult, Harness } from "./support/harness.ts";

let h: Harness;
let datacenter: Harness;
before(async () => {
    h = await setupHarness("cloud");
    datacenter = await setupHarness("datacenter");
});
after(async () => {
    await h.close();
    await datacenter.close();
});
beforeEach(() => {
    h.reset();
    datacenter.reset();
});

const issue = (harness: Harness, key: string): FakeIssue => harness.jira.issues.get(key) as FakeIssue;
const writes = (harness: Harness): Recorded[] => harness.jira.requests.filter((request) => request.method !== "GET");
const factsOf = (harness: Harness, result: CallResult) => harness.jig.facts.get(result.id);

describe("comment", () => {
    const TEXT = "Checked on *Safari 17*.\nDetails in [PR 42|https://git.example.test/org/app/pull/42].";

    test("is previewed with its source and rendered page, then added once", async () => {
        const result = await h.call({ action: "comment", key: "PROJ-1", text: TEXT });
        assert.equal(ok(result), "Added comment 10100 to PROJ-1.");
        assert.deepEqual(result.cls, {
            action: "comment",
            environment: "external",
            effect: "write",
            approval: "review",
        });

        const preview = result.preview;
        assert.equal(
            preview?.summary,
            'Add a comment to PROJ-1 "Fix login crash on Safari" (In Progress), as Jane Doe',
        );
        assert.equal(preview?.format, "text");
        assert.equal(preview?.body, `Comment (Jira wiki markup):\n${TEXT}`);
        assert.match(preview?.html ?? "", /<strong>Safari 17<\/strong>/);
        assert.match(
            preview?.html ?? "",
            /<a href="https:\/\/git\.example\.test\/org\/app\/pull\/42" rel="noreferrer noopener">PR 42<\/a>/,
        );
        assert.match(preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);

        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [["POST", "/issue/PROJ-1/comment", { body: TEXT }]],
        );
        const added = issue(h, "PROJ-1").comments.at(-1);
        assert.deepEqual([added?.id, added?.author.displayName, added?.body], ["10100", "Jane Doe", TEXT]);
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-1" }]);
    });

    test("the text goes as written: spaces, blank lines and braces", async () => {
        const text = "  indented\n\n{code}\nx < y\n{code}\n";
        ok(await h.call({ action: "comment", key: "PROJ-1", text }));
        assert.equal(issue(h, "PROJ-1").comments.at(-1)?.body, text);
    });

    test("an issue that does not exist is refused before anyone is asked", async () => {
        const result = await h.call({ action: "comment", key: "PROJ-99", text: "hi" });
        assert.equal(
            result.blocked,
            "Blocked by jig-core: jira cannot run with this input: PROJ-99 was not found, or the account cannot see it",
        );
        assert.equal(writes(h).length, 0);
        assert.equal(h.jig.approved.size, 0);
    });

    test("Jira turning the write down is reported, and nothing is recorded", async () => {
        h.jira.misbehave({ match: (request) => request.method === "POST", status: 403, apply: false, afterMs: 0 });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "hi" });
        assert.match(
            result.error?.message ?? "",
            /^jira comment on PROJ-1: Jira said 403 to POST \/issue\/PROJ-1\/comment: .*Jira changed nothing\.$/,
        );
        assert.equal(h.jig.facts.size, 0);
    });
});

describe("edit_comment and delete_comment", () => {
    test("edit_comment shows the new text and the text it replaces, then replaces it", async () => {
        const result = await h.call({
            action: "edit_comment",
            key: "PROJ-1",
            commentId: "10003",
            text: "Verified on staging and prod.",
        });
        assert.equal(ok(result), "Updated comment 10003 on PROJ-1.");
        assert.deepEqual(result.cls?.approval, "review");
        assert.equal(result.preview?.summary, 'Replace comment 10003 by Sam Lee on PROJ-1 "Fix login crash on Safari"');
        assert.equal(
            result.preview?.body,
            "New text (Jira wiki markup):\nVerified on staging and prod.\n\nIt replaces:\nVerified on staging.",
        );
        assert.match(
            result.preview?.html ?? "",
            /It replaces this text<\/summary><div class="wiki"><p>Verified on staging\.<\/p>/,
        );
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [["PUT", "/issue/PROJ-1/comment/10003", { body: "Verified on staging and prod." }]],
        );
        assert.equal(
            issue(h, "PROJ-1").comments.find((comment) => comment.id === "10003")?.body,
            "Verified on staging and prod.",
        );
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-1" }]);
    });

    test("delete_comment shows the comment's text and that this cannot be undone, then deletes it", async () => {
        const result = await h.call({ action: "delete_comment", key: "PROJ-1", commentId: "10002" });
        assert.equal(ok(result), "Deleted comment 10002 from PROJ-1.");
        assert.deepEqual(result.cls, {
            action: "delete_comment",
            environment: "external",
            effect: "write",
            approval: "dialog",
        });
        assert.match(
            result.preview?.summary ?? "",
            /^Delete comment 10002 by Jane Doe on PROJ-1 "Fix login crash on Safari"\. This cannot be undone\.$/,
        );
        assert.equal(
            result.preview?.body,
            "This cannot be undone. The text of the comment is below.\n\nComment to delete (Jira wiki markup):\n" +
                "Fix is in [PR 42|https://git.example.test/org/app/pull/42].",
        );
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path]),
            [["DELETE", "/issue/PROJ-1/comment/10002"]],
        );
        assert.deepEqual(
            issue(h, "PROJ-1").comments.map((comment) => comment.id),
            ["10001", "10003"],
        );
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-1" }]);
    });

    test("a comment that is not there is refused before anyone is asked", async () => {
        for (const input of [{ action: "edit_comment", text: "x" }, { action: "delete_comment" }]) {
            const result = await h.call({ ...input, key: "PROJ-1", commentId: "99999" });
            assert.equal(
                result.blocked,
                "Blocked by jig-core: jira cannot run with this input: comment 99999 on PROJ-1 was not found, or the account cannot see it",
                input.action,
            );
        }
        assert.equal(writes(h).length, 0);
    });
});

describe("transition", () => {
    test("shows where the issue is and where it will be, then moves it with the transition's id", async () => {
        const result = await h.call({ action: "transition", key: "PROJ-1", transition: "Resolve Issue" });
        assert.equal(ok(result), 'PROJ-1 moved from In Progress to Done (transition "Resolve Issue").');
        assert.deepEqual(result.cls, {
            action: "transition",
            environment: "external",
            effect: "write",
            approval: "dialog",
        });
        assert.equal(
            result.preview?.summary,
            'Move PROJ-1 "Fix login crash on Safari" from In Progress to Done (transition "Resolve Issue")',
        );
        assert.equal(result.preview?.body, "From: In Progress\nTo: Done\nTransition: Resolve Issue [31]");
        assert.equal(result.preview?.html, undefined, "nothing here is text to render");
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [["POST", "/issue/PROJ-1/transitions", { transition: { id: "31" } }]],
        );
        assert.deepEqual(issue(h, "PROJ-1").fields.status, { name: "Done" });
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-1" }]);
    });

    test("a name matches without regard to case, and the id works too", async () => {
        ok(await h.call({ action: "transition", key: "PROJ-1", transition: "back to open" }));
        assert.deepEqual(issue(h, "PROJ-1").fields.status, { name: "Open" });
        ok(await h.call({ action: "transition", key: "PROJ-1", transition: "21" }));
        assert.deepEqual(issue(h, "PROJ-1").fields.status, { name: "In Progress" });
    });

    test("a name that matches no transition is refused with the names there are", async () => {
        const result = await h.call({ action: "transition", key: "PROJ-1", transition: "Finish" });
        assert.equal(
            result.blocked,
            "Blocked by jig-core: jira cannot run with this input: " +
                'jira transition: PROJ-1 has no transition named "Finish"; available: Start Progress, Resolve Issue, Back to Open',
        );
        assert.equal(writes(h).length, 0);
        assert.equal(h.jig.approved.size, 0, "nobody was asked");
    });

    test("a status name gets a hint at the transition that leads to it, and is not used", async () => {
        const result = await h.call({ action: "transition", key: "PROJ-1", transition: "done" });
        assert.match(
            result.blocked ?? "",
            /jira transition: PROJ-1 has no transition named "done", which is a status; the transition "Resolve Issue" leads to it$/,
        );
        assert.equal(writes(h).length, 0);
    });

    test("a name that matches several transitions is refused, and the id picks one", async () => {
        const result = await h.call({ action: "transition", key: "PROJ-2", transition: "Close" });
        assert.match(
            result.blocked ?? "",
            /jira transition: "Close" matches several transitions on PROJ-2 \(Close -> Closed \[51\]; Close -> Won't Do \[52\]\); pass the id$/,
        );
        assert.equal(
            ok(await h.call({ action: "transition", key: "PROJ-2", transition: "52" })),
            'PROJ-2 moved from Open to Won\'t Do (transition "Close").',
        );
    });

    test("the refusal fits in what jig-core shows, even for an issue with many transitions", async () => {
        issue(h, "PROJ-1").transitions = Array.from({ length: 30 }, (_, index) => ({
            id: String(100 + index),
            name: `Move to column number ${index}`,
            to: `Column ${index}`,
        }));
        const result = await h.call({ action: "transition", key: "PROJ-1", transition: "Nowhere" });
        assert.ok(
            (result.blocked ?? "").replace("Blocked by jig-core: jira cannot run with this input: ", "").length <= 200,
        );
        assert.match(
            result.blocked ?? "",
            /available: Move to column number 0, Move to column number 1.* \(and \d+ more\)$/,
        );
    });
});

describe("update", () => {
    test("shows each field as before and after, then sets them in one request", async () => {
        const result = await h.call({
            action: "update",
            key: "PROJ-2",
            fields: {
                summary: "Update the onboarding guide (VPN)",
                labels: ["docs"],
                assignee: "Sam Lee",
                priority: "High",
            },
        });
        assert.equal(ok(result), "Updated PROJ-2: summary, labels, assignee, priority.");
        assert.deepEqual(result.cls, {
            action: "update",
            environment: "external",
            effect: "write",
            approval: "dialog",
        });
        assert.equal(
            result.preview?.summary,
            'Update PROJ-2 "Update the onboarding guide": summary, labels, assignee, priority',
        );
        assert.equal(
            result.preview?.body,
            [
                "summary: Update the onboarding guide → Update the onboarding guide (VPN)",
                "labels: (empty) → docs",
                "assignee: (empty) → Sam Lee (712020:6c21d3a0-1111-4222-8333-944455556666)",
                "priority: Medium → High",
            ].join("\n"),
        );
        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [
                [
                    "PUT",
                    "/issue/PROJ-2",
                    {
                        fields: {
                            summary: "Update the onboarding guide (VPN)",
                            labels: ["docs"],
                            assignee: { accountId: "712020:6c21d3a0-1111-4222-8333-944455556666" },
                            priority: { name: "High" },
                        },
                    },
                ],
            ],
        );
        const fields = issue(h, "PROJ-2").fields;
        assert.deepEqual(
            [fields.summary, fields.labels, fields.priority],
            ["Update the onboarding guide (VPN)", ["docs"], { name: "High" }],
        );
        assert.equal((fields.assignee as { displayName: string }).displayName, "Sam Lee");
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-2" }]);
    });

    test("a person is sent as Jira names them: an account id on Cloud, a user name on Data Center", async () => {
        ok(await datacenter.call({ action: "update", key: "PROJ-2", fields: { assignee: "slee" } }));
        assert.deepEqual(writes(datacenter)[0]?.body, { fields: { assignee: { name: "slee" } } });
        ok(await datacenter.call({ action: "update", key: "PROJ-2", fields: { assignee: "Jane Doe" } }));
        assert.deepEqual(
            writes(datacenter)[1]?.body,
            { fields: { assignee: { name: "jdoe" } } },
            "a display name finds the same person",
        );
        ok(await datacenter.call({ action: "update", key: "PROJ-2", fields: { assignee: null } }));
        assert.deepEqual(writes(datacenter)[2]?.body, { fields: { assignee: null } });
        assert.equal(issue(datacenter, "PROJ-2").fields.assignee, null);
    });

    test("a person who cannot be found, or is found twice, is refused with a way forward", async () => {
        const none = await h.call({ action: "update", key: "PROJ-2", fields: { assignee: "Nobody" } });
        assert.match(
            none.blocked ?? "",
            /jira update: assignee: no one who can be assigned matches "Nobody"; ask assignable for the ids$/,
        );
        (h.jira.users[1] as { displayName: string }).displayName = "Jane Doe";
        const two = await h.call({ action: "update", key: "PROJ-2", fields: { assignee: "Jane Doe" } });
        assert.ok(
            two.blocked?.endsWith(
                'jira update: assignee "Jane Doe" matches several people; use an id from assignable: ' +
                    "Jane Doe (5b10a2844c20165700ede21g); Jane Doe (712020:6c21d3a0-1111-4222-8333-944455556666)",
            ),
            two.blocked ?? "",
        );
        assert.equal(writes(h).length, 0);
        const byId = await h.call({
            action: "update",
            key: "PROJ-2",
            fields: { assignee: "5b10a2844c20165700ede21g" },
        });
        assert.equal(ok(byId), "Updated PROJ-2: assignee.");
    });

    test("a description is shown as text with the text it replaces, and uses the review screen", async () => {
        const result = await h.call({
            action: "update",
            key: "PROJ-2",
            fields: { description: "h3. New steps\n# Connect to the *VPN*" },
        });
        assert.equal(ok(result), "Updated PROJ-2: description.");
        assert.equal(result.cls?.approval, "review");
        assert.equal(
            result.preview?.body,
            "Description (Jira wiki markup):\nh3. New steps\n# Connect to the *VPN*\n\nIt replaces:\nAdd the new VPN steps.",
        );
        assert.match(
            result.preview?.html ?? "",
            /<h3>New steps<\/h3>\n<ol><li>Connect to the <strong>VPN<\/strong><\/li><\/ol>/,
        );
        assert.equal(issue(h, "PROJ-2").fields.description, "h3. New steps\n# Connect to the *VPN*");
    });

    test("a description can be cleared", async () => {
        const result = await h.call({ action: "update", key: "PROJ-2", fields: { description: null } });
        assert.equal(ok(result), "Updated PROJ-2: description.");
        assert.equal(result.preview?.body, "description: Add the new VPN steps. → (cleared)");
        assert.equal(issue(h, "PROJ-2").fields.description, null);
    });

    test("only the fields in updateFields may be set, by name or by a friendly name", async () => {
        const refused = await h.call({ action: "update", key: "PROJ-1", fields: { reporter: "slee" } });
        assert.equal(
            refused.blocked,
            "Blocked by jig-core: jira cannot run with this input: " +
                'jira update: "reporter" is not a field that update may set. ' +
                "It may set: summary, description, labels, priority, assignee",
        );

        h.configure({
            site: "https://jira.example.test",
            auth: { token: "pass:jira/token" },
            fields: { Points: "customfield_10016", "Pull Request": "customfield_10500" },
            updateFields: ["summary", "points", "customfield_10500"],
        });
        const refusedAgain = await h.call({ action: "update", key: "PROJ-1", fields: { labels: ["x"] } });
        assert.match(refusedAgain.blocked ?? "", /It may set: summary, points, customfield_10500, Pull Request$/);
        const result = await h.call({
            action: "update",
            key: "PROJ-1",
            fields: { Points: 8, "pull request": "https://git.example.test/org/app/pull/43" },
        });
        assert.equal(ok(result), "Updated PROJ-1: Points, pull request.");
        assert.deepEqual(writes(h)[0]?.body, {
            fields: { customfield_10016: 8, customfield_10500: "https://git.example.test/org/app/pull/43" },
        });
        assert.equal(
            result.preview?.body,
            "Points: 5 → 8\npull request: https://git.example.test/org/app/pull/42 → https://git.example.test/org/app/pull/43",
        );
    });

    test("a field given twice, or a value Jira would refuse, is a mistake in the call", async () => {
        assert.match(
            (await h.call({ action: "update", key: "PROJ-1", fields: { summary: "a", Summary: "b" } })).blocked ?? "",
            /jira update: summary is given twice$/,
        );
        assert.match(
            (await h.call({ action: "update", key: "PROJ-1", fields: { labels: ["two words"] } })).blocked ?? "",
            /jira update: labels: a label cannot contain a space$/,
        );
        assert.match(
            (await h.call({ action: "update", key: "PROJ-1", fields: { summary: "one\ntwo" } })).blocked ?? "",
            /jira update: summary: must be one line of 1 to 255 characters$/,
        );
        assert.match(
            (await h.call({ action: "update", key: "PROJ-1", fields: { priority: 3 } })).blocked ?? "",
            /jira update: priority: must be a priority name, such as High$/,
        );
        const tooLong = await h.call({ action: "update", key: "PROJ-1", fields: { description: "x".repeat(32768) } });
        assert.match(
            tooLong.blocked ?? "",
            /jira update: description: 32768 characters; Jira refuses text over 32767$/,
        );
        assert.match(
            (await h.call({ action: "update", key: "PROJ-99", fields: { summary: "a" } })).blocked ?? "",
            /PROJ-99 was not found, or the account cannot see it$/,
        );
        assert.equal(writes(h).length, 0);
    });

    test("Jira refusing a field is reported with its own words", async () => {
        h.configure({
            site: "https://jira.example.test",
            auth: { token: "pass:jira/token" },
            updateFields: ["summary", "bogus"],
        });
        const result = await h.call({ action: "update", key: "PROJ-1", fields: { bogus: 1 } });
        assert.equal(
            result.error?.message,
            "jira update on PROJ-1: Jira said 400 to PUT /issue/PROJ-1: " +
                "bogus: Field 'bogus' cannot be set. It is not on the appropriate screen, or unknown. Jira changed nothing.",
        );
    });
});

describe("create", () => {
    const BUG = {
        action: "create",
        project: "PROJ",
        type: "Bug",
        summary: "Login button does nothing on Safari",
        description: "h3. Steps\n# Open the page\n# Press *Sign in*",
        fields: { priority: "high", labels: ["login"], components: ["web"], "Story Points": 3 },
    };

    test("shows every field with its final value and the description, then creates the issue once", async () => {
        h.configure({
            site: "https://jira.example.test",
            auth: { token: "pass:jira/token" },
            fields: { "Story Points": "customfield_10016" },
        });
        const result = await h.call(BUG);
        assert.equal(
            ok(result),
            "Created PROJ-100: Login button does nothing on Safari\nhttps://jira.example.test/browse/PROJ-100",
        );
        assert.deepEqual(result.cls, {
            action: "create",
            environment: "external",
            effect: "write",
            approval: "review",
        });
        assert.equal(result.preview?.summary, 'Create a Bug in PROJ: "Login button does nothing on Safari"');
        assert.equal(
            result.preview?.body,
            [
                "Project: PROJ",
                "Type: Bug",
                "Summary: Login button does nothing on Safari",
                "Priority: High",
                "Labels: login",
                "Components: Web",
                "Story Points: 3",
                "",
                "Possible duplicates: none among the issues created in PROJ in the last 30 days.",
                "",
                "Description (Jira wiki markup):",
                "h3. Steps",
                "# Open the page",
                "# Press *Sign in*",
            ].join("\n"),
        );
        assert.match(
            result.preview?.html ?? "",
            /<h3>Steps<\/h3>\n<ol><li>Open the page<\/li><li>Press <strong>Sign in<\/strong><\/li><\/ol>/,
        );

        assert.deepEqual(
            writes(h).map((request) => [request.method, request.path, request.body]),
            [
                [
                    "POST",
                    "/issue",
                    {
                        fields: {
                            project: { key: "PROJ" },
                            issuetype: { id: "10004" },
                            summary: "Login button does nothing on Safari",
                            description: BUG.description,
                            priority: { id: "2" },
                            labels: ["login"],
                            components: [{ id: "10000" }],
                            customfield_10016: 3,
                        },
                    },
                ],
            ],
        );
        assert.deepEqual(factsOf(h, result), [{ issue: "PROJ-100" }]);
        assert.equal(issue(h, "PROJ-100").fields.summary, "Login button does nothing on Safari");
    });

    test("reads the create screen first: the issue types of the project, then the fields of the type", async () => {
        ok(await h.call({ action: "create", project: "PROJ", type: "bug", summary: "A bug" }));
        const reads = h.jira.requests.filter((request) => request.method === "GET").map((request) => request.path);
        assert.deepEqual(reads.slice(0, 2), [
            "/issue/createmeta/PROJ/issuetypes",
            "/issue/createmeta/PROJ/issuetypes/10004",
        ]);
        const posted = h.jira.requests.find((request) => request.method === "POST")?.body as {
            fields: { issuetype: unknown };
        };
        assert.deepEqual(posted.fields.issuetype, { id: "10004" }, "the type is the one the screen named, by its id");
    });

    test("looks for possible duplicates in the project over the last 30 days, and lists what it finds", async () => {
        h.jira.duplicates = ["PROJ-2"];
        const result = await h.call({
            action: "create",
            project: "PROJ",
            type: "Bug",
            summary: 'Fix "login" (crash): a&b | c!',
        });
        const search = h.jira.sent("GET", "/search/jql")[0];
        assert.equal(
            search?.query.jql,
            'project = "PROJ" AND created >= -30d AND summary ~ "Fix login crash a b c"',
            "only words reach the query",
        );
        assert.equal(search?.query.maxResults, "5");
        assert.match(
            result.preview?.body ?? "",
            /Possible duplicates, created in PROJ in the last 30 days:\n {2}PROJ-2 \[Open\] Update the onboarding guide$/,
        );
    });

    test("a duplicate search that fails does not stop the preview, and says so", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/search/jql", status: 500, apply: false, afterMs: 0 });
        const result = await h.call({ action: "create", project: "PROJ", type: "Bug", summary: "A bug" });
        assert.match(
            result.preview?.body ?? "",
            /Possible duplicates: the search failed \(Jira said 500 to GET \/search\/jql: Service Unavailable\)\. Look in PROJ yourself\./,
        );
        assert.equal(ok(result).split("\n")[0], "Created PROJ-100: A bug");
    });

    test("a summary with no words is not searched", async () => {
        const result = await h.call({ action: "create", project: "PROJ", type: "Bug", summary: "!!! ???" });
        assert.match(
            result.preview?.body ?? "",
            /Possible duplicates: not checked, the summary has no words to search for\./,
        );
        assert.equal(h.jira.sent("GET", "/search/jql").length, 0);
    });

    test("an unknown type, project or field is refused with the choices, before anyone is asked", async () => {
        assert.match(
            (await h.call({ ...BUG, type: "Epic" })).blocked ?? "",
            /jira create: PROJ has no issue type "Epic"; its types: Bug, Task, Sub-task$/,
        );
        assert.match(
            (await h.call({ ...BUG, project: "NOPE" })).blocked ?? "",
            /project NOPE was not found, or the account cannot see it$/,
        );
        const offScreen = await h.call({
            action: "create",
            project: "PROJ",
            type: "Task",
            summary: "t",
            fields: { labels: ["a"], components: ["Web"] },
        });
        assert.match(
            offScreen.blocked ?? "",
            /jira create: "labels" is not on the create screen of Task in PROJ; its fields: Summary, Description, Components$/,
        );
        assert.match(
            (await h.call({ ...BUG, fields: { project: "OTHER" } })).blocked ?? "",
            /jira create: project is set by project and type$/,
        );
        assert.match(
            (await h.call({ ...BUG, fields: { priority: "high", Priority: "low" } })).blocked ?? "",
            /jira create: priority is given twice$/,
        );
        assert.equal(writes(h).length, 0);
        assert.equal(h.jig.approved.size, 0);
    });

    test("a value the screen does not allow is refused with the allowed ones", async () => {
        assert.match(
            (await h.call({ ...BUG, fields: { priority: "Urgent" } })).blocked ?? "",
            /jira create: Priority: "Urgent" is not allowed; allowed: Highest, High, Medium, Low$/,
        );
        assert.match(
            (await h.call({ ...BUG, fields: { components: ["Web", "Legal"] } })).blocked ?? "",
            /jira create: Components: "Legal" is not allowed; allowed: Web, Billing$/,
        );
    });

    test("a required field that is missing is asked for, with what it takes", async () => {
        const result = await h.call({ action: "create", project: "PROJ", type: "Task", summary: "Write the guide" });
        assert.equal(
            result.blocked,
            "Blocked by jig-core: jira cannot run with this input: jira create: Task in PROJ also needs Components (one of Web, Billing); pass them in fields",
        );
        const sub = await h.call({ action: "create", project: "PROJ", type: "Sub-task", summary: "Part one" });
        assert.match(
            sub.blocked ?? "",
            /jira create: Sub-task in PROJ also needs Parent \(text\); pass them in fields$/,
        );
        const given = await h.call({
            action: "create",
            project: "PROJ",
            type: "Sub-task",
            summary: "Part one",
            fields: { parent: "proj-1" },
        });
        assert.equal(ok(given).split("\n")[0], "Created PROJ-100: Part one");
        assert.deepEqual((writes(h)[0]!.body as { fields: Record<string, unknown> }).fields.parent, { key: "PROJ-1" });
    });

    test("a person is looked up in the project, and shown by name", async () => {
        const result = await h.call({
            action: "create",
            project: "PROJ",
            type: "Bug",
            summary: "A bug",
            fields: { assignee: "Sam Lee" },
        });
        assert.match(
            result.preview?.body ?? "",
            /\nAssignee: Sam Lee \(712020:6c21d3a0-1111-4222-8333-944455556666\)\n/,
        );
        assert.equal(h.jira.sent("GET", "/user/assignable/search")[0]?.query.project, "PROJ");
        assert.deepEqual((writes(h)[0]!.body as { fields: Record<string, unknown> }).fields.assignee, {
            accountId: "712020:6c21d3a0-1111-4222-8333-944455556666",
        });
    });

    test("on Data Center the create screen lists its rows as values, and a person is a user name", async () => {
        const result = await datacenter.call({
            action: "create",
            project: "PROJ",
            type: "Bug",
            summary: "A bug",
            fields: { assignee: "slee", priority: "low" },
        });
        assert.equal(ok(result).split("\n")[0], "Created PROJ-100: A bug");
        assert.deepEqual(writes(datacenter)[0]?.body, {
            fields: {
                project: { key: "PROJ" },
                issuetype: { id: "10004" },
                summary: "A bug",
                assignee: { name: "slee" },
                priority: { id: "4" },
            },
        });
    });

    test("when the create screen cannot be read, the values are shown as given and Jira checks them", async () => {
        h.jira.createScreen = false;
        const result = await h.call({
            action: "create",
            project: "PROJ",
            type: "Bug",
            summary: "A bug",
            fields: { priority: "High", labels: ["x"] },
        });
        assert.match(
            result.preview?.body ?? "",
            /The create screen could not be read, so the values are shown as given and Jira checks them when it creates the issue\./,
        );
        assert.equal(ok(result).split("\n")[0], "Created PROJ-100: A bug");
        assert.deepEqual(writes(h)[0]?.body, {
            fields: {
                project: { key: "PROJ" },
                issuetype: { name: "Bug" },
                summary: "A bug",
                priority: { name: "High" },
                labels: ["x"],
            },
        });
        const unknown = await h.call({ action: "create", project: "NOPE", type: "Bug", summary: "A bug" });
        assert.match(
            unknown.blocked ?? "",
            /project NOPE was not found/,
            "a project that does not exist is still caught",
        );
    });

    test("Jira refusing the new issue is reported with its own words", async () => {
        h.jira.createScreen = false;
        h.jira.misbehave({ match: (request) => request.method === "POST", status: 400, apply: false, afterMs: 0 });
        const result = await h.call({ action: "create", project: "PROJ", type: "Bug", summary: "A bug" });
        assert.match(
            result.error?.message ?? "",
            /^jira create: Jira said 400 to POST \/issue: Service Unavailable\. Jira changed nothing\.$/,
        );
    });
});
