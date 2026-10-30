// The eight read actions, against a fake Jira on this machine: what each asks for, and the compact text it gives back.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FakeComment, FakeIssue } from "./support/fake-jira.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

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

/** Gives an issue `count` more comments, numbered after the ones it has. */
function addComments(harness: Harness, key: string, count: number, body = (n: number) => `Comment number ${n}.`): void {
    const target = issue(harness, key);
    const author = harness.jira.users[1] as FakeComment["author"];
    for (let n = 0; n < count; n++) {
        const id = String(20000 + target.comments.length);
        const created = `2026-10-${String(10 + (n % 18)).padStart(2, "0")}T10:00:00.000+0000`;
        target.comments.push({ id, author, body: body(target.comments.length + 1), created, updated: created });
    }
}

describe("get", () => {
    test("an issue with its fields, description and comments, in compact text", async () => {
        const text = ok(await h.call({ action: "get", key: "PROJ-1" }));
        const lines = text.split("\n");
        assert.deepEqual(lines.slice(0, 11), [
            "PROJ-1 | Bug | In Progress | High",
            "Fix login crash on Safari",
            "Assignee: Jane Doe | Reporter: Sam Lee",
            "Created: 2026-10-01 | Updated: 2026-10-12",
            "Labels: login, safari | Components: Web",
            "Parent: PROJ-10 (In Progress) Safari support",
            "Links:",
            "- blocks PROJ-3 (Open) Release 1.2",
            "Subtasks:",
            "- PROJ-4 (Open) Add a regression test",
            "Description:",
        ]);
        assert.match(text, /h3\. Steps\n# Open the login page in Safari 17/);
        assert.match(text, /Comments \(3\):\n#10001 Sam Lee, 2026-10-02\n {2}Reproduced on Safari 17\.\n\n {2}Steps are in the description\./);
        assert.match(text, /#10003 Sam Lee, 2026-10-05 \(edited\)\n {2}Verified on staging\./);
        assert.deepEqual(h.jira.requests.map((request) => `${request.method} ${request.path}`), ["GET /issue/PROJ-1"]);
        assert.equal(
            h.jira.requests[0]?.query.fields,
            "summary,issuetype,status,priority,resolution,assignee,reporter,labels,components,fixVersions," +
                "created,updated,description,parent,issuelinks,subtasks,comment",
        );
    });

    test("an issue with nothing to list says so briefly", async () => {
        assert.equal(ok(await h.call({ action: "get", key: "PROJ-2" })), [
            "PROJ-2 | Task | Open | Medium",
            "Update the onboarding guide",
            "Assignee: unassigned | Reporter: Jane Doe",
            "Created: 2026-10-08 | Updated: 2026-10-08",
            "Description:",
            "Add the new VPN steps.",
            "Comments: none",
        ].join("\n"));
    });

    test("the latest five comments, and how many there are", async () => {
        addComments(h, "PROJ-1", 6);
        const text = ok(await h.call({ action: "get", key: "PROJ-1" }));
        assert.match(text, /Comments \(last 5 of 9\):/);
        assert.deepEqual([...text.matchAll(/^#(\d+) /gm)].map((match) => match[1]), ["20004", "20005", "20006", "20007", "20008"]);
    });

    test("a long thread that Jira sends only in part is asked for again, newest last", async () => {
        addComments(h, "PROJ-1", 6);
        h.jira.inlineComments = 2;
        const text = ok(await h.call({ action: "get", key: "PROJ-1" }));
        assert.match(text, /Comments \(last 5 of 9\):/);
        assert.deepEqual([...text.matchAll(/^#(\d+) /gm)].map((match) => match[1]), ["20004", "20005", "20006", "20007", "20008"]);
        const tail = h.jira.sent("GET", "/issue/PROJ-1/comment");
        assert.equal(tail.length, 1);
        assert.deepEqual(tail[0]?.query, { startAt: "4", maxResults: "5" });
    });

    test("a description is cut at 4,000 characters, a comment at 1,500, and full lifts both", async () => {
        issue(h, "PROJ-2").fields.description = `${"d".repeat(3999)}EDGE${"e".repeat(2000)}`;
        addComments(h, "PROJ-2", 1, () => `${"c".repeat(1499)}EDGE${"f".repeat(500)}`);
        const capped = ok(await h.call({ action: "get", key: "PROJ-2" }));
        assert.match(capped, /d{3999}E\n\[\.\.\. 2003 more characters; call again with full=true for all of it\]/);
        assert.match(capped, /c{1499}E\n {2}\[\.\.\. 503 more characters; call again with full=true/);
        const full = ok(await h.call({ action: "get", key: "PROJ-2", full: true }));
        assert.match(full, /d{3999}EDGEe{2000}/);
        assert.doesNotMatch(full, /more characters/);
        assert.ok(full.length > capped.length + 2000);
    });

    test("include shows more fields, by friendly name, by id and by the name Jira shows", async () => {
        h.configure({ site: "https://jira.example.test", auth: { token: "pass:jira/token" }, fields: { Points: "customfield_10016" } });
        const text = ok(await h.call({ action: "get", key: "PROJ-1", include: ["points", "customfield_10500", "Acceptance Criteria", "Labels"] }));
        assert.match(text, /\npoints: 5\n/);
        assert.match(text, /\nPull Request Link \(customfield_10500\): https:\/\/git\.example\.test\/org\/app\/pull\/42\n/);
        assert.match(text, /\nAcceptance Criteria \(customfield_10600\): \(empty\)\nLabels: login, safari\n/);
        assert.match(h.jira.requests[0]?.path ?? "", /^\/field$/);
        assert.match(h.jira.requests[1]?.query.fields ?? "", /,comment,customfield_10016,customfield_10500,customfield_10600,labels$/);
    });

    test("a field name Jira does not have is refused with the closest names", async () => {
        const result = await h.call({ action: "get", key: "PROJ-1", include: ["Pull Reqest Link"] });
        assert.match(result.error?.message ?? "", /^jira: no field is named "Pull Reqest Link"\. Did you mean Pull Request Link \(customfield_10500\)\?$/);
        assert.equal(h.jira.sent("GET", "/issue/PROJ-1").length, 0, "nothing was asked of the issue");
    });

    test("an issue that does not exist is the answer Jira gave, without a token", async () => {
        const result = await h.call({ action: "get", key: "PROJ-99" });
        assert.equal(result.error?.message, "Jira said 404 to GET /issue/PROJ-99: Issue does not exist or you do not have permission to see it. - not found, or the account cannot see it");
    });
});

describe("search", () => {
    test("Jira Cloud pages by token: the first page, and the page value to ask for the next", async () => {
        const first = ok(await h.call({ action: "search", jql: "project = PROJ ORDER BY updated DESC", limit: 1 }));
        assert.equal(first, [
            "1 issue (more follow) for: project = PROJ ORDER BY updated DESC",
            "PROJ-1 | In Progress | Bug | High | Jane Doe | 2026-10-12 | Fix login crash on Safari",
            'More: repeat with page="1"',
        ].join("\n"));
        const second = ok(await h.call({ action: "search", jql: "project = PROJ ORDER BY updated DESC", limit: 1, page: "1" }));
        assert.equal(second, [
            "1 issue for: project = PROJ ORDER BY updated DESC",
            "PROJ-2 | Open | Task | Medium | unassigned | 2026-10-08 | Update the onboarding guide",
        ].join("\n"));
        assert.deepEqual(h.jira.requests.map((request) => request.path), ["/search/jql", "/search/jql"]);
        assert.deepEqual(h.jira.requests[1]?.query, {
            jql: "project = PROJ ORDER BY updated DESC", fields: "summary,status,issuetype,priority,assignee,updated", maxResults: "1", nextPageToken: "1",
        });
    });

    test("Data Center pages by offset, and the tool remembers which kind of search the Jira has", async () => {
        const first = ok(await datacenter.call({ action: "search", jql: "project = PROJ", limit: 1 }));
        assert.match(first, /^1-1 of 2 for: project = PROJ\nPROJ-1 \| /);
        assert.match(first, /\nMore: repeat with page="1"$/);
        assert.deepEqual(datacenter.jira.requests.map((request) => request.path), ["/search/jql", "/search"], "the first search tries the token endpoint, then the offset one");
        const second = ok(await datacenter.call({ action: "search", jql: "project = PROJ", limit: 1, page: "1" }));
        assert.match(second, /^2-2 of 2 for: project = PROJ\nPROJ-2 \| /);
        assert.doesNotMatch(second, /More:/);
        assert.deepEqual(datacenter.jira.requests.map((request) => request.path), ["/search/jql", "/search", "/search"], "the second search goes straight to the offset one");
        assert.equal(datacenter.jira.requests[2]?.query.startAt, "1");
    });

    test("a page value that Data Center cannot use is refused", async () => {
        const result = await datacenter.call({ action: "search", jql: "project = PROJ", page: "abc" });
        assert.match(result.error?.message ?? result.blocked ?? "", /page must be the page value the previous result gave/);
    });

    test("no match says so, and extra fields are shown under each issue", async () => {
        h.jira.issues.clear();
        assert.equal(ok(await h.call({ action: "search", jql: "project = NONE" })), "No issues for: project = NONE");
        h.reset();
        const text = ok(await h.call({ action: "search", jql: "project = PROJ", include: ["customfield_10016"] }));
        assert.match(text, /PROJ-1 \| .*\n {4}Story Points \(customfield_10016\): 5\nPROJ-2 \| .*\n {4}Story Points \(customfield_10016\): \(empty\)/);
    });

    test("a field Jira does not know in the query gets the closest names", async () => {
        h.jira.unknownFields = ["PR Link"];
        const result = await h.call({ action: "search", jql: 'project = PROJ AND "PR Link" is not EMPTY' });
        assert.equal(
            result.error?.message,
            "Jira said 400 to GET /search/jql: Field 'PR Link' does not exist or you do not have permission to view it. Did you mean Pull Request Link (customfield_10500)?",
        );
    });

    test("an error that is not about a field is not changed", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/search/jql", status: 400, apply: false, afterMs: 0 });
        const result = await h.call({ action: "search", jql: "project = PROJ" });
        assert.equal(result.error?.message, "Jira said 400 to GET /search/jql: Service Unavailable");
    });
});

describe("comments", () => {
    test("the newest comments, newest last", async () => {
        const text = ok(await h.call({ action: "comments", key: "PROJ-1" }));
        assert.match(text, /^PROJ-1: 3 comments, newest last\n#10001 Sam Lee, 2026-10-02\n/);
        assert.match(text, /#10002 Jane Doe, 2026-10-03\n {2}Fix is in \[PR 42\|https:\/\/git\.example\.test\/org\/app\/pull\/42\]\.\n#10003 /);
        assert.equal(ok(await h.call({ action: "comments", key: "PROJ-2" })), "No comments on PROJ-2.");
    });

    test("a long thread gives the newest, and says how many there are", async () => {
        addComments(h, "PROJ-1", 20);
        h.jira.requests.length = 0;
        const text = ok(await h.call({ action: "comments", key: "PROJ-1", limit: 4 }));
        assert.match(text, /^PROJ-1: newest 4 of 23 comments, newest last\n/);
        assert.deepEqual([...text.matchAll(/^#(\d+) /gm)].map((match) => match[1]), ["20019", "20020", "20021", "20022"]);
        assert.deepEqual(h.jira.requests.map((request) => request.query.startAt), ["0", "19"], "the first page shows the total; then the newest page");
    });

    test("each comment is cut at 1,500 characters unless full is asked for", async () => {
        addComments(h, "PROJ-2", 1, () => "z".repeat(1700));
        assert.match(ok(await h.call({ action: "comments", key: "PROJ-2" })), /z{1500}\n {2}\[\.\.\. 200 more characters; call again with full=true for all of it\]/);
        assert.doesNotMatch(ok(await h.call({ action: "comments", key: "PROJ-2", full: true })), /more characters/);
    });
});

describe("transitions, changelog, attachments", () => {
    test("transitions lists each name with the status it leads to and its id", async () => {
        assert.equal(ok(await h.call({ action: "transitions", key: "PROJ-1" })), [
            "PROJ-1 transitions (name -> status [id]):",
            "- Start Progress -> In Progress [21]",
            "- Resolve Issue -> Done [31]",
            "- Back to Open -> Open [41]",
        ].join("\n"));
        issue(h, "PROJ-2").transitions = [];
        assert.equal(ok(await h.call({ action: "transitions", key: "PROJ-2" })), "PROJ-2 has no transitions available to this account.");
    });

    test("changelog gives status and field changes, oldest first, limited to the newest", async () => {
        assert.equal(ok(await h.call({ action: "changelog", key: "PROJ-1" })), [
            "PROJ-1 history (2 changes, newest last):",
            "2026-10-03 09:00 Jane Doe: status Open -> In Progress",
            "2026-10-04 12:30 Sam Lee: priority Medium -> High; labels (none) -> safari",
        ].join("\n"));
        assert.match(ok(await h.call({ action: "changelog", key: "PROJ-1", limit: 1 })), /^PROJ-1 history \(newest 1 of 2 changes, newest last\):\n2026-10-04 12:30 Sam Lee/);
        assert.equal(ok(await h.call({ action: "changelog", key: "PROJ-2" })), "PROJ-2: no changes recorded.");
        assert.equal(h.jira.requests[0]?.query.expand, "changelog");
    });

    test("attachments are listed, never downloaded", async () => {
        assert.equal(ok(await h.call({ action: "attachments", key: "PROJ-1" })), [
            "PROJ-1 attachments (id | name | size | type | date | author; files are not downloaded):",
            "20001 | crash.log | 2.0 KB | text/plain | 2026-10-02 | Sam Lee",
        ].join("\n"));
        assert.equal(ok(await h.call({ action: "attachments", key: "PROJ-2" })), "PROJ-2 has no attachments.");
        assert.ok(h.jira.requests.every((request) => request.method === "GET" && !request.path.includes("attachment")), "only the issue was read");
    });
});

describe("assignable and find_field", () => {
    test("assignable gives the id to use: an account id on Cloud, a user name on Data Center", async () => {
        assert.equal(ok(await h.call({ action: "assignable", key: "PROJ-1" })), [
            "Assignable users for PROJ-1 (id | name):",
            "5b10a2844c20165700ede21g | Jane Doe",
            "712020:6c21d3a0-1111-4222-8333-944455556666 | Sam Lee",
        ].join("\n"));
        assert.equal(ok(await datacenter.call({ action: "assignable", key: "PROJ-1", query: "sam" })), "Assignable users for PROJ-1 (id | name):\nslee | Sam Lee");
        assert.deepEqual(datacenter.jira.requests[0]?.query, { issueKey: "PROJ-1", query: "sam", username: "sam", maxResults: "20" }, "both spellings of the query are sent");
    });

    test("no one matching, and an inactive person", async () => {
        assert.equal(ok(await h.call({ action: "assignable", key: "PROJ-1", query: "nobody" })), "No assignable users match for PROJ-1.");
        (h.jira.users[1] as { active: boolean }).active = false;
        assert.match(ok(await h.call({ action: "assignable", key: "PROJ-1", query: "sam" })), /\| Sam Lee \| inactive$/);
    });

    test("find_field matches a name or an id, and also the friendly names set in the configuration", async () => {
        assert.equal(ok(await h.call({ action: "find_field", query: "pull" })), 'Fields matching "pull" (id  name):\ncustomfield_10500  Pull Request Link (custom)');
        assert.match(ok(await h.call({ action: "find_field", query: "CUSTOMFIELD_10016" })), /customfield_10016 {2}Story Points \(custom\)/);
        h.configure({ site: "https://jira.example.test", auth: { token: "pass:jira/token" }, fields: { "Story Points": "customfield_10016" } });
        assert.equal(
            ok(await h.call({ action: "find_field", query: "story" })),
            'Fields matching "story" (id  name):\ncustomfield_10016  Story Points (custom)\n' +
                "Story Points -> customfield_10016 (a name set in the jira section)",
        );
        assert.equal(ok(await h.call({ action: "find_field", query: "zzz" })), 'No field name or id contains "zzz". Try a shorter part of the name.');
    });

    test("the field list is read once per session", async () => {
        ok(await h.call({ action: "find_field", query: "story" }));
        ok(await h.call({ action: "find_field", query: "pull" }));
        assert.equal(h.jira.sent("GET", "/field").length, 1);
    });

    test("a failed read of the field list is not remembered", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/field", status: 500, apply: false, afterMs: 0 });
        assert.ok((await h.call({ action: "find_field", query: "story" })).error);
        assert.match(ok(await h.call({ action: "find_field", query: "story" })), /Story Points/);
    });
});

describe("reads in general", () => {
    test("no read changes anything, asks, or builds a preview", async () => {
        h.jira.duplicates = ["PROJ-2"];
        for (const input of [
            { action: "get", key: "PROJ-1" }, { action: "search", jql: "project = PROJ" }, { action: "comments", key: "PROJ-1" },
            { action: "transitions", key: "PROJ-1" }, { action: "changelog", key: "PROJ-1" }, { action: "attachments", key: "PROJ-1" },
            { action: "assignable", key: "PROJ-1" }, { action: "find_field", query: "story" },
        ]) {
            const result = await h.call(input);
            assert.equal(result.error, undefined, JSON.stringify(input));
            assert.equal(result.preview, undefined, "a read does not ask");
            assert.equal(result.cls?.effect, "read");
        }
        assert.ok(h.jira.requests.every((request) => request.method === "GET"));
        assert.equal(h.jig.facts.size, 0, "reads add no facts");
    });

    test("a read with the wrong parameters says how to call it", async () => {
        const result = await h.call({ action: "get" });
        assert.equal(result.error?.message, "jira get needs key. Usage: jira get {key, include?, full?}");
        assert.equal(h.jira.requests.length, 0);
    });

    test("without a configuration the tool says what to set, and does not try", async () => {
        h.jig.reset();
        const result = await h.call({ action: "get", key: "PROJ-1" });
        assert.match(result.error?.message ?? "", /^jira is not set up: add a "jira" section with "site" and "auth" to jig\.json/);
        assert.equal(h.jira.requests.length, 0);
    });
});
