// How jig-core classifies a call to the tool, and that the README and docs/parameters.md, which are the specification, say the same.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { classifyCall } from "../src/classify.ts";
import { readJira, validateJira } from "../src/config.ts";
import { ACTION_NAMES, ACTIONS } from "../src/params.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());

const classify = (input: Record<string, unknown>): CallClass | undefined => h.declaration.classify(input);

type Row = [action: string, effect: "read" | "write", approval?: "review" | "dialog"];

const EXPECTED: Row[] = [
    ["get", "read"],
    ["search", "read"],
    ["comments", "read"],
    ["transitions", "read"],
    ["changelog", "read"],
    ["attachments", "read"],
    ["assignable", "read"],
    ["find_field", "read"],
    ["link_types", "read"],
    ["create", "write", "review"],
    ["comment", "write", "review"],
    ["edit_comment", "write", "review"],
    ["delete_comment", "write", "dialog"],
    ["transition", "write", "dialog"],
    ["update", "write", "dialog"],
    ["link", "write", "dialog"],
    ["unlink", "write", "dialog"],
];

describe("classification", () => {
    for (const [action, effect, approval] of EXPECTED) {
        test(`${action} is an external ${effect}${approval === undefined ? "" : ` on the ${approval === "review" ? "review screen" : "dialog"}`}`, () => {
            assert.deepEqual(classify({ action }), {
                action,
                environment: "external",
                effect,
                ...(approval === undefined ? {} : { approval }),
            });
        });
    }

    test("the actions above are exactly the actions of the tool", () => {
        assert.deepEqual(
            EXPECTED.map((row) => row[0]),
            ACTION_NAMES,
        );
        for (const [action, effect] of EXPECTED) assert.equal(ACTIONS[action as keyof typeof ACTIONS].kind, effect);
    });

    test("an action nobody declared is unknown, so jig-core asks", () => {
        for (const input of [
            { action: "relink" },
            { action: "" },
            { action: "__proto__" },
            { action: "constructor" },
            { action: 5 },
            { action: ["get"] },
            {},
        ]) {
            assert.equal(classify(input), undefined, JSON.stringify(input));
        }
    });

    test("update uses the review screen when it sets the description, by any spelling of its name", () => {
        assert.equal(classify({ action: "update", fields: { summary: "x" } })?.approval, "dialog");
        assert.equal(classify({ action: "update", fields: { labels: ["a"], priority: "High" } })?.approval, "dialog");
        for (const name of ["description", "Description", " DESCRIPTION "]) {
            assert.equal(
                classify({ action: "update", fields: { summary: "x", [name]: "text" } })?.approval,
                "review",
                name,
            );
        }
        assert.equal(classify({ action: "update", fields: null })?.approval, "dialog");
        assert.equal(classify({ action: "update", fields: "description" })?.approval, "dialog");
    });

    test("it depends on the action and, for update, on the field names, never on the text", () => {
        const secret = "SECRET-BODY-TEXT";
        const withText = classify({ action: "comment", key: "PROJ-1", text: secret });
        assert.ok(!JSON.stringify(withText).includes(secret));
        assert.deepEqual(withText, classify({ action: "comment" }));
        assert.deepEqual(
            classify({ action: "update", fields: { summary: secret } }),
            classify({ action: "update", fields: { summary: "other" } }),
        );
    });

    test("the environment is the one in the configuration, external by default", () => {
        assert.equal(classify({ action: "get" })?.environment, "external");
        h.configure({ site: "https://jira.example.test", auth: { token: "pass:jira/token" }, environment: "staging" });
        assert.equal(classify({ action: "get" })?.environment, "staging");
        assert.equal(classify({ action: "comment" })?.environment, "staging");
    });

    test("with no section, or one with errors, the default environment is used and nothing else changes", () => {
        h.jig.reset();
        assert.deepEqual(classify({ action: "comment" }), {
            action: "comment",
            environment: "external",
            effect: "write",
            approval: "review",
        });
        h.configure({ site: "http://not-https.test", auth: { token: "pass:jira/token" }, environment: "staging" });
        assert.equal(classify({ action: "comment" })?.environment, "external");
        h.reset();
    });

    test("classifyCall is pure: no settings needed", () => {
        assert.deepEqual(classifyCall({ action: "get" }, undefined), {
            action: "get",
            environment: "external",
            effect: "read",
        });
    });

    test("the tool is declared to jig-core as a jig-jira tool, with a preview, and does not mask its own results", () => {
        const declaration = h.jig.declared.get("jira");
        assert.equal(declaration?.plugin, "jig-jira");
        assert.equal(declaration?.tool, "jira");
        assert.equal(typeof declaration?.preview, "function");
        assert.notEqual(declaration?.masksOwnResults, true, "jig-core's masker is the backstop for a production Jira");
    });
});

