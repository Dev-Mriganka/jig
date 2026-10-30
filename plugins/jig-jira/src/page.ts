// The markup for the page the user opens with `o` on the review screen: the facts of the write and each text rendered the
// way Jira will show it.
//
// jig-core makes the page itself, with the title, a note that the page only shows, and a policy that blocks scripts and
// requests, and it puts this markup in the middle of it after removing every tag that could run, load or navigate. So this
// is a fragment, not a document, and it uses the colours and fonts of jig-core's page (`--line`, `--muted`, `--code`).
import { FLAG_HEADING, flagLines } from "./pointers.ts";
import type { Shown } from "./shown.ts";
import { escapeHtml, renderWiki } from "./wiki.ts";

// Everything is under `.jira-preview`, so nothing here reaches the rest of the page.
const STYLE = `
.jira-preview { --warn-bg: #fff8c5; --warn-line: #d4a72c; --link: #0969da; }
@media (prefers-color-scheme: dark) {
  .jira-preview { --warn-bg: #3a2f0b; --warn-line: #9e6a03; --link: #58a6ff; }
}
.jira-preview .flags {
  background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 6px;
  padding: .5rem 1rem; margin: 0 0 1rem;
}
.jira-preview .flags p { margin: 0 0 .25rem; font-weight: 600; }
.jira-preview .flags ul { margin: 0; }
.jira-preview table.facts th {
  text-align: left; color: var(--muted); font-weight: 500; padding-right: 1rem; vertical-align: top; border: 0;
}
.jira-preview table.facts td { border: 0; }
.jira-preview h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; color: var(--muted); }
.jira-preview .wiki { border: 1px solid var(--line); border-radius: 6px; padding: .5rem 1rem; overflow-wrap: anywhere; }
.jira-preview .wiki :is(h1, h2, h3, h4, h5, h6) { color: inherit; margin: 1rem 0 .5rem; }
.jira-preview .wiki p { margin: .5rem 0; }
.jira-preview pre .title { display: block; color: var(--muted); font-weight: 600; }
.jira-preview .panel { border: 1px solid var(--line); border-radius: 4px; margin: .5rem 0; }
.jira-preview .panel-title { padding: .25rem .75rem; border-bottom: 1px solid var(--line); font-weight: 600; }
.jira-preview .panel-body { padding: 0 .75rem; }
.jira-preview .mention, .jira-preview a { color: var(--link); }
.jira-preview .emoticon, .jira-preview .image, .jira-preview .attachment { color: var(--muted); }
.jira-preview details { margin-top: .75rem; }
.jira-preview summary { cursor: pointer; color: var(--muted); }
`;

function factsTable(rows: Shown["rows"]): string {
    if (rows.length === 0) return "";
    const cells = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`);
    return `<table class="facts">${cells.join("")}</table>`;
}

/** The markup for a preview. Every text is rendered from its wiki source; everything else is escaped text. */
export function htmlOf(shown: Shown): string {
    const listed = flagLines(shown.flags).map((flag) => `<li>${escapeHtml(flag)}</li>`).join("");
    const flags = shown.flags.length === 0
        ? ""
        : `<div class="flags"><p>${escapeHtml(FLAG_HEADING)}</p><ul>${listed}</ul></div>`;
    const notes = shown.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("");
    const texts = shown.texts.map((text) => {
        const replaced = text.replaces === undefined
            ? ""
            : "<details><summary>It replaces this text</summary>" +
                `<div class="wiki">${renderWiki(text.replaces)}</div></details>`;
        const heading = `<h2>${escapeHtml(text.label)}, as Jira will show it</h2>`;
        return `${heading}<div class="wiki">${renderWiki(text.source)}</div>${replaced}`;
    }).join("");
    return `<div class="jira-preview"><style>${STYLE}</style>${flags}${factsTable(shown.rows)}${notes}${texts}</div>`;
}
