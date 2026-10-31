// The README and the detail pages lead to each other, say what the code does, and show the numbers the code has. A table
// that drifts from the code is found here, and not by a reader.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { USAGE } from "../src/command.ts";
import { DEFAULT_FOOTER, RESERVED_NAMES } from "../src/config.ts";
import { renderFooter } from "../src/footer.ts";
import { PALETTE_NAMES, PALETTES } from "../src/palettes.ts";
import { ROLE_MAP, VAR_NAMES, VAR_PURPOSE } from "../src/roles.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PLUGIN, "../..");
const README = path.join(PLUGIN, "README.md");
const PAGES = readdirSync(path.join(PLUGIN, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(PLUGIN, "docs", name));
const read = (file: string) => readFileSync(file, "utf8");
const page = (name: string) => read(path.join(PLUGIN, "docs", name));

/** The anchor GitHub makes of a heading: lower case, no punctuation but hyphens, spaces as hyphens. */
const anchorOf = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .replace(/ /g, "-");

function anchorsIn(file: string): Set<string> {
    const found = new Set<string>();
    for (const line of read(file).split("\n")) {
        const heading = /^#{1,6} (.+)$/.exec(line)?.[1];
        if (heading !== undefined) found.add(anchorOf(heading));
    }
    return found;
}

/** Every link and image of a Markdown file, as written. Code blocks are left out: they show text, not links. */
function linksIn(file: string): string[] {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
}

/** The rows of the Markdown tables in a text, as their cells with the backticks taken off. */
function rows(text: string): string[][] {
    return text
        .split("\n")
        .filter((line) => line.startsWith("|") && !/^\|[-| ]+\|$/.test(line))
        .map((line) =>
            line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim().replace(/^`|`$/g, "")),
        );
}

test("every link in the README and the pages leads to a file and a heading that exist", () => {
    let checked = 0;
    for (const file of [README, ...PAGES]) {
        for (const link of linksIn(file)) {
            if (/^[a-z]+:/i.test(link)) continue;
            const [target = "", anchor] = link.split("#");
            const resolved = target === "" ? file : path.resolve(path.dirname(file), target);
            const mine =
                resolved.startsWith(PLUGIN + path.sep) || resolved.startsWith(path.join(ROOT, "docs") + path.sep);
            if (!mine) continue;
            const where = `${path.relative(ROOT, file)} links to ${link}`;
            assert.ok(existsSync(resolved), `${where}: no such file`);
            if (anchor !== undefined) assert.ok(anchorsIn(resolved).has(anchor), `${where}: no such heading`);
            checked++;
        }
    }
    assert.ok(checked >= 12, `${checked} links were checked`);
});

test("every detail page is linked from the README, under More detail, and links back to the overview", () => {
    const readme = read(README);
    const detail = readme.slice(readme.indexOf("\n## More detail"));
    assert.deepEqual(PAGES.map((file) => path.basename(file)).sort(), ["footer.md", "palettes.md", "your-palettes.md"]);
    for (const file of PAGES) {
        assert.ok(detail.includes(`(docs/${path.basename(file)})`), `${path.basename(file)} is not under More detail`);
        const text = read(file);
        assert.match(text, /^# .+\n\n/, path.basename(file));
        assert.ok(/Back to the\s+\[jig-theme overview\]\(\.\.\/README\.md\)/.test(text), path.basename(file));
    }
});

test("the README has the shape the other plugins' READMEs have, and is built", () => {
    const readme = read(README);
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings, [
        "Palettes",
        "Your own palettes",
        "The footer",
        "Commands",
        "Rules",
        "Configure",
        "Company part (in the company plugin)",
        "Layout",
        "More detail",
    ]);
    assert.match(readme, /^\*\*Status: built\.\*\*/m);
    assert.match(readme, /\n\*[^*\n]+\*\n/, "an italic caption under the picture");
    assert.ok(readme.split("\n").length <= 170, `${readme.split("\n").length} lines: detail belongs in docs/`);
});

test("the README's tables say what the code does: palettes, commands, defaults", () => {
    const readme = read(README);
    for (const name of PALETTE_NAMES) assert.ok(readme.includes(`\`${name}\``), name);
    for (const command of ["/theme", "/theme <name>", "/theme reload", "/theme footer on` / `off"])
        assert.ok(readme.includes(`\`${command}\``), command);
    assert.ok(readme.includes(USAGE), "the usage line the code prints");
    assert.ok(readme.includes(JSON.stringify(DEFAULT_FOOTER.segments).replace(/,/g, ", ")), "the default parts");
    assert.ok(readme.includes(JSON.stringify(DEFAULT_FOOTER.dropFirst).replace(/,/g, ", ")), "the default dropFirst");
    assert.ok(readme.includes('`answerColor` | `"text"`'));
    assert.ok(readme.includes("seventeen"), "the number of colours");
    assert.equal(VAR_NAMES.length, 17);
    assert.doesNotMatch(readme, /fifteen/);
});

// ---- palettes.md -------------------------------------------------------------------------------------------------------

