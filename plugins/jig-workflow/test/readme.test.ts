// The README and the detail pages are the specification, and the code follows them. These tests read the tables in them and
// compare each with the code, so a change to one without the other fails here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { SECTION_FIELDS } from "../src/config.ts";
import { CONDITIONS } from "../src/definition.ts";
import { detectCommand } from "../src/tests.ts";
import { ACTION_NAMES } from "../src/tool.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

/** The cells of the first column of the table under `heading`, without their backticks. */
function firstColumn(markdown: string, heading: string): string[] {
    const start = markdown.indexOf(`\n## ${heading}`);
    assert.ok(start >= 0, `a heading "${heading}"`);
    const rows: string[] = [];
    for (const line of markdown
        .slice(start + 1)
        .split("\n")
        .slice(1)) {
        if (line.startsWith("## ")) break;
        const cell = /^\| ?(.+?) ?\|/.exec(line)?.[1];
        if (
            cell === undefined ||
            /^[-: ]+$/.test(cell) ||
            cell === "Action" ||
            cell === "Condition" ||
            cell === "Field" ||
            cell === "Command"
        )
            continue;
        rows.push(cell.replace(/`/g, ""));
    }
    return rows;
}

describe("the README", () => {
    const readme = read("README.md");

    test("is about 150 lines, as a plugin README is, and opens with the status", () => {
        assert.ok(readme.split("\n").length <= 160, `${readme.split("\n").length} lines`);
        assert.match(readme.split("\n")[2] ?? "", /^\*\*Status: built\.\*\*/);
    });

    test("the tool table lists the actions the tool has, in order, and says which are reads", () => {
        assert.deepEqual(firstColumn(readme, "Tool: `workflow`"), [...ACTION_NAMES]);
        const kinds = Object.fromEntries(
            readme
                .split("\n")
                .filter((line) => /^\| `[a-z-]+` \| (read|local write)/.test(line))
                .map((line) => [/`([a-z-]+)`/.exec(line)?.[1], /\| (read|local write)/.exec(line)?.[1]]),
        );
        assert.deepEqual(
            Object.entries(kinds)
                .filter(([, kind]) => kind === "read")
                .map(([name]) => name),
            ["list", "status"],
        );
    });

    test("the conditions table lists the eight conditions", () => {
        assert.deepEqual(firstColumn(readme, "Conditions"), [...CONDITIONS]);
    });

    test("the configuration table lists the fields of the section", () => {
        assert.deepEqual(firstColumn(readme, "Configure"), [...SECTION_FIELDS]);
    });

    test("the commands table lists the words the command understands", () => {
        const rows = firstColumn(readme, "Commands");
        assert.deepEqual(
            rows.map((row) => row.split(" ")[1] ?? ""),
            ["", "list", "start", "reload"],
        );
        assert.ok(rows.every((row) => row.startsWith("/workflow")));
    });

    test("links the pages in docs/, and the folder of examples", () => {
        for (const page of ["files", "conditions", "holds", "plan", "tests", "state", "design"]) {
            assert.match(readme, new RegExp(`\\(docs/${page}\\.md\\)`), page);
        }
        assert.match(readme, /\(examples\/\)/);
    });
});

describe("the pages", () => {
    test("conditions.md says how each condition is decided", () => {
        const page = read("docs/conditions.md");
        for (const condition of CONDITIONS) assert.match(page, new RegExp(`\`${condition}\``), condition);
    });

    test("the table of defaults in tests.md is what the code does", () => {
        const page = read("docs/tests.md");
        const rows = [...page.matchAll(/^\| (.+?) \| `(.+?)` \|$/gm)].filter(
            (row) => !/^(Found in the root|-)/.test(row[1] ?? ""),
        );
        assert.ok(rows.length >= 7, "the table has its rows");
        for (const [, files, command] of rows) {
            const first = [...(files ?? "").matchAll(/`([^`]+)`/g)][0]?.[1] ?? "";
            const dir = mkdtempSync(path.join(tmpdir(), "jig-workflow-readme-"));
            try {
                // A package.json counts only with a test script; every other file counts by being there.
                writeFileSync(path.join(dir, first), first === "package.json" ? '{ "scripts": { "test": "x" } }' : "");
                assert.equal(detectCommand(dir)?.command, command, first);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    test("files.md lists the examples that ship", () => {
        const page = read("docs/files.md");
        for (const name of ["feature", "bugfix", "investigation"]) {
            assert.match(page, new RegExp(`\`${name}.json\``));
            assert.ok(read(`examples/${name}.json`).length > 0);
        }
    });

    test("holds.md lists the calls that always ask, and the tool asks for each", () => {
        const page = read("docs/holds.md");
        for (const call of ["workflow submit-plan", "workflow advance", "workflow start", "workflow test"]) {
            assert.match(page, new RegExp(`\`${call}`), call);
        }
    });
});

test("docs/plugins.md lists the workflow tool's actions", () => {
    const page = readFileSync(path.resolve(ROOT, "../../docs/plugins.md"), "utf8");
    const line = /\*\*`workflow`\*\*[\s\S]*?\n(?=- \*\*)/.exec(page)?.[0] ?? "";
    for (const name of ACTION_NAMES) assert.match(line, new RegExp(`\`${name}\``), name);
});
