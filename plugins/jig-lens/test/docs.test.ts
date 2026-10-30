// The README and the detail pages lead to each other and to the pictures they use. A link that points at a page or a
// heading that is not there is found here, and not by a reader. Links into other plugins are theirs to keep.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PLUGIN, "../..");
const README = path.join(PLUGIN, "README.md");
const PAGES = readdirSync(path.join(PLUGIN, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(PLUGIN, "docs", name));

/** The anchor GitHub makes of a heading: lower case, no punctuation but hyphens, spaces as hyphens. */
const anchorOf = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .replace(/ /g, "-");

function anchorsIn(file: string): Set<string> {
    const found = new Set<string>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const heading = /^#{1,6} (.+)$/.exec(line)?.[1];
        if (heading !== undefined) found.add(anchorOf(heading));
    }
    return found;
}

/** Every link and image of a Markdown file, as written. Code blocks are left out: they show text, not links. */
function linksIn(file: string): string[] {
    const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
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
    assert.ok(checked >= 25, `${checked} links were checked`);
});

test("every detail page is linked from the README, under More detail", () => {
    const readme = readFileSync(README, "utf8");
    const detail = readme.slice(readme.indexOf("\n## More detail"));
    assert.ok(detail.includes("## More detail"));
    for (const page of PAGES) {
        assert.ok(detail.includes(`(docs/${path.basename(page)})`), `${path.basename(page)} is not under More detail`);
    }
});

test("every detail page says where it belongs, with a link back to the overview", () => {
    for (const page of PAGES) {
        const text = readFileSync(page, "utf8");
        assert.match(text, /^# .+\n\n/, path.basename(page));
        assert.ok(/Back to\s+(the\s+)?\[jig-lens overview\]\(\.\.\/README\.md\)/.test(text), path.basename(page));
    }
});

test("the README points at jig-core's records page, where the section moved to", () => {
    const readme = readFileSync(README, "utf8");
    assert.match(readme, /\]\(\.\.\/jig-core\/docs\/records\.md\)/);
    assert.doesNotMatch(readme, /jig-core\/README\.md#records/);
    assert.match(
        readFileSync(path.join(PLUGIN, "docs/index-schema.md"), "utf8"),
        /\]\(\.\.\/\.\.\/jig-core\/docs\/records\.md\)/,
    );
});

test("the README has the shape the other plugins' READMEs have, and is about as long as they are", () => {
    const readme = readFileSync(README, "utf8");
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings, ["Commands", "Rules", "Configure", "Later", "Layout", "More detail"]);
    assert.match(readme, /^\*\*Status: built\.\*\*/m);
    assert.match(readme, /\n\*[^*\n]+\*\n/, "an italic caption under the picture");
    assert.ok(readme.split("\n").length <= 125, `${readme.split("\n").length} lines: detail belongs in docs/`);
});
