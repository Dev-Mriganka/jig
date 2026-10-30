# Writing the docs

These are the rules for every Markdown page in this repository. They exist
so that a page is easy on the eyes and a reader can learn the system from it.
Plain words beat clever ones.

Plugin READMEs are the specifications that the code follows (see
[AGENTS.md](../AGENTS.md)), so a page that is hard to read is a specification
that is hard to check.

## The rules

1. **Open with what it is and why,** in one or two plain sentences, before any
   detail. A reader who stops after that sentence still knows what the page is
   about.
2. **Keep paragraphs short:** at most about four lines (350 characters), one
   idea each. A longer paragraph is split, or turned into bullets.
3. **Keep table cells short:** at most about 100 characters. When a row needs
   more, keep a short cell and put the detail in a list or a paragraph under the
   table, or on a page of its own in `docs/`.
4. **Use a list for three or more parallel items,** with a **bold lead-in**
   when the items are long, so a reader can scan down the lead-ins.
5. **Give every plugin README the same shape,** as
   [jig-workflow](../plugins/jig-workflow/README.md) does (see below).
6. **Use generic examples only:** `staging`, `orders-api`, `PROJ-123`,
   `api.staging.example.com`, GitHub Actions. Never a real company, host or
   person.
7. **Link a glossary term on its first use in a page,** where that helps. The
   [glossary](glossary.md) says what each term means.
8. **Tag every code block:** `json`, `ts`, `text` or `bash`. A tag turns on
   colour and tells the reader what they are looking at.
9. **Do not re-wrap lines that are fine.** GitHub ignores line breaks inside a
   paragraph, and a re-wrapped paragraph hides the real change in a diff.

## The README shape

A plugin README is about 120 lines. In this order:
1. `# jig-x: what it does`, the title line;
2. the status line, `**Status: built.**` or `**Status: design.**`;
3. what it is, with a short example;
4. the diagram, with an italic caption that says what it shows;
5. the tools or commands, as tables;
6. **Rules**, **Configure** and **Company part (in the company plugin)**;
7. **Later**, only when something is planned;
8. **Layout** and **More detail**, which links every page of the plugin's
   `docs/`.

Detail that would take it past that goes to `plugins/<name>/docs/`. A detail
page opens with one sentence on what it covers, and ends with a link back to
the README.

## Diagrams

A diagram shows the plugin's real mechanism, not boxes with names. Draw it as
an SVG in `docs/img/` and copy the frame, fonts and colours from
[lens-flow.svg](img/lens-flow.svg).
- **Labels are a few words.** Text is 11 to 13 px at drawn scale.
- **Arrows say what moves,** such as `query` or `masked lines`.
- **Each file has its own marker ids,** so two diagrams on one page never mix.
- **It has `role="img"` and an `aria-label`** that says what the picture shows.

## Checks

A test, `plugins/jig-core/test/docs-links.test.ts`, fails when a relative link
or an `#anchor` in any Markdown file points at nothing. Some other tests read
README tables, such as the tool tables of `jig-git` and `jig-jira`, so change
a table and its test together.
