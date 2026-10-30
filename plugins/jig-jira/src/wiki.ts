// Jira wiki markup to HTML, for the page the user opens with `o` before a write is sent.
//
// The text can come from the model, so it is untrusted. Two rules keep the page safe:
//   - the whole source is HTML-escaped before anything is converted, so the only tags in the result are the ones this
//     file writes, and no character of the source reaches a tag or an attribute unescaped;
//   - a link is kept only for http, https and mailto addresses, and a colour only when it is a plain name or hex code.
// The other aim is faithfulness: the person approving sees what the readers will see. A construct this file does not
// know (an unknown macro, a `{code}` that is never closed) stays in the page as the text it was written as, so nothing
// the readers will see is hidden from the person approving it.

/** The text with `& < > " '` made harmless in HTML, in element content and in quoted attribute values alike. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

// Placeholders for finished HTML while the rest of a line is still being converted. Control characters are removed from
// the source first, so these can never be mistaken for text.
const KEEP_OPEN = "\u0001";
const KEEP_CLOSE = "\u0002";
const BLOCK_OPEN = "\u0003";
const BLOCK_CLOSE = "\u0004";
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Quotes and panels can sit inside each other; deeper than this they are shown as the text they were written as. */
const MAX_DEPTH = 4;

const COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const LANGUAGE = /^[\w#+.-]{1,20}$/;
const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s\u0001-\u0004]+$/i;

/** HTML for a piece of Jira wiki markup: block elements, no page around them. */
export function renderWiki(source: string): string {
    const text = escapeHtml(source.replace(/\r\n?/g, "\n").replace(CONTROL, ""));
    const finished: string[] = [];
    // Code and noformat are verbatim, so they are taken out before anything else can look inside them.
    const taken = takeBlock(takeBlock(text, "code", finished, (params, inner) => codeBlock(params, inner)),
        "noformat", finished, (_params, inner) => `<pre class="noformat">${trimNewlines(inner)}</pre>`);
    return renderBlocks(taken, finished, 0);
}

function trimNewlines(text: string): string {
    return text.replace(/^\n/, "").replace(/\n$/, "");
}

/** Replaces each `{name}...{name}` with a placeholder line for its finished HTML. An unclosed one stays as text. */
function takeBlock(
    text: string,
    name: string,
    finished: string[],
    render: (params: string, inner: string) => string,
): string {
    const pattern = new RegExp(`\\{${name}(?::([^}\\n]*))?\\}([\\s\\S]*?)\\{${name}\\}`, "g");
    return text.replace(pattern, (_match, params: string | undefined, inner: string) =>
        `\n${BLOCK_OPEN}${finished.push(render(params ?? "", inner)) - 1}${BLOCK_CLOSE}\n`);
}

/** `java`, `title=Notes|borderColor=#ccc`: a leading bare word and the name=value pairs. */
function macroParams(params: string): { first: string | undefined; named: Map<string, string> } {
    const named = new Map<string, string>();
    let first: string | undefined;
    params.split("|").forEach((part, index) => {
        const equals = part.indexOf("=");
        if (equals > 0) named.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
        else if (index === 0 && part.trim() !== "") first = part.trim();
    });
    return { first, named };
}

function codeBlock(params: string, inner: string): string {
    const { first, named } = macroParams(params);
    const language = named.get("language") ?? first;
    const title = named.get("title");
    return `<pre class="code"${language !== undefined && LANGUAGE.test(language) ? ` data-lang="${language}"` : ""}>` +
        `${title === undefined ? "" : `<span class="title">${title}</span>`}<code>${trimNewlines(inner)}</code></pre>`;
}