test("palettes.md lists the colours with the purpose the code has", () => {
    const text = page("palettes.md");
    const table = rows(text.slice(text.indexOf("## The seventeen colours"), text.indexOf("## The role map")));
    assert.deepEqual(
        table.filter((row) => row.length === 2 && row[0] !== "Colour").map((row) => row[0]),
        [...VAR_NAMES],
    );
    for (const [name = "", purpose] of table.filter((row) => row.length === 2 && row[0] !== "Colour"))
        assert.equal(purpose, VAR_PURPOSE[name as keyof typeof VAR_PURPOSE], name);
});

test("palettes.md gives every role the colour the role map gives it", () => {
    const text = page("palettes.md");
    const section = text.slice(text.indexOf("## The role map"), text.indexOf("## Contrast"));
    const found = new Map(
        rows(section)
            .filter((row) => row.length === 3 && row[0] !== "Area")
            .map((row) => [row[1] as string, row[2] as string]),
    );
    assert.deepEqual([...found.keys()].sort(), Object.keys(ROLE_MAP).sort());
    for (const [role, colour] of found) assert.equal(colour, ROLE_MAP[role as keyof typeof ROLE_MAP], role);
});

test("palettes.md shows the six palettes' colours as the code has them, and how many roles two of them set", () => {
    const text = page("palettes.md");
    const section = text.slice(text.indexOf("## The six"), text.indexOf("## Adding a palette"));
    const table = rows(section).filter((row) => row.length === 7);
    assert.deepEqual(table[0]?.slice(1), [...PALETTE_NAMES]);
    assert.deepEqual(
        table.slice(1).map((row) => row[0]),
        [...VAR_NAMES],
    );
    for (const row of table.slice(1)) {
        PALETTE_NAMES.forEach((name, index) => {
            assert.equal(
                row[index + 1],
                String(PALETTES[name]?.vars[row[0] as keyof typeof VAR_PURPOSE]),
                `${name} ${row[0]}`,
            );
        });
    }
    assert.match(
        section,
        new RegExp(`It sets ${Object.keys(PALETTES["jig-lime"]?.colors ?? {}).length}\\s+roles itself`),
    );
    assert.match(
        section,
        new RegExp(`It sets ${Object.keys(PALETTES["jig-signal"]?.colors ?? {}).length} roles\\s+itself`),
    );
});

test("palettes.md names the contrast exception the contrast test has", () => {
    const text = page("palettes.md");
    assert.match(text, /`jig-signal`[\s\S]*`dim` and `syntaxComment` \(`#586779`\)/);
    assert.equal(PALETTES["jig-signal"]?.vars.dim, "#586779");
    assert.equal(PALETTES["jig-signal"]?.colors?.syntaxComment, undefined, "syntaxComment follows dim");
});

// ---- your-palettes.md --------------------------------------------------------------------------------------------------

test("your-palettes.md names the reserved names, and quotes the warnings the code says", () => {
    const text = page("your-palettes.md");
    for (const name of ["system", "dark", "light", "reload", "footer"])
        assert.ok(RESERVED_NAMES.includes(name) && text.includes(`\`${name}\``), name);
    const source = read(path.join(PLUGIN, "src/write.ts")) + read(path.join(PLUGIN, "src/apply.ts"));
    for (const phrase of [
        "was changed by hand; jig-theme leaves it",
        "is not one jig-theme wrote; jig-theme leaves it",
        "is not a plain file; jig-theme leaves it",
        "is taken by another theme; jig-theme does not write it",
        "could not be written",
        "jig-theme/written.json cannot be read",
        "Pi cannot load the theme",
    ]) {
        assert.ok(source.includes(phrase), `the code no longer says: ${phrase}`);
        assert.ok(
            text.includes(phrase.replace(/^(Pi cannot load the theme)$/, "$1")),
            `the page does not show: ${phrase}`,
        );
    }
    assert.ok(text.includes("At most 20 palettes"));
});

// ---- footer.md ---------------------------------------------------------------------------------------------------------

test("footer.md gives every part its default colour and whether it is on, as the code has them", () => {
    const text = page("footer.md");
    const section = text.slice(text.indexOf("## The parts"), text.indexOf("The colours are Pi's text roles"));
    const table = rows(section).filter((row) => row.length === 4 && row[0] !== "Part");
    assert.deepEqual(
        table.map((row) => row[0]),
        ["model", "thinking", "context", "cache", "cost", "tokens", "branch", "cwd", "statuses", "plugins"],
    );
    for (const row of table) {
        const part = row[0] as keyof typeof DEFAULT_FOOTER.colors;
        assert.ok((row[2] ?? "").includes(DEFAULT_FOOTER.colors[part]), `${part}: its colour`);
        assert.equal(
            row[3],
            (DEFAULT_FOOTER.segments as string[]).includes(part) ? "yes" : "no",
            `${part}: on by default`,
        );
    }
});

