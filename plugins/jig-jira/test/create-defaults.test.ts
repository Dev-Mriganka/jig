// createDefaults: a map of field name to value that `create` applies when the call does not set that field. A default is
// resolved by name the way a field in `fields` is, is shown in the preview as "from your defaults", and goes into the
// request, so it is part of what the person approves.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Recorded } from "./support/fake-jira.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness("cloud");
});
after(() => h.close());
beforeEach(() => h.reset());

const configure = (createDefaults: Record<string, unknown>): void =>
    h.configure({
        site: "https://jira.example.test",
        auth: { token: "pass:jira/token" },
        fields: { "Story Points": "customfield_10016" },
        createDefaults,
    });
const sent = (): Recorded[] =>
    h.jira.requests.filter((request) => request.method === "POST" && request.path === "/issue");
const fieldsSent = (): Record<string, unknown> =>
    (sent()[0]?.body as { fields: Record<string, unknown> } | undefined)?.fields ?? {};
const BUG = { action: "create", project: "PROJ", type: "Bug", summary: "A bug" };
const TASK = { action: "create", project: "PROJ", type: "Task", summary: "A task" };

describe("a default fills the fields the call left alone", () => {
    test("each is shown as from your defaults, and sent", async () => {
        configure({ Priority: "medium", "Story Points": 2, labels: ["triage"] });
        const result = await h.call(BUG);
        assert.match(ok(result), /^Created PROJ-100: A bug/);
        assert.equal(
            result.preview?.body,
            [
                "Project: PROJ",
                "Type: Bug",
                "Summary: A bug",
                "Priority: Medium (from your defaults)",
                "Story Points: 2 (from your defaults)",
                "Labels: triage (from your defaults)",
                "",
                "Possible duplicates: none among the issues created in PROJ in the last 30 days.",
            ].join("\n"),
        );
        assert.deepEqual(fieldsSent(), {
            project: { key: "PROJ" },
            issuetype: { id: "10004" },
            summary: "A bug",
            priority: { id: "3" },
            customfield_10016: 2,
            labels: ["triage"],
        });
    });

    test("a field the call sets is not defaulted, and carries no mark", async () => {
        configure({ Priority: "Medium", labels: ["triage"] });
        const result = await h.call({ ...BUG, fields: { priority: "low", labels: null } });
        ok(result);
        assert.match(result.preview?.body ?? "", /^Priority: Low$/m);
        assert.match(result.preview?.body ?? "", /^Labels: \(none\)$/m);
        assert.doesNotMatch(result.preview?.body ?? "", /from your defaults/);
        assert.deepEqual(fieldsSent().priority, { id: "4" });
        assert.deepEqual(fieldsSent().labels, []);
    });

    test("names are resolved as in fields: built-in, friendly, the screen's own name, or an id", async () => {
        configure({ priority: "High", "story points": 5, Components: ["Web"], customfield_10500: "x" });
        const result = await h.call(BUG);
        // customfield_10500 is not on the screen of a Bug, so it is left out and said so.
        assert.match(result.preview?.body ?? "", /^Priority: High \(from your defaults\)$/m);
        assert.match(result.preview?.body ?? "", /^Story Points: 5 \(from your defaults\)$/m);
        assert.match(result.preview?.body ?? "", /^Components: Web \(from your defaults\)$/m);
        assert.match(
            result.preview?.body ?? "",
            /^Defaults not applied: "customfield_10500" is not on the create screen of Bug in PROJ\.$/m,
        );
        ok(result);
        assert.deepEqual(fieldsSent().components, [{ id: "10000" }]);
        assert.equal(fieldsSent().customfield_10500, undefined);
    });

    test("the description is shown as text, and the call's own description wins", async () => {
        configure({ description: "h3. Steps\n# Reproduce" });
        const defaulted = await h.call(BUG);
        ok(defaulted);
        assert.match(
            defaulted.preview?.body ?? "",
            /Description \(from your defaults\) \(Jira wiki markup\):\nh3\. Steps/,
        );
        assert.equal(fieldsSent().description, "h3. Steps\n# Reproduce");
        h.reset();
        configure({ description: "h3. Steps\n# Reproduce" });
        const own = await h.call({ ...BUG, description: "Mine" });
        ok(own);
        assert.doesNotMatch(own.preview?.body ?? "", /from your defaults/);
        assert.equal(fieldsSent().description, "Mine");
    });

    test("a person is looked up like any assignee, and shown by name", async () => {
        configure({ assignee: "Sam Lee" });
        const result = await h.call(BUG);
        ok(result);
        assert.match(
            result.preview?.body ?? "",
            /^Assignee: Sam Lee \(712020:6c21d3a0-1111-4222-8333-944455556666\) \(from your defaults\)$/m,
        );
        assert.deepEqual(fieldsSent().assignee, { accountId: "712020:6c21d3a0-1111-4222-8333-944455556666" });
    });
});

describe("a default counts for what the screen requires", () => {
    test("a required field is met by a default, and is missing without one", async () => {
        const missing = await h.call(TASK);
        assert.match(
            missing.blocked ?? "",
            /Task in PROJ also needs Components \(one of Web, Billing\); pass them in fields/,
        );
        configure({ Components: ["Billing"] });
        const result = await h.call(TASK);
        ok(result);
        assert.deepEqual(fieldsSent().components, [{ id: "10001" }]);
    });

    test("a default for a field that is not on this screen is left out and said so", async () => {
        configure({ Priority: "High", Components: ["Web"], "Story Points": 3 });
        const result = await h.call(TASK);
        ok(result);
        assert.match(
            result.preview?.body ?? "",
            /^Defaults not applied: "Priority", "Story Points" are not on the create screen of Task in PROJ\.$/m,
        );
        assert.equal(fieldsSent().priority, undefined);
        assert.equal(fieldsSent().customfield_10016, undefined);
        assert.deepEqual(fieldsSent().components, [{ id: "10000" }]);
    });
});

describe("a default that cannot be used", () => {
    test("a value the screen does not allow says where it came from and how to override it", async () => {
        configure({ Priority: "Urgent" });
        const result = await h.call(BUG);
        assert.equal(
            result.blocked,
            'Blocked by jig-core: jira cannot run with this input: jira create: Priority: "Urgent" is not allowed; allowed: Highest, High, Medium, Low (the value of "Priority" in createDefaults in jig.json; set that field in the call to use another)',
        );
        assert.equal(sent().length, 0);
        // Setting the field in the call is the way out.
        const own = await h.call({ ...BUG, fields: { priority: "Low" } });
        ok(own);
    });

    test("two names for one field are refused", async () => {
        configure({ "Story Points": 1, customfield_10016: 2 });
        const result = await h.call(BUG);
        assert.match(
            result.blocked ?? "",
            /jira create: createDefaults names customfield_10016 twice, as "customfield_10016" and another$/,
        );
        assert.equal(sent().length, 0);
    });
});

describe("a default is part of what is approved", () => {
    test("changing the defaults while the person reads voids the approval", async () => {
        configure({ Priority: "Medium" });
        const result = await h.call(BUG, { between: () => configure({ Priority: "Low" }) });
        assert.match(result.error?.message ?? "", /changed since the preview/);
        assert.equal(sent().length, 0);
    });

    test("without defaults a create is as it was", async () => {
        const result = await h.call(BUG);
        ok(result);
        assert.doesNotMatch(result.preview?.body ?? "", /from your defaults|Defaults not applied/);
    });
});