function panelBlock(params: string, inner: string, finished: string[], depth: number): string {
    const { named } = macroParams(params);
    const color = (name: string): string | undefined => {
        const value = named.get(name);
        return value !== undefined && COLOR.test(value) ? value : undefined;
    };
    const border = color("borderColor");
    const background = color("bgColor");
    const titleBackground = color("titleBGColor");
    const title = named.get("title");
    const style = (rules: Array<[string, string | undefined]>): string => {
        const used = rules
            .filter((rule): rule is [string, string] => rule[1] !== undefined)
            .map(([name, value]) => `${name}:${value}`);
        return used.length === 0 ? "" : ` style="${used.join(";")}"`;
    };
    return `<div class="panel"${style([["border-color", border], ["background", background]])}>` +
        (title === undefined ? "" : `<div class="panel-title"${style([["background", titleBackground]])}>${title}</div>`) +
        `<div class="panel-body">${renderBlocks(inner, finished, depth + 1)}</div></div>`;
}

// ---- blocks -----------------------------------------------------------------------------------------------------------

const HEADING = /^h([1-6])\.\s+(.*)$/;
const QUOTE_LINE = /^bq\.\s+(.*)$/;
const RULE = /^-{4,}\s*$/;
const LIST_ITEM = /^([*#-]+)\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const BLOCK_LINE = new RegExp(`^${BLOCK_OPEN}(\\d+)${BLOCK_CLOSE}$`);

function renderBlocks(text: string, finished: string[], depth: number): string {
    let source = text;
    if (depth < MAX_DEPTH) {
        source = takeBlock(source, "quote", finished, (_params, inner) =>
            `<blockquote>${renderBlocks(inner, finished, depth + 1)}</blockquote>`);
        source = takeBlock(source, "panel", finished, (params, inner) => panelBlock(params, inner, finished, depth));
    }
    const lines = source.split("\n");
    const html: string[] = [];
    let paragraph: string[] = [];
    const endParagraph = (): void => {
        if (paragraph.length > 0) html.push(`<p>${inline(paragraph.join("\n"))}</p>`);
        paragraph = [];
    };

    for (let index = 0; index < lines.length;) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        const block = BLOCK_LINE.exec(trimmed);
        const heading = HEADING.exec(trimmed);
        const quote = QUOTE_LINE.exec(trimmed);
        if (trimmed === "") {
            endParagraph();
            index++;
        } else if (block !== null) {
            endParagraph();
            html.push(finished[Number(block[1])] ?? "");
            index++;
        } else if (heading !== null) {
            endParagraph();
            html.push(`<h${heading[1]}>${inline(heading[2] ?? "")}</h${heading[1]}>`);
            index++;
        } else if (quote !== null) {
            endParagraph();
            html.push(`<blockquote><p>${inline(quote[1] ?? "")}</p></blockquote>`);
            index++;
        } else if (RULE.test(trimmed)) {
            endParagraph();
            html.push("<hr>");
            index++;
        } else if (LIST_ITEM.test(trimmed)) {
            endParagraph();
            const items: string[] = [];
            for (; index < lines.length && LIST_ITEM.test((lines[index] ?? "").trim()); index++) {
                items.push((lines[index] ?? "").trim());
            }
            html.push(renderList(items));
        } else if (TABLE_ROW.test(line)) {
            endParagraph();
            const rows: string[] = [];
            index = collectRows(lines, index, rows);
            html.push(renderTable(rows, finished, depth));
        } else {
            paragraph.push(line);
            index++;
        }
    }
    endParagraph();
    return html.join("\n");
}

/**
 * `*` and `-` make bullets and `#` numbers; each repeated marker is one level deeper (`*#` is a numbered item in a
 * bullet).
 */
function renderList(items: string[]): string {
    const open: Array<"ul" | "ol"> = [];
    const html: string[] = [];
    for (const item of items) {
        const [, marker = "", content = ""] = LIST_ITEM.exec(item) ?? [];
        const kinds = [...marker].map((character): "ul" | "ol" => (character === "#" ? "ol" : "ul"));
        let shared = 0;
        while (shared < open.length && shared < kinds.length && open[shared] === kinds[shared]) shared++;
        while (open.length > shared) html.push(`</li></${open.pop()}>`);
        if (shared === kinds.length) html.push("</li>");
        for (let level = shared; level < kinds.length; level++) {
            html.push(`<${kinds[level]}>`);
            open.push(kinds[level] ?? "ul");
        }
        html.push(`<li>${inline(content)}`);
    }
    while (open.length > 0) html.push(`</li></${open.pop()}>`);
    return html.join("");
}

/** The lines of one table starting at `from`. A row that does not end with `|` goes on to the next line, as in Jira. */
function collectRows(lines: string[], from: number, rows: string[]): number {
    let index = from;
    let current = "";
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (current === "" && !TABLE_ROW.test(line)) break;
        if (current !== "" && line.trim() === "") break;
        current = current === "" ? line.trim() : `${current}\n${line}`;
        index++;
        if (/\|\s*$/.test(current)) {
            rows.push(current);
            current = "";
        }
    }
    if (current !== "") rows.push(current);
    return index;
}

