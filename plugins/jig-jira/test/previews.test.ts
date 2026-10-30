// What the person is shown before a write: the fingerprint that ties the preview to the write, the flags for text that points
// at this machine, the page for `o`, and that a call that cannot run is refused with a message and not asked about.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Preview } from "../../jig-core/src/contract.ts";
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

/** The tags jig-core removes from a page a tool brings (its preview-html.ts). Whatever is written here must survive that. */
const REMOVED = /<\/?(?:script|iframe|frame|frameset|object|embed|applet|meta|link|base|form|input|button|textarea|select|svg|math)\b[^>]*>/gi;

async function previewOf(input: Record<string, unknown>): Promise<Preview> {
    return h.declaration.preview?.(input, new AbortController().signal) as Promise<Preview>;
}

const CALLS: Array<Record<string, unknown>> = [
    { action: "comment", key: "PROJ-1", text: "Checked on *Safari 17*." },
    { action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "Verified twice." },
    { action: "delete_comment", key: "PROJ-1", commentId: "10002" },
    { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
    { action: "update", key: "PROJ-2", fields: { summary: "New title", labels: ["a"] } },
    { action: "create", project: "PROJ", type: "Bug", summary: "A bug", description: "Steps." },
];

describe("the fingerprint", () => {
    test("every write's preview has one, and it is a digest and not the text", async () => {
        for (const input of CALLS) {
            const preview = await previewOf(input);
            assert.match(preview.fingerprint ?? "", /^[0-9a-f]{32}$/, String(input.action));
            assert.ok(!JSON.stringify(input).includes(preview.fingerprint ?? "?"));
        }
    });

    test("the same call in the same state has the same fingerprint, and a different text has another", async () => {
        const first = await previewOf(CALLS[0] as Record<string, unknown>);
        const again = await previewOf(CALLS[0] as Record<string, unknown>);
        const other = await previewOf({ ...(CALLS[0] as Record<string, unknown>), text: "Checked on Safari 18." });
        assert.equal(first.fingerprint, again.fingerprint);
        assert.notEqual(first.fingerprint, other.fingerprint);
    });

    test("it covers what the person relied on, not only the request", async () => {
        const before = {
            transition: (await previewOf(CALLS[3] as Record<string, unknown>)).fingerprint,
            edit: (await previewOf(CALLS[1] as Record<string, unknown>)).fingerprint,
            update: (await previewOf(CALLS[4] as Record<string, unknown>)).fingerprint,
            comment: (await previewOf(CALLS[0] as Record<string, unknown>)).fingerprint,
        };
        issue("PROJ-1").fields.status = { name: "Open" };
        issue("PROJ-1").comments.find((comment) => comment.id === "10003")!.body = "Someone else edited this.";
        issue("PROJ-2").fields.summary = "Renamed by someone else";
        h.jira.me = h.jira.users[1] as typeof h.jira.me;
        assert.notEqual((await previewOf(CALLS[3] as Record<string, unknown>)).fingerprint, before.transition, "the status it moves from");
        assert.notEqual((await previewOf(CALLS[1] as Record<string, unknown>)).fingerprint, before.edit, "the text it replaces");
        assert.notEqual((await previewOf(CALLS[4] as Record<string, unknown>)).fingerprint, before.update, "the values it changes");
        assert.notEqual((await previewOf(CALLS[0] as Record<string, unknown>)).fingerprint, before.comment, "who posts");
    });

    test("what only informs does not change it: the duplicates of a new issue, and the title of the issue", async () => {
        const create = CALLS[5] as Record<string, unknown>;
        const first = (await previewOf(create)).fingerprint;
        h.jira.duplicates = ["PROJ-2"];
        assert.equal((await previewOf(create)).fingerprint, first);
        const comment = (await previewOf(CALLS[0] as Record<string, unknown>)).fingerprint;
        issue("PROJ-1").fields.summary = "A new title";
        assert.equal((await previewOf(CALLS[0] as Record<string, unknown>)).fingerprint, comment);
    });

    test("a read's preview is one line and has no fingerprint", async () => {
        assert.deepEqual(await previewOf({ action: "get", key: "PROJ-1" }), { summary: "jira get PROJ-1" });
        assert.deepEqual(await previewOf({ action: "search", jql: "project = PROJ" }), { summary: "jira search" });
        assert.deepEqual(await previewOf({ action: "find_field", query: "story" }), { summary: "jira find_field" });
    });
});

describe("flags for text that points at things readers cannot open", () => {
    const POINTS = "The export is in /home/alice/work/export.csv and the query in ./queries/export.sql.";

    test("a comment is flagged at the top of the body, in the summary and on the page, and still goes", async () => {
        const result = await h.call({ action: "comment", key: "PROJ-1", text: POINTS });
        assert.match(result.preview?.summary ?? "", /\[2 pointers flagged\]$/);
        assert.equal((result.preview?.body ?? "").split("\n").slice(0, 4).join("\n"), [
            "WARNING: the text points at things its readers may not be able to open:",
            "  - local path: /home/alice/work/export.csv",
            "  - relative path: ./queries/export.sql",
            "Rewrite the text, or approve it if this is intended.",
        ].join("\n"));
        assert.match(
            result.preview?.html ?? "",
            /<div class="flags"><p>WARNING: the text points at things its readers may not be able to open:<\/p><ul><li>local path: \/home\/alice\/work\/export\.csv<\/li><li>relative path: \.\/queries\/export\.sql<\/li><\/ul><\/div>/,
        );
        assert.equal(result.error, undefined, "a flag does not block");
        assert.equal(issue("PROJ-1").comments.at(-1)?.body, POINTS, "the text went as written");
        assert.equal(
            result.text,
            "Added comment 10100 to PROJ-1.\nNote: the text pointed at things its readers may not be able to open " +
                "(local path: /home/alice/work/export.csv; relative path: ./queries/export.sql).",
        );
    });

    test("every write that carries text is checked: edit, update (title, description, labels, other fields) and create", async () => {
        h.configure({ site: "https://jira.example.test", auth: { token: "pass:jira/token" }, updateFields: ["summary", "description", "labels", "customfield_10600"] });
        const flagged = async (input: Record<string, unknown>) => (await h.call(input)).preview?.summary ?? "";
        assert.match(await flagged({ action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "see ~/notes.md" }), /\[1 pointer flagged\]$/);
        assert.match(await flagged({ action: "update", key: "PROJ-2", fields: { summary: "Fix in /Users/bob/dev" } }), /\[1 pointer flagged\]$/);
        assert.match(await flagged({ action: "update", key: "PROJ-2", fields: { description: "file:///etc/hosts" } }), /\[1 pointer flagged\]$/);
        assert.match(await flagged({ action: "update", key: "PROJ-2", fields: { labels: ["ok", "C:\\work"] } }), /\[1 pointer flagged\]$/);
        assert.match(await flagged({ action: "update", key: "PROJ-2", fields: { customfield_10600: "see /tmp/x.log" } }), /\[1 pointer flagged\]$/);
        assert.match(await flagged({ action: "create", project: "PROJ", type: "Bug", summary: "A bug", description: "in /home/a/b", fields: { labels: ["~/x"] } }), /\[2 pointers flagged\]$/);
    });

    test("the names in privateNames are flagged, without regard to case", async () => {
        h.configure({ site: "https://jira.example.test", auth: { token: "pass:jira/token" }, privateNames: ["payroll", "corp.example.net"] });
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "Ask Payroll, or look at CORP.example.NET." });
        assert.match(result.preview?.body ?? "", /\n {2}- private name: payroll\n {2}- private name: corp\.example\.net\n/);
        assert.match(result.preview?.summary ?? "", /\[2 pointers flagged\]$/);
    });

    test("clean text, a transition, a deletion and a web address are not flagged", async () => {
        for (const input of [
            { action: "comment", key: "PROJ-1", text: "See https://docs.example.test/home/page and /tmp is not here." },
            { action: "transition", key: "PROJ-1", transition: "Resolve Issue" },
            { action: "delete_comment", key: "PROJ-1", commentId: "10001" },
        ]) {
            const result = await h.call(input);
            assert.doesNotMatch(result.preview?.summary ?? "", /flagged/);
            assert.doesNotMatch(result.preview?.body ?? "", /WARNING/);
            assert.doesNotMatch(result.text, /Note:/);
            h.reset();
        }
    });

    test("a comment already on the issue is not checked when it is deleted", async () => {
        issue("PROJ-1").comments[0]!.body = "Old note: /home/alice/x.md";
        const result = await h.call({ action: "delete_comment", key: "PROJ-1", commentId: "10001" });
        assert.doesNotMatch(result.preview?.summary ?? "", /flagged/);
    });
});

