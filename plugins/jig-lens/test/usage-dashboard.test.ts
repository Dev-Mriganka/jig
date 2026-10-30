// The usage view: keys, periods, graphs and models, what it reads, and that it fits and closes.
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelNames } from "../src/usage-names.ts";
import { showDashboard } from "../src/usage-dashboard.ts";
import type { DashboardOptions } from "../src/usage-dashboard.ts";

type Component = { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };

const now = new Date("2026-10-08T06:30:00Z");
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const UP = "\u001b[A";
const DOWN = "\u001b[B";

async function folder(t: TestContext): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jig-lens-usage-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

const entry = (
    id: string,
    at: string,
    input: number,
    extra: Record<string, unknown> = {},
    cost: number | null = 0.01,
) =>
    JSON.stringify({
        type: "message",
        id,
        timestamp: at,
        message: {
            role: "assistant",
            timestamp: Date.parse(at),
            provider: "provider-a",
            model: "model-a",
            usage: { input, ...(cost === null ? {} : { cost: { total: cost } }) },
            ...extra,
        },
    });

/** Opens the view on a fake screen. `text()` is what it shows now; `renders` counts the redraws it asked for. */
function open(root: string, options: Partial<DashboardOptions> = {}, rows = 30) {
    const state: { component?: Component; renders: number; closed: number } = { renders: 0, closed: 0 };
    const ctx = {
        ui: {
            custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) =>
                new Promise<void>((resolve) => {
                    state.component = factory(
                        { terminal: { rows }, requestRender: () => state.renders++ },
                        { fg: (_role: string, value: string) => value },
                        {},
                        () => {
                            state.closed++;
                            resolve();
                        },
                    );
                }),
        },
    } as unknown as ExtensionContext;
    const opened = showDashboard(ctx, { sessionsDir: root, now, ...options });
    const press = (data: string) => state.component?.handleInput(data);
    return { state, opened, press, text: (width = 100) => (state.component?.render(width) ?? []).join("\n") };
}

const until = async (check: () => boolean) => {
    for (let index = 0; index < 300 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check(), "timed out");
};

test("it switches between graphs and models, and cost and tokens, and fits narrow terminals", async (t) => {
    const root = await folder(t);
    await writeFile(
        join(root, "session.jsonl"),
        entry("a", now.toISOString(), 100, { usage: { input: 100, output: 20, cacheRead: 30, cost: { total: 0.15 } } }),
    );
    const view = open(root);
    await until(() => view.text().includes("150 tokens"));
    assert.match(view.text(), /150 tokens · est\. \$0\.15$/m);
    assert.match(view.text(), /Graphs · Metric: cost · 1 usage records/);
    view.press("v");
    assert.match(view.text(), /Models/);
    assert.match(view.text(), /provider-a \/ model-a\s+\$0\.15/);
    view.press("m");
    assert.match(view.text(), /Metric: tokens/);
    assert.match(view.text(), /provider-a \/ model-a\s+150$/m);
    view.press("\t");
    assert.match(view.text(), /Graphs · Metric: tokens/);
    for (const width of [1, 8, 24, 60, 100]) {
        const rows = view.text(width).split("\n");
        assert.ok(rows.length <= 26);
        assert.ok(
            rows.every((row) => visibleWidth(row) <= width),
            `${width}`,
        );
    }
    view.press("q");
    await view.opened;
    assert.equal(view.state.closed, 1);
});

test("the keys are on the last row, the periods on the second, and the one shown is bracketed", async (t) => {
    const root = await folder(t);
    await writeFile(join(root, "s.jsonl"), entry("a", now.toISOString(), 10));
    const view = open(root);
    await until(() => view.text().includes("10 tokens"));
    const rows = view.text().split("\n");
    assert.equal(rows[0], "Usage history");
    assert.equal(rows[1], "[Today]  This week  Last week  30 days  All time");
    assert.equal(rows.at(-1), "←/→ period · v/Tab view · m metric · ↑/↓ scroll · q/Esc close");
    view.press(RIGHT);
    assert.equal(view.text().split("\n")[1], "Today  [This week]  Last week  30 days  All time");
    view.press(LEFT);
    view.press(LEFT);
    assert.equal(
        view.text().split("\n")[1],
        "Today  This week  Last week  30 days  [All time]",
        "the left key wraps round",
    );
    view.press("\u001b");
    await view.opened;
});

test("closing a view that is still loading stops the scan, and it is not drawn again", async (t) => {
    const root = await folder(t);
    for (let index = 0; index < 5; index++)
        await writeFile(join(root, `s${index}.jsonl`), entry(`e${index}`, now.toISOString(), 1));
    const view = open(root);
    view.press("\u001b");
    await view.opened;
    const renders = view.state.renders;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(view.state.closed, 1);
    assert.equal(view.state.renders, renders, "nothing is drawn after it is closed");
});

test("a view that Pi takes down stops the scan too", async (t) => {
    const root = await folder(t);
    await writeFile(join(root, "s.jsonl"), entry("a", now.toISOString(), 10));
    const controller = new AbortController();
    const view = open(root, { signal: controller.signal });
    view.state.component?.dispose?.();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(view.state.renders, 0);
});

test("a signal that aborts closes the view, and one that is aborted already closes it at once", async (t) => {
    const root = await folder(t);
    const controller = new AbortController();
    const view = open(root, { signal: controller.signal });
    controller.abort();
    await view.opened;
    assert.equal(view.state.closed, 1);
    const early = open(root, { signal: AbortSignal.abort() });
    await early.opened;
    assert.equal(early.state.closed, 1);
});