interface Cell {
    header: boolean;
    text: string;
}

/** The cells of one row. A `|` inside `[...]` (a link) or after a backslash does not end a cell. */
function cellsOf(row: string): Cell[] {
    const cells: Cell[] = [];
    let at = 0;
    while (at < row.length) {
        const header = row.startsWith("||", at);
        at += header ? 2 : 1;
        let end = at;
        let brackets = 0;
        while (end < row.length) {
            const character = row[end];
            if (character === "\\") end += 2;
            else if (character === "[") { brackets++; end++; }
            else if (character === "]" && brackets > 0) { brackets--; end++; }
            else if (character === "|" && brackets === 0) break;
            else end++;
        }
        const text = row.slice(at, Math.min(end, row.length));
        if (end < row.length || text.trim() !== "") cells.push({ header, text });
        at = end;
    }
    return cells;
}

function renderTable(rows: string[], finished: string[], depth: number): string {
    const body = rows.map((row) => {
        const cells = cellsOf(row).map(({ header, text }) => {
            const tag = header ? "th" : "td";
            const several = text.includes("\n") && depth < MAX_DEPTH;
            const content = several ? renderBlocks(text, finished, depth + 1) : inline(text.trim());
            return `<${tag}>${content}</${tag}>`;
        });
        return `<tr>${cells.join("")}</tr>`;
    });
    return `<table>${body.join("")}</table>`;
}

// ---- inline -----------------------------------------------------------------------------------------------------------

/** (name, tag) in the order they are applied: an outer mark first, so `*bold _and italic_*` nests the right way. */
const MARKS: ReadonlyArray<readonly [string, string]> = [
    ["*", "strong"], ["_", "em"], ["-", "del"], ["+", "ins"], ["^", "sup"], ["~", "sub"],
];

const IMAGE = /!([^\s!|\u0001-\u0004]+\.[A-Za-z0-9]{2,5}|https?:\/\/[^\s!|\u0001-\u0004]+)(?:\|[^!\n]*)?!/g;
const BRACKET = /\[([^[\]\n]{1,500})\]/g;
const BARE_URL = /\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s\u0001-\u0004]){1,1000}/gi;
// Emoticons are shown as the text they are written as. They are taken out before the marks, so that `(*)` or `(-)` is
// never read as the start of a bold or strike-through run.
const EMOTICONS = [
    "(/)", "(x)", "(!)", "(+)", "(-)", "(?)", "(on)", "(off)", "(y)", "(n)", "(i)", "(flag)", "(flagoff)",
    "(*)", "(*r)", "(*g)", "(*b)", "(*y)",
];
const EMOTICON = new RegExp(
    String.raw`(?<![\w])(?:${EMOTICONS.map(escapeRegExp).join("|")}|[:;]-?[)(PD])(?![\w])`,
    "g",
);