describe("the page for o", () => {
    test("is markup for jig-core's page: no document of its own, and nothing jig-core would remove", async () => {
        for (const input of [CALLS[0], CALLS[1], CALLS[2], CALLS[5], { action: "update", key: "PROJ-2", fields: { description: "h3. Hi", summary: "x" } }]) {
            const html = (await previewOf(input as Record<string, unknown>)).html ?? "";
            assert.ok(html.startsWith('<div class="jira-preview"><style>'), String(input?.action));
            assert.doesNotMatch(html, /<!doctype|<html|<head|<body|<title|<meta|<h1>/i, "jig-core supplies the document, the title and the policy");
            assert.equal(html.replace(REMOVED, ""), html, `${String(input?.action)}: nothing in it is a tag that jig-core removes`);
            assert.doesNotMatch(html, /<script|\son[a-z]+=|javascript:|url\(/i);
        }
    });

    test("a write with no text has no page of its own", async () => {
        assert.equal((await previewOf(CALLS[3] as Record<string, unknown>)).html, undefined);
        assert.equal((await previewOf(CALLS[4] as Record<string, unknown>)).html, undefined);
    });

    test("shows the text as Jira will, and what it replaces", async () => {
        const html = (await previewOf({ action: "edit_comment", key: "PROJ-1", commentId: "10003", text: "h3. Result\n* *fixed* in {{1.2.3}}\n||a||b||\n|1|2|" })).html ?? "";
        assert.ok(html.includes(
            '<h2>New text, as Jira will show it</h2><div class="wiki"><h3>Result</h3>\n' +
                "<ul><li><strong>fixed</strong> in <code>1.2.3</code></li></ul>\n" +
                "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></div>",
        ));
        assert.match(html, /<details><summary>It replaces this text<\/summary><div class="wiki"><p>Verified on staging\.<\/p><\/div><\/details>/);
    });

    test("a create shows its fields as a table, the duplicates, and the description", async () => {
        h.jira.duplicates = ["PROJ-2"];
        const html = (await previewOf({ action: "create", project: "PROJ", type: "Bug", summary: "A <b>bug</b>", description: "Steps & more" })).html ?? "";
        assert.ok(html.includes(
            '<table class="facts"><tr><th>Project</th><td>PROJ</td></tr><tr><th>Type</th><td>Bug</td></tr>' +
                "<tr><th>Summary</th><td>A &lt;b&gt;bug&lt;/b&gt;</td></tr></table>",
        ));
        assert.match(html, /<p>Possible duplicates, created in PROJ in the last 30 days:<\/p><p> {2}PROJ-2 \[Open\] Update the onboarding guide<\/p>/);
        assert.match(html, /<h2>Description, as Jira will show it<\/h2><div class="wiki"><p>Steps &amp; more<\/p><\/div>/);
    });

    test("markup in the text, in a title or in a field value reaches the page only as escaped text", async () => {
        const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
        issue("PROJ-2").fields.summary = evil;
        const comment = (await previewOf({ action: "comment", key: "PROJ-2", text: evil })).html ?? "";
        const update = (await previewOf({ action: "update", key: "PROJ-2", fields: { summary: evil, description: evil } })).html ?? "";
        for (const html of [comment, update]) {
            assert.doesNotMatch(html, /<script>|<img/);
            assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
        }
        assert.equal((await previewOf({ action: "comment", key: "PROJ-2", text: "x" })).summary.includes("<script>"), true, "the one-line summary is plain text, which jig-core escapes itself");
    });
});

describe("a call that cannot run", () => {
    test("is a TypeError from the preview, so jig-core blocks it with the message and nobody is asked", async () => {
        const invalid: Array<Record<string, unknown>> = [
            {}, { action: "comment" }, { action: "comment", key: "nope", text: "x" }, { action: "comment", key: "PROJ-1", text: "" },
            { action: "comment", key: "PROJ-1", text: "x".repeat(32768) }, { action: "comment", key: "PROJ-99", text: "x" },
            { action: "transition", key: "PROJ-1", transition: "Nowhere" }, { action: "update", key: "PROJ-1", fields: { reporter: "x" } },
            { action: "create", project: "PROJ", type: "Epic", summary: "x" }, { action: "create", project: "PROJ", type: "Task", summary: "x" },
        ];
        for (const input of invalid) {
            await assert.rejects(previewOf(input), (error: unknown) => {
                assert.ok(error instanceof TypeError, JSON.stringify(input));
                assert.ok(error.message.length > 0 && error.message.length <= 200, error.message);
                return true;
            });
            const result = await h.call(input);
            assert.match(result.blocked ?? "", /^Blocked by jig-core: jira cannot run with this input: /, JSON.stringify(input));
            assert.equal(result.text, "");
            assert.equal(result.error, undefined, "the tool never ran");
        }
        assert.equal(h.jig.approved.size, 0, "nobody was asked about any of them");
        assert.equal(h.jira.requests.filter((request) => request.method !== "GET").length, 0);
    });

    test("an unconfigured tool is blocked too, since nothing can work", async () => {
        h.jig.reset();
        const result = await h.call({ action: "comment", key: "PROJ-1", text: "x" });
        assert.match(result.blocked ?? "", /jira cannot run with this input: jira is not set up: add a "jira" section with "site" and "auth" to jig\.json/);
    });

    test("a failure that is not about the input is not a TypeError: the person sees 'preview unavailable' and decides", async () => {
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1", drop: true, afterMs: 0 });
        await assert.rejects(previewOf(CALLS[0] as Record<string, unknown>), (error: unknown) => {
            assert.ok(error instanceof Error && !(error instanceof TypeError));
            assert.match(error.message, /^no answer from Jira \(/);
            return true;
        });
        h.jira.misbehave({ match: (request) => request.path === "/issue/PROJ-1", status: 401, apply: false, afterMs: 0 });
        const result = await h.call(CALLS[0] as Record<string, unknown>);
        assert.match(result.preview?.summary ?? "", /^preview unavailable: Jira said 401 to GET \/issue\/PROJ-1/);
        assert.equal(result.blocked, undefined);
    });

    test("a TypeError from a bug in the plugin is not taken for the person's input", async () => {
        const section = h.jig.api.config.section;
        h.jig.api.config.section = () => {
            throw new TypeError("Cannot read properties of undefined (reading 'site')");
        };
        try {
            await assert.rejects(previewOf(CALLS[0] as Record<string, unknown>), (error: unknown) => {
                assert.ok(error instanceof Error && !(error instanceof TypeError));
                assert.equal(error.message, "internal error: Cannot read properties of undefined (reading 'site')");
                return true;
            });
        } finally {
            h.jig.api.config.section = section;
        }
    });

    test("with a good call the preview is the same whether or not it is asked for twice", async () => {
        const first = await previewOf(CALLS[4] as Record<string, unknown>);
        const second = await previewOf(CALLS[4] as Record<string, unknown>);
        assert.deepEqual(first, second);
        ok(await h.call(CALLS[4] as Record<string, unknown>));
    });
});