test("it reads only the files the period needs, and scans again for a longer one", async (t) => {
    const root = await folder(t);
    await writeFile(join(root, "recent.jsonl"), entry("r", now.toISOString(), 100));
    await writeFile(join(root, "old.jsonl"), entry("o", "2026-10-01T10:00:00Z", 5000));
    await utimes(join(root, "old.jsonl"), new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
    const view = open(root);
    await until(() => view.text().includes("100 tokens"));
    assert.match(view.text(), /1 session files · 1 older files not read/);
    view.press(RIGHT); // this week: still after the old file
    await until(() => view.text().includes("100 tokens") && /1 older files not read/.test(view.text()));
    view.press(RIGHT); // last week: reaches back to 28 September
    await until(() => view.text().includes("5,000 tokens"));
    assert.match(view.text(), /2 session files/);
    assert.doesNotMatch(view.text(), /older files not read/);
    view.press(LEFT); // back to this week: the wider scan serves it
    assert.match(view.text(), /100 tokens/);
    view.press("q");
    await view.opened;
});

test("names that another plugin sent are shown for the models, merged with the same model's other records", async (t) => {
    const root = await folder(t);
    await writeFile(
        join(root, "s.jsonl"),
        [
            entry("a", now.toISOString(), 100, { provider: "gateway", model: "m-2f9c" }),
            entry("b", now.toISOString(), 20, { provider: "anthropic", model: "Claude Sonnet" }),
            entry("c", now.toISOString(), 7, { provider: "gateway", model: "m-gone" }),
            entry("d", now.toISOString(), 3, { provider: "other", model: "gpt-x" }),
        ].join("\n"),
    );
    const book = createModelNames();
    book.learn({
        models: [
            { recorded: "m-2f9c", name: "Claude Sonnet", provider: "anthropic" },
            { recorded: "unused", name: "x" },
            null,
        ],
    });
    const view = open(root, { names: book.names });
    await until(() => view.text().includes("130 tokens"));
    view.press("v");
    const table = view.text();
    assert.match(table, /anthropic \/ Claude Sonnet\s+\$0\.02/);
    assert.match(table, /gateway \/ m-gone/);
    assert.match(table, /other \/ gpt-x/);
    assert.doesNotMatch(table, /m-2f9c/);
    view.press("q");
    await view.opened;
});

test("a cost that is not known is marked, and not counted as nothing", async (t) => {
    const root = await folder(t);
    await writeFile(
        join(root, "s.jsonl"),
        [entry("a", now.toISOString(), 100, {}, 0.5), entry("b", now.toISOString(), 50, {}, null)].join("\n"),
    );
    const view = open(root);
    await until(() => view.text().includes("150 tokens"));
    assert.match(view.text(), /150 tokens · est\. \$0\.50 \+ 1 unpriced/);
    assert.match(view.text(), /\$0\.50\+/, "the bar's amount says it is a lower bound");
    view.press("v");
    assert.match(view.text(), /provider-a \/ model-a\s+\$0\.50\+/);
    view.press("q");
    await view.opened;
});

test("a period with nothing in it says so", async (t) => {
    const root = await folder(t);
    const view = open(root);
    await until(() => view.text().includes("No usage recorded for this period."));
    assert.match(view.text(), /0 tokens · est\. \$0\.00/);
    assert.match(view.text(), /0 session files/);
    view.press("q");
    await view.opened;
});

test("a long list scrolls, never past its ends, and says which rows are shown", async (t) => {
    const root = await folder(t);
    const lines = Array.from({ length: 30 }, (_, index) =>
        entry(
            `m${index}`,
            now.toISOString(),
            index + 1,
            { model: `model-${String(index).padStart(2, "0")}` },
            (index + 1) / 100,
        ),
    );
    await writeFile(join(root, "s.jsonl"), lines.join("\n"));
    const view = open(root, {}, 20);
    await until(() => view.text().includes("usage records"));
    view.press("v");
    assert.match(view.text(), /1–\d+\/30/);
    const first = view.text();
    view.press(UP);
    assert.equal(view.text(), first, "up from the top stays on the top");
    for (let index = 0; index < 60; index++) view.press(DOWN);
    assert.match(view.text(), /\d+–30\/30/);
    assert.match(view.text(), /model-00/, "the cheapest row is last, and is on screen at the bottom");
    for (let index = 0; index < 60; index++) view.press(UP);
    assert.equal(view.text(), first);
    view.press("q");
    await view.opened;
});

test("text from the files is made safe: an escape in a model name never reaches the screen", async (t) => {
    const root = await folder(t);
    await writeFile(
        join(root, "s.jsonl"),
        entry("a", now.toISOString(), 5, { provider: "p\u001b]0;pwned\u0007", model: "m\u001b[31m" }),
    );
    const view = open(root);
    await until(() => view.text().includes("5 tokens"));
    view.press("v");
    assert.doesNotMatch(view.text(), /\u001b/);
    view.press("q");
    await view.opened;
});

test("a folder that is not there is a view with nothing in it, and says one folder was skipped", async () => {
    const view = open(join(tmpdir(), "jig-lens-no-sessions-here"));
    await until(() => view.text().includes("No usage recorded"));
    assert.match(view.text(), /1 unreadable files or lines skipped/);
    view.press("q");
    await view.opened;
});
