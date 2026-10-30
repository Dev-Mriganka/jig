// A broken link in the docs is a page that sends the reader nowhere. Every relative link and image in every Markdown
// file must point at a file that exists, and every #anchor into a Markdown file must match one of its headings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SKIPPED = ["node_modules/", "plugins/jig-review/web/"];

/** The text of a heading as GitHub shows it, with the inline Markdown taken out. */
function headingText(raw: string): string {
    return raw
        .replace(/\s+#+\s*$/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]*>/g, "")
        .replace(/`/g, "")
        .replace(/(^|[^\p{L}\p{N}])_+([^_]+)_+(?=[^\p{L}\p{N}]|$)/gu, "$1$2")
        .trim();
}

/** GitHub's anchor for a heading: lower case, punctuation dropped except `-` and `_`, each space a `-`. */
export function slug(heading: string): string {
    return headingText(heading)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
        .replace(/ /g, "-");
}

/** Every line of a file that is outside a fenced code block, with its 1-based line number. */
function proseLines(text: string): { line: number; text: string }[] {
    const lines: { line: number; text: string }[] = [];
    let fence: string | undefined;
    text.split("\n").forEach((content, index) => {
        const mark = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
        if (fence !== undefined) {
            if (mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
            return;
        }
        if (mark) {
            fence = mark;
            return;
        }
        lines.push({ line: index + 1, text: content });
    });
    return lines;
}

/** The anchors a Markdown file offers: its headings (a repeat gets -1, -2, ...) and its explicit `<a id>` marks. */
export function anchors(text: string): Set<string> {
    const found = new Set<string>();
    const seen = new Map<string, number>();
    for (const { text: line } of proseLines(text)) {
        const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
        if (heading) {
            const base = slug(heading[1] ?? "");
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            found.add(count === 0 ? base : `${base}-${count}`);
        }
        for (const mark of line.matchAll(/<a\s[^>]*?\b(?:id|name)="([^"]+)"/g)) found.add(mark[1] ?? "");
    }
    return found;
}

/** Every link and image target in a file, outside code blocks and code spans. */
export function targets(text: string): { line: number; target: string }[] {
    const found: { line: number; target: string }[] = [];
    for (const { line, text: content } of proseLines(text)) {
        const prose = content.replace(/(`+)[^`]*?\1/g, "CODE");
        for (const match of prose.matchAll(/\]\(\s*(<[^>]*>|[^)\s]*)/g)) {
            found.push({ line, target: (match[1] ?? "").replace(/^<|>$/g, "") });
        }
        for (const match of prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/g)) found.push({ line, target: match[1] ?? "" });
        for (const match of prose.matchAll(/<(?:a|img)\s[^>]*?\b(?:href|src)="([^"]*)"/g)) {
            found.push({ line, target: match[1] ?? "" });
        }
    }
    return found;
}

function markdownFiles(): string[] {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
        cwd: ROOT,
        encoding: "utf8",
    });
    return listed
        .split("\0")
        .filter((file) => file !== "" && !SKIPPED.some((skip) => file.startsWith(skip) || file.includes(`/${skip}`)))
        .filter((file) => existsSync(path.join(ROOT, file)));
}

const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function problems(file: string, anchorsOf: (resolved: string) => Set<string>): string[] {
    const found: string[] = [];
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const { line, target } of targets(text)) {
        if (target === "" || external.test(target)) continue;
        const where = `${file}:${line}: ${target}`;
        const hash = target.indexOf("#");
        const pathPart = decodeURI((hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, ""));
        const anchor = hash === -1 ? undefined : decodeURI(target.slice(hash + 1));
        const resolved = pathPart.startsWith("/")
            ? path.join(ROOT, pathPart)
            : pathPart === ""
              ? path.join(ROOT, file)
              : path.join(ROOT, path.dirname(file), pathPart);
        if (!existsSync(resolved)) {
            found.push(`${where}: no such file`);
            continue;
        }
        if (anchor === undefined || anchor === "" || !resolved.endsWith(".md") || !statSync(resolved).isFile())
            continue;
        if (!anchorsOf(resolved).has(anchor)) found.push(`${where}: no such heading`);
    }
    return found;
}

test("an anchor is made from a heading the way GitHub makes it", () => {
    assert.equal(slug("Reading a `PROJ-123` ticket"), "reading-a-proj-123-ticket");
    assert.equal(slug("What it is, and why?"), "what-it-is-and-why");
    assert.equal(slug("Approve & send"), "approve--send");
    assert.equal(slug("The [glossary](glossary.md) terms"), "the-glossary-terms");
    assert.equal(slug("snake_case_name"), "snake_case_name");
    assert.equal(slug("2026-10-30: A choice — made"), "2026-10-30-a-choice--made");
});

test("a repeated heading gets -1, -2, and an explicit id counts too", () => {
    const found = anchors('# One\n\n## Same\n\ntext\n\n## Same\n\n## Same\n\n<a id="named"></a>\n');
    assert.deepEqual([...found].sort(), ["named", "one", "same", "same-1", "same-2"]);
});

test("a heading, a link or an id inside a code block is ignored", () => {
    const text = [
        "# Real",
        "",
        "```md",
        "# Not a heading",
        "[no](missing.md)",
        "```",
        "",
        "[yes](real.md) and `[no](also-missing.md)`",
    ].join("\n");
    assert.deepEqual([...anchors(text)], ["real"]);
    assert.deepEqual(
        targets(text).map((entry) => entry.target),
        ["real.md"],
    );
});

test("every relative link and image in the docs points at a file and a heading that exist", () => {
    const files = markdownFiles();
    assert.ok(files.length > 20, "the repository has Markdown files");
    const cache = new Map<string, Set<string>>();
    const anchorsOf = (resolved: string) => {
        let known = cache.get(resolved);
        if (!known) {
            known = anchors(readFileSync(resolved, "utf8"));
            cache.set(resolved, known);
        }
        return known;
    };
    const broken = files.flatMap((file) => problems(file, anchorsOf));
    assert.deepEqual(broken, []);
});