// ---- the README and docs/parameters.md are the specification -----------------------------------------------------------

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = fs.readFileSync(path.join(PLUGIN, "README.md"), "utf8");
const PARAMETERS = fs.readFileSync(path.join(PLUGIN, "docs", "parameters.md"), "utf8");

/** The rows of the table whose header starts with `header`, in the README or in `document`, as lists of cells. */
function table(header: string, document: string = README): string[][] {
    const lines = document.split("\n");
    const start = lines.findIndex((line) => line.startsWith(header));
    assert.ok(start >= 0, `the document has a table that starts with ${header}`);
    const rows: string[][] = [];
    for (const line of lines.slice(start + 2)) {
        if (!line.startsWith("|")) break;
        rows.push(
            line
                .split("|")
                .slice(1, -1)
                .map((cell) => cell.trim()),
        );
    }
    return rows;
}

const names = (cell: string | undefined): string[] =>
    [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);

describe("the README", () => {
    test("its action table lists every action with its kind and screen", () => {
        const rows = table("| Action | Kind |");
        assert.deepEqual(
            rows.map((row) => names(row[0])[0]),
            ACTION_NAMES,
        );
        for (const row of rows) {
            const action = names(row[0])[0] as string;
            const kind = (row[1] ?? "").replace(/\*\*/g, "");
            const [, effect, approval] = EXPECTED.find((expected) => expected[0] === action) as Row;
            assert.match(kind, new RegExp(`^${effect === "write" ? "external write" : "read"}`), action);
            if (effect === "write") {
                assert.match(kind, approval === "review" ? /review screen/ : /dialog/, `${action}: ${kind}`);
            }
        }
        assert.match(
            table("| Action | Kind |").find((row) => row[0] === "`update`")?.[1] ?? "",
            /dialog; review screen when it sets the description/,
        );
    });

    test("its parameter table agrees with the table of the code", () => {
        const rows = table("| Action | Needs |", PARAMETERS);
        assert.deepEqual(
            rows.map((row) => names(row[0])[0]),
            ACTION_NAMES,
        );
        for (const row of rows) {
            const action = names(row[0])[0] as keyof typeof ACTIONS;
            assert.deepEqual(names(row[1]), [...ACTIONS[action].required], `${action} needs`);
            assert.deepEqual(names(row[2]), [...ACTIONS[action].optional], `${action} optional`);
        }
    });

    test("its configuration table names exactly the fields the section accepts", () => {
        const documented = table("| Field | Default |").map((row) => names(row[0])[0]);
        assert.deepEqual(documented, [
            "site",
            "auth",
            "updateFields",
            "fields",
            "createDefaults",
            "privateNames",
            "environment",
        ]);
        const valid = { site: "https://example.test", auth: { token: "pass:x/y" } };
        for (const field of documented) {
            assert.ok(
                !validateJira({ ...valid, [field]: valid[field as keyof typeof valid] }).some((error) =>
                    error.endsWith("unknown field"),
                ),
                field,
            );
        }
        assert.deepEqual(validateJira({ ...valid, other: 1 }), ["jira.other: unknown field"]);
    });

    test("its four forms of auth are the four the section accepts, and the defaults it states are the code's", () => {
        const forms = table("| `auth` | Signs in with |").map((row) => (row[0] ?? "").replace(/^`|`$/g, ""));
        assert.equal(forms.length, 4);
        for (const form of forms) {
            const filled = form
                .replace('"..."', '"jane@example.test"')
                .replace("<secret reference>", "pass:work/jira-token")
                .replace("<service name>", "sso")
                .replace("<name>", "proxy");
            const auth = JSON.parse(filled) as unknown;
            assert.deepEqual(validateJira({ site: "https://example.test", auth }), [], form);
        }
        const defaults = table("| Field | Default |").find((row) => row[0] === "`updateFields`")?.[1];
        assert.deepEqual(names(defaults), ["summary", "description", "labels", "priority", "assignee"]);
    });

    test("its example configuration is valid", () => {
        const example = /```json\n([\s\S]*?)\n```/.exec(README)?.[1];
        assert.ok(example);
        const section = (JSON.parse(example) as { jira: unknown }).jira;
        assert.deepEqual(validateJira(section), []);
        assert.ok(readJira(section).settings);
    });
});