test("footer.md has the defaults of the fields, and a Configure section", () => {
    const text = page("footer.md");
    assert.ok(text.includes("\n## Configure\n"));
    const section = text.slice(text.indexOf("## Configure"), text.indexOf("## Parts from other plugins"));
    for (const field of [
        "enabled",
        "segments",
        "dropFirst",
        "colors",
        "context.warnTokens",
        "context.warnPercent",
        "costDecimals",
        "separator",
    ])
        assert.ok(section.includes(`\`${field}`), field);
    assert.ok(section.includes(JSON.stringify(DEFAULT_FOOTER.segments).replace(/,/g, ", ")));
    assert.ok(section.includes(JSON.stringify(DEFAULT_FOOTER.dropFirst).replace(/,/g, ", ")));
    assert.ok(section.includes(`| \`costDecimals\` | ${DEFAULT_FOOTER.costDecimals} |`));
    assert.ok(section.includes('| `separator` | `" · "` |'));
    const limits = rows(text).filter(
        (row) => ["warnTokens", "highTokens", "warnPercent", "highPercent"].includes(row[0] ?? "") && row.length === 3,
    );
    for (const [name = "", value] of limits)
        assert.equal(value, String(DEFAULT_FOOTER.context[name as keyof typeof DEFAULT_FOOTER.context]), name);
    assert.equal(limits.length, 4);
});

test("footer.md's table of narrow widths is what the footer draws at each width", () => {
    const text = page("footer.md");
    const table = rows(text.slice(text.indexOf("## Narrow terminals"), text.indexOf("Width is counted"))).filter(
        (row) => /^\d+$/.test(row[0] ?? ""),
    );
    assert.equal(table.length, 5);
    for (const [width = "", shown] of table) {
        const drawn = renderFooter(Number(width), {
            settings: {
                ...DEFAULT_FOOTER,
                segments: [
                    "model",
                    "thinking",
                    "context",
                    "cache",
                    "cost",
                    "tokens",
                    "branch",
                    "cwd",
                    "plugins",
                    "statuses",
                ],
            },
            model: "Claude Opus 4.6 (US)",
            thinking: "medium",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                compactions: 0,
                estimatedCost: 0,
                contextTokens: 0,
                contextPercent: 0,
                contextWindow: 1_000_000,
            },
            branch: "feature/demo",
            cwd: "/somewhere/work",
        })[0];
        assert.equal(drawn, shown, `at ${width}`);
    }
});

test("footer.md shows the example of a part from another plugin, as the README does", () => {
    const text = page("footer.md");
    assert.ok(
        text.includes(
            'pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });',
        ),
    );
    assert.ok(
        read(README).includes(
            'pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });',
        ),
    );
});

// ---- the picture -------------------------------------------------------------------------------------------------------

test("the picture is an image with a description, and its swatches are jig-signal's own colours", () => {
    const svg = read(path.join(ROOT, "docs/img/theme-palettes.svg"));
    assert.match(svg, /^<svg [^>]*role="img" aria-label="[^"]{200,}"/);
    assert.match(svg, /font-family="IBM Plex Sans, Segoe UI, Arial, sans-serif"/);
    const palette = PALETTES["jig-signal"]?.vars;
    assert.ok(palette);
    for (const name of VAR_NAMES) {
        assert.ok(svg.includes(`>${name}</text>`), `${name} is labelled`);
        assert.ok(svg.includes(`fill="${palette[name]}"`), `${name} is drawn in ${palette[name]}`);
    }
    const readme = read(README);
    assert.ok(readme.includes("(../../docs/img/theme-palettes.svg)"));
});

test("the root documents list the plugin", () => {
    assert.match(
        read(path.join(ROOT, "docs/plugins.md")),
        /\[`jig-theme`\]\(\.\.\/plugins\/jig-theme\/README\.md\) \| built \|/,
    );
    assert.match(read(path.join(ROOT, "README.md")), /\[`jig-theme`\]\(plugins\/jig-theme\/README\.md\) \| built \|/);
    // AGENTS.md lists the built plugins in its first paragraph; jig-theme must be among them, however it is worded.
    const agentsIntro = read(path.join(ROOT, "AGENTS.md")).split("\n\n")[1] ?? "";
    assert.match(agentsIntro, /are built:[^.]*`jig-theme`/);
    // The status line's count follows the plugin table, so it is checked against the table, not a fixed number.
    const root = read(path.join(ROOT, "README.md"));
    const words = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
    ];
    const status = /\*\*Status:\*\* (\w+) of the (\w+) plugins are built/.exec(root);
    assert.ok(status, "the README has a status line");
    const rows = root.split("\n").filter((line) => /^\| \[`jig-[\w-]+`\]/.test(line));
    assert.equal(
        words.indexOf(status[1] ?? ""),
        rows.filter((line) => line.includes("| built |")).length,
        "built count",
    );
    assert.equal(words.indexOf(status[2] ?? ""), rows.length, "plugin count");
    assert.match(read(path.join(ROOT, "docs/architecture.md")), /jig-theme {2}the look/);
    const glossary = read(path.join(ROOT, "docs/glossary.md"));
    assert.match(glossary, /\| \*\*Palette\*\* \|/);
    assert.match(glossary, /\| \*\*Footer part\*\* \|/);
});
