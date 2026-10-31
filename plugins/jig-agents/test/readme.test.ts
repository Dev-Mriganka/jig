// The README and the detail pages are the specification, and the code follows them. These tests read the tables in them and compare each
// with the code, so a change to one without the other fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_LIMITS, RANGES, SECTION_FIELDS, settingsFrom } from "../src/config.ts";
import { loadRoles, parseRole, ROLE_FIELDS, shippedFolder } from "../src/roles.ts";
import { bodyOf, frontMatterOf, toolsNamedBy } from "../src/skills.ts";
import { ACTION_NAMES } from "../src/tool.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

/** The rows of the first table under `heading` (a `##` or `###` one): the cells of each row, without backticks. */
function table(markdown: string, heading: string): string[][] {
    const match = new RegExp(`\\n(#{2,3}) ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`).exec(markdown);
    assert.ok(match, `a heading "${heading}"`);
    const level = (match[1] ?? "##").length;
    const rows: string[][] = [];
    for (const line of markdown
        .slice(match.index + 1)
        .split("\n")
        .slice(1)) {
        if (new RegExp(`^#{1,${level}} `).test(line)) break;
        if (!line.startsWith("|")) continue;
        const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim().replace(/`/g, ""));
        if (cells.every((cell) => /^[-: ]+$/.test(cell))) continue;
        rows.push(cells);
    }
    return rows.slice(1);
}

describe("the README", () => {
    const readme = read("README.md");

    test("opens with the status, and stays short enough to read in one sitting", () => {
        // Longer than most plugins' READMEs, on purpose: the roles and their fields are what a reader came to learn, and the owner asked
        // for them in the README itself. The mechanism behind them is in docs/design.md.
        assert.ok(readme.split("\n").length <= 280, `${readme.split("\n").length} lines`);
        assert.match(readme.split("\n")[2] ?? "", /^\*\*Status: built\.\*\*/);
    });

    test("the tool table lists the actions the tool has, in order, and says which is a read", () => {
        const rows = table(readme, "Tool: `subagent`");
        assert.deepEqual(
            rows.slice(0, 4).map((row) => row[0]),
            [...ACTION_NAMES],
        );
        assert.deepEqual(
            rows
                .slice(0, 4)
                .filter((row) => row[1] === "read")
                .map((row) => row[0]),
            ["status"],
        );
        assert.ok(
            rows
                .slice(0, 4)
                .filter((row) => row[1] !== "read")
                .every((row) => row[1] === "local write"),
        );
    });

    test("the commands table lists the words the command understands", () => {
        const text = readme.slice(readme.indexOf("| Command |"));
        for (const word of ["roles", "show", "say", "stop"]) assert.match(text, new RegExp(`/agents ${word}`), word);
    });

    test("the roles table lists the roles that ship, with whether each may write, its tools and its git actions", () => {
        const { roles } = loadRoles([shippedFolder()]);
        const rows = table(readme, "The roles that ship");
        assert.deepEqual(
            rows.map((row) => row[0]),
            ["scout", "reviewer", "worker"],
        );
        for (const row of rows) {
            const role = roles.get(row[0] as string);
            assert.equal(role?.writes, row[1] === "yes", String(row[0]));
            assert.equal(row[2], role?.tools?.join(", "), `${row[0]}: tools`);
            // A role narrowed to some git actions names every one of them; one that is not narrowed says all.
            for (const action of role?.actions?.git ?? [])
                assert.ok((row[3] ?? "").includes(action), `${row[0]}: ${action}`);
            if (role?.actions === undefined) assert.match(row[3] ?? "", /^all/);
        }
    });

    test("the field table lists every field an agent file has, in the parser's order", () => {
        const rows = table(readme, "Every field");
        assert.deepEqual(
            rows.slice(0, ROLE_FIELDS.length).map((row) => row[0]),
            [...ROLE_FIELDS],
        );
        // Whoever may change a field is said in the last column, and `writes` is the file's alone.
        assert.equal(rows.find((row) => row[0] === "writes")?.[3], "the file only");
        for (const row of rows.slice(0, ROLE_FIELDS.length)) assert.match(row[3] ?? "", /^the file/, String(row[0]));
    });

    /** The Markdown code blocks of the README, each without the indent of the list item it may sit in. */
    const blocks = [...readme.matchAll(/^ *```markdown\n([\s\S]*?)^ *```/gm)].map((match) =>
        (match[1] ?? "").replace(/^ {2}/gm, ""),
    );

    test("the example agent file parses and uses every field, with its comments", () => {
        const example = blocks[0] ?? "";
        const role = parseRole(example, "/orders-fixer.md", "x");
        assert.equal(role.name, "orders-fixer");
        for (const field of ["tools", "actions", "ask", "writes", "skills", "preload", "context", "thinking"]) {
            assert.ok(Object.hasOwn(role, field), field);
        }
        // Every field of the parser is written out in the example, once.
        const lines = (/^---\n([\s\S]*?)\n---/m.exec(example)?.[1] ?? "")
            .split("\n")
            .filter((line) => !line.startsWith("#"));
        assert.deepEqual(
            lines.map((line) => line.split(":")[0]),
            [...ROLE_FIELDS],
        );
        assert.equal(role.writes, true);
        assert.deepEqual(role.ask, { git: ["push"] });
    });

    test("the skill example names the tool it extends in the field the code reads", () => {
        const text = blocks.find((block) => block.includes("name: acme-jira")) ?? "";
        assert.deepEqual(toolsNamedBy(frontMatterOf(text) ?? ""), ["jira"]);
        assert.equal(bodyOf(text), "");
    });

    test("the limits table has the defaults the code has", () => {
        const rows = table(readme, "Limits");
        assert.deepEqual(
            rows.map((row) => [row[0], Number(row[1])]),
            Object.entries(DEFAULT_LIMITS),
        );
    });

    test("the configuration table lists the fields of the section, in order, with the defaults the code has", () => {
        const rows = table(readme, "Configure");
        const names: string[] = [];
        for (const row of rows) {
            for (const cell of (row[0] ?? "").split(", ")) {
                const top = cell.split(".")[0] ?? "";
                if (top !== "" && !names.includes(top)) names.push(top);
            }
        }
        assert.deepEqual(names, [...SECTION_FIELDS]);
        const settings = settingsFrom(undefined);
        const counts = rows.find((row) => row[0]?.startsWith("maxRunning"));
        assert.equal(
            counts?.[1],
            [settings.maxRunning, settings.maxStarted, settings.approvalWaitMinutes, settings.maxAsks].join(", "),
        );
        assert.equal(rows.find((row) => row[0] === "branch")?.[1], settings.branch);
        assert.deepEqual(Object.keys(RANGES).sort(), [
            "approvalWaitMinutes",
            "maxAsks",
            "maxCost",
            "maxMinutes",
            "maxRunning",
            "maxStarted",
            "maxTurns",
        ]);
    });

    test("the layout names every module and the folders that exist", () => {
        const layout = /```text\njig-agents\/([\s\S]*?)```/.exec(readme)?.[1] ?? "";
        for (const file of readdirSync(path.join(ROOT, "src"))) {
            const module = file.replace(/\.ts$/, "");
            assert.match(layout, new RegExp(`\\b${module}\\b`), `${file} in the layout`);
        }
        for (const folder of ["agents/", "skills/", "test/", "docs/"]) assert.match(layout, new RegExp(folder));
    });

    test("links every page of docs/", () => {
        for (const page of readdirSync(path.join(ROOT, "docs")))
            assert.match(readme, new RegExp(`\\(docs/${page}\\)`), page);
    });
});

describe("the pages", () => {
    test("design.md has the sections the README points to", () => {
        const design = read("docs/design.md");
        for (const heading of ["Approvals in a child", "Configuration", "Lifecycle", "Limits", "Results"]) {
            assert.match(design, new RegExp(`^## ${heading}$`, "m"), heading);
        }
    });

    test("design.md gives the ranges the code checks", () => {
        const design = read("docs/design.md");
        assert.match(design, /turns 1 to 500, minutes 1 to 480, cost above 0 up to 100/);
        assert.equal(RANGES.maxTurns.max, 500);
        assert.equal(RANGES.maxMinutes.max, 480);
        assert.equal(RANGES.maxCost.max, 100);
        assert.match(design, /\| `maxRunning`, `maxStarted` \| 1 to 16, and 1 to 200 \| 4, 30 \|/);
        assert.match(design, /\| `approvalWaitMinutes`, `maxAsks` \| 1 to 240, and 0 to 100 \| 30, 10 \|/);
    });

    test("design.md names the flags that are never passed, as the code does", async () => {
        const { NEVER_PASSED } = await import("../src/launch.ts");
        const design = read("docs/design.md");
        for (const flag of NEVER_PASSED) assert.ok(design.includes(`\`${flag}\``), flag);
    });
});

test("docs/plugins.md lists the subagent tool's actions", () => {
    const page = readFileSync(path.resolve(ROOT, "../../docs/plugins.md"), "utf8");
    const line = /\*\*`subagent`:\*\*.*/.exec(page)?.[0] ?? "";
    for (const name of ACTION_NAMES) assert.match(line, new RegExp(`\`${name}\``), name);
});