function inline(text: string): string {
    const kept: string[] = [];
    const keep = (html: string): string => `${KEEP_OPEN}${kept.push(html) - 1}${KEEP_CLOSE}`;
    let line = text;

    line = line.replace(/\{\{([^\n]{1,2000}?)\}\}/g, (_match, code: string) => keep(`<code>${code}</code>`));
    line = line.replace(/\\\\/g, () => keep("<br>"));
    line = line.replace(/\\([*_+^~{}[\]|!#()?-])/g, (_match, character: string) => keep(character));
    line = pairColors(line, keep);
    line = line.replace(IMAGE, (_match, name: string) => keep(`<span class="image">[image: ${name}]</span>`));
    line = line.replace(BRACKET, (_match, inner: string) => bracket(inner, keep));
    line = line.replace(BARE_URL, (url: string) => {
        const trailing = /[.,;:!?)]+$/.exec(url)?.[0] ?? "";
        const address = url.slice(0, url.length - trailing.length);
        return `${keep(`<a href="${address}" rel="noreferrer noopener">${address}</a>`)}${trailing}`;
    });
    line = line.replace(EMOTICON, (emoticon: string) => keep(`<span class="emoticon">${emoticon}</span>`));
    for (const [mark, tag] of MARKS) line = applyMark(line, mark, tag, keep);

    return line
        .replace(/\u0001(\d+)\u0002/g, (_match, index: string) => kept[Number(index)] ?? "")
        .replace(/\n/g, "<br>");
}

/**
 * One bracket: a mention, an attachment, or a link to an http, https or mailto address. Anything else, such as `[WIP]`,
 * `[PROJ-12]` or a link to another scheme, stays as written with its brackets, so a target that is not opened is still
 * visible to the person approving.
 */
function bracket(inner: string, keep: (html: string) => string): string {
    if (inner.startsWith("~")) {
        const who = inner.slice(1).replace(/^accountid:/i, "");
        return keep(`<span class="mention">@${who}</span>`);
    }
    if (inner.startsWith("^")) return keep(`<span class="attachment">${inner.slice(1)}</span>`);
    const parts = inner.split("|");
    const label = parts.length === 1 ? undefined : parts[0];
    const target = (parts.length === 1 ? parts[0] : parts[1])?.trim() ?? "";
    if (!SAFE_LINK.test(target)) return `[${inner}]`;
    const open = `<a href="${target}" rel="noreferrer noopener">`;
    // A bare address is the link's own text, so it is kept whole and no mark inside it can be read as markup.
    return label === undefined ? keep(`${open}${target}</a>`) : `${keep(open)}${label}${keep("</a>")}`;
}

/** `{color:red}text{color}`. Only a pair is a colour; a lone tag stays as text. */
function pairColors(line: string, keep: (html: string) => string): string {
    const tags = [...line.matchAll(/\{color(?::([^}\n]*))?\}/g)];
    const opened: number[] = [];
    const paired = new Map<number, string>();
    tags.forEach((tag, index) => {
        if (tag[1] !== undefined) {
            opened.push(index);
            return;
        }
        const start = opened.pop();
        if (start === undefined) return;
        const color = tags[start]?.[1]?.trim() ?? "";
        paired.set(start, keep(COLOR.test(color) ? `<span style="color:${color}">` : "<span>"));
        paired.set(index, keep("</span>"));
    });
    let result = "";
    let from = 0;
    tags.forEach((tag, index) => {
        const replacement = paired.get(index);
        if (replacement === undefined) return;
        result += line.slice(from, tag.index) + replacement;
        from = (tag.index ?? 0) + tag[0].length;
    });
    return result + line.slice(from);
}

/**
 * `*bold*` and the like. The mark must touch text on the inside and not touch a letter or digit on the outside, as in
 * Jira, so `snake_case_name` and `2*3*4` are left alone while `_*both*_` is both. A run is at most 1000 characters,
 * which also bounds the work.
 */
function applyMark(line: string, mark: string, tag: string, keep: (html: string) => string): string {
    // In the pattern a mark is written once on its own and once inside a character class, where a dash needs a backslash.
    const alone = escapeRegExp(mark);
    const inside = mark === "-" ? "\\-" : alone;
    const before = `(?<![\\p{L}\\p{N}${inside}])${alone}(?=[^\\s${inside}])`;
    const after = `(?<=[^\\s${inside}])${alone}(?![\\p{L}\\p{N}${inside}])`;
    const pattern = new RegExp(`${before}([^\\n]{1,1000}?)${after}`, "gu");
    return line.replace(pattern, (_match, inner: string) => `${keep(`<${tag}>`)}${inner}${keep(`</${tag}>`)}`);
}
