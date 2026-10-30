// The footer: what each part shows and in which colour, how it fits a row, and how it is given to Pi.
import assert from "node:assert/strict";
import test from "node:test";
import { cacheLabel, cacheState } from "../src/cache.ts";
import { DEFAULT_FOOTER } from "../src/config.ts";
import type { FooterSettings } from "../src/config.ts";
import { cellWidth, contextCount, count, installFooter, partsOf, renderFooter } from "../src/footer.ts";
import type { FooterFrame } from "../src/footer.ts";
import type { PluginSegment } from "../src/segments.ts";
import type { SessionUsage } from "../src/usage.ts";
import { FakePi, tempAgentDir } from "./support.ts";

const usage = (extra: Partial<SessionUsage> = {}): SessionUsage => ({
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    compactions: 0,
    estimatedCost: 1.5,
    ...extra,
});
const tagged = (value: string, role: string) => `[${role}:${value}]`;
const settings = (extra: Partial<FooterSettings> = {}): FooterSettings => ({ ...DEFAULT_FOOTER, ...extra });
const frame = (extra: Partial<FooterFrame> = {}): FooterFrame => ({
    settings: settings(),
    model: "Opus",
    thinking: "high",
    usage: usage(),
    paint: tagged,
    ...extra,
});
const row = (extra: Partial<FooterFrame> = {}, width = 300) => renderFooter(width, frame(extra))[0] ?? "";
const plain = (extra: Partial<FooterFrame> = {}, width = 300) =>
    renderFooter(width, frame({ paint: undefined, ...extra }))[0] ?? "";
const NOW = Date.parse("2026-10-16T12:00:00Z");

test("context shows absolute tokens, amber from 150k and red from 250k, whatever the window", () => {
    assert.match(
        row({ usage: usage({ contextTokens: 182_400, contextPercent: 18.2, contextWindow: 1_000_000 }) }),
        /\[warning:ctx 182k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 149_999, contextPercent: 15, contextWindow: 1_000_000 }) }),
        /\[toolTitle:ctx 150k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 150_000, contextPercent: 15, contextWindow: 1_000_000 }) }),
        /\[warning:ctx 150k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 250_000, contextPercent: 25, contextWindow: 1_000_000 }) }),
        /\[error:ctx 250k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 42_000, contextPercent: 4.2, contextWindow: 1_000_000 }) }),
        /\[toolTitle:ctx 42k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 3_400, contextPercent: 0.3, contextWindow: 1_000_000 }) }),
        /\[toolTitle:ctx 3\.4k\]/,
    );
});

test("the limits are configurable, in tokens and in share of the window", () => {
    const sized = { usage: usage({ contextTokens: 90_000, contextPercent: 9, contextWindow: 1_000_000 }) };
    const limits = (warnTokens: number, highTokens: number) => ({
        settings: settings({ context: { ...DEFAULT_FOOTER.context, warnTokens, highTokens } }),
    });
    assert.match(row({ ...sized, ...limits(80_000, 120_000) }), /\[warning:ctx 90k\]/);
    assert.match(row({ ...sized, ...limits(20_000, 60_000) }), /\[error:ctx 90k\]/);
    const shared = { usage: usage({ contextTokens: 90_000, contextPercent: 45, contextWindow: 200_000 }) };
    assert.match(
        row({
            ...shared,
            settings: settings({ context: { ...DEFAULT_FOOTER.context, warnPercent: 40, highPercent: 60 } }),
        }),
        /\[warning:ctx 90k\]/,
    );
    assert.match(
        row({
            ...shared,
            settings: settings({ context: { ...DEFAULT_FOOTER.context, warnPercent: 20, highPercent: 40 } }),
        }),
        /\[error:ctx 90k\]/,
    );
});

test("a small window still warns by its share of the window, which the absolute limits would miss", () => {
    assert.match(
        row({ usage: usage({ contextTokens: 140_000, contextPercent: 70, contextWindow: 200_000 }) }),
        /\[warning:ctx 140k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 185_000, contextPercent: 92.5, contextWindow: 200_000 }) }),
        /\[error:ctx 185k\]/,
    );
    assert.match(
        row({ usage: usage({ contextTokens: 120_000, contextPercent: 60, contextWindow: 200_000 }) }),
        /\[toolTitle:ctx 120k\]/,
    );
});

test("sizes Pi has not measured show as ?, and only a share is shown when the size is unknown", () => {
    assert.match(row({ usage: usage() }), /ctx \?/);
    assert.match(row({ usage: usage({ contextPercent: 40 }) }), /\[toolTitle:ctx 40%\]/);
    assert.match(
        row({ usage: usage({ contextTokens: 210_000, contextPercent: 105, contextWindow: 200_000 }) }),
        /\[error:ctx 210k OVER\]/,
    );
    assert.match(row({ usage: usage({ contextPercent: 12 }) }), /ctx 12%/);
    assert.equal(contextCount(999), "999");
    assert.equal(contextCount(1000), "1k");
    assert.equal(contextCount(1_250_000), "1.3M");
    assert.equal(contextCount(99_600), "100k");
    assert.equal(count(850), "850");
    assert.equal(count(3400), "3.4k");
});

test("cache shows the time left, turns amber in the last minute and says cold after expiry", () => {
    assert.match(row({ cache: { state: "warm", remainingMs: 221_000 } }), /\[muted:cache 3:41\]/);
    assert.match(row({ cache: { state: "warm", remainingMs: 59_000 } }), /\[warning:cache 0:59\]/);
    assert.match(row({ cache: { state: "cold" } }), /\[muted:cache cold\]/);
    assert.doesNotMatch(row({}), /cache/);
    assert.equal(cacheLabel({ state: "warm", remainingMs: 3_599_100 }), "cache 60:00");
    assert.equal(cacheLabel({ state: "warm", remainingMs: 61_000 }), "cache 1:01");
    assert.equal(cacheLabel({ state: "warm", remainingMs: 100 }), "cache 0:01");
});

test("cost has two decimals unless you ask for more, and says so when a model has no price", () => {
    assert.match(row({}), /\[mdQuoteBorder:est\. \$1\.50\]/);
    assert.match(row({ settings: settings({ costDecimals: 4 }) }), /est\. \$1\.5000/);
    assert.match(
        row({ settings: settings({ costDecimals: 3 }), usage: usage({ estimatedCost: 0.12345 }) }),
        /est\. \$0\.123\]/,
    );
    assert.match(row({ usage: usage({ estimatedCost: undefined }) }), /\[mdQuoteBorder:est\. \$\?\]/);
});

test("tokens count what went in, with cache writes, and what came out", () => {
    assert.match(
        row({ usage: usage({ input: 1200, cacheWrite: 300, output: 900, cacheRead: 99_999 }) }),
        /\[muted:↑1\.5k ↓900\]/,
    );
});

test("every part has its colour, and you can change it", () => {
    const full = row({
        usage: usage({ contextTokens: 1000, contextPercent: 1, contextWindow: 100_000 }),
        cache: { state: "warm", remainingMs: 120_000 },
        statuses: new Map([["a", "ok"]]),
        branch: "main",
        cwd: "/work/orders-api",
        settings: settings({
            segments: ["model", "thinking", "context", "cache", "cost", "tokens", "branch", "cwd", "statuses"],
        }),
    });
    for (const expected of [
        "[mdHeading:Opus]",
        "[warning:high]",
        "[toolTitle:ctx 1k]",
        "[muted:cache 2:00]",
        "[mdQuoteBorder:est. $1.50]",
        "[muted:↑100 ↓20]",
        "[accent:main]",
        "[muted:orders-api]",
        "[success:ok]",
    ]) {
        assert.ok(full.includes(expected), `${expected} in ${full}`);
    }
    const recoloured = row({
        settings: settings({ colors: { ...DEFAULT_FOOTER.colors, model: "accent", cost: "toolOutput" } }),
    });
    assert.match(recoloured, /\[accent:Opus\]/);
    assert.match(recoloured, /\[toolOutput:est\. \$1\.50\]/);
});

test("the parts are shown in the order you list them, and only the ones you list", () => {
    assert.equal(plain({ settings: settings({ segments: ["cost", "model"] }) }), "est. $1.50 · Opus");
    assert.equal(plain({ settings: settings({ segments: ["model"] }) }), "Opus");
    assert.equal(
        plain({ settings: settings({ segments: ["thinking", "tokens", "model"] }) }),
        "high · ↑100 ↓20 · Opus",
    );
});

test("the full default footer reads like the README's example", () => {
    const full = plain({
        model: "Claude Opus 5.5",
        usage: usage({
            contextTokens: 182_000,
            contextPercent: 18,
            contextWindow: 1_000_000,
            input: 12_000,
            cacheWrite: 400,
            output: 3_100,
            estimatedCost: 4.21,
        }),
        cache: { state: "warm", remainingMs: 221_000 },
    });
    assert.equal(full, "Claude Opus 5.5 · high · ctx 182k · cache 3:41 · est. $4.21 · ↑12.4k ↓3.1k");
});

test("the separator is yours, is drawn in the muted colour, and counts toward the width", () => {
    assert.equal(plain({ settings: settings({ separator: " | " }) }), "Opus | high | ctx ? | est. $1.50 | ↑100 ↓20");
    assert.match(row({ settings: settings({ separator: "·" }) }), /Opus\]\[muted:·\]\[warning:high\]/);
    const wide = settings({ separator: " ┃┃ " });
    for (let width = 1; width <= 60; width++) {
        const rows = renderFooter(width, frame({ settings: wide, paint: undefined }));
        assert.equal(rows.length, 1);
        assert.ok(cellWidth(rows[0] ?? "") <= width, `${width}: ${rows[0]}`);
    }
});

test("branch and cwd show the branch and the folder's name, and nothing outside a repository", () => {
    const set = settings({ segments: ["model", "branch", "cwd"] });
    assert.equal(
        plain({ settings: set, branch: "feature/PROJ-123", cwd: "/work/orders-api" }),
        "Opus · feature/PROJ-123 · orders-api",
    );
    assert.equal(plain({ settings: set, branch: null, cwd: "/work/orders-api/" }), "Opus · orders-api");
    assert.equal(plain({ settings: set, branch: undefined, cwd: undefined }), "Opus");
});

test("statuses are what other extensions set, one after another by key, with escapes removed", () => {
    const statuses = new Map([
        ["b", "second"],
        ["a", "\u001b[31mfirst\u001b[0m"],
        ["c", "  "],
    ]);
    assert.equal(plain({ statuses, settings: settings({ segments: ["model", "statuses"] }) }), "Opus · first · second");
    assert.match(
        row({ statuses, settings: settings({ segments: ["statuses"] }) }),
        /\[success:first\] ?.*\[success:second\]/,
    );
});

test("a model with no name is `No model`, and thinking with no level is `off`", () => {
    assert.match(plain({ model: undefined, thinking: undefined }), /^No model · off · /);
});

test("every width keeps one row inside the terminal and gives up tokens, cache, branch, cwd, then plugin parts, in that order", () => {
    const plugins: PluginSegment[] = [{ id: "spend", label: "Oct $203 / $200", tone: "error", order: 0 }];
    const many: Partial<FooterFrame> = {
        settings: settings({
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
        }),
        cache: { state: "warm", remainingMs: 221_000 },
        branch: "release-branch",
        cwd: "/work/orders-api",
        plugins,
        statuses: new Map([["x", "queue 3"]]),
        usage: usage({
            contextTokens: 182_000,
            contextPercent: 18,
            contextWindow: 1_000_000,
            input: 1200,
            cacheWrite: 300,
            output: 900,
        }),
        now: NOW,
    };
    for (let width = 1; width <= 160; width++) {
        const rows = renderFooter(width, frame({ ...many, model: "Claude Opus 5.5", paint: undefined }));
        assert.equal(rows.length, 1);
        assert.ok(cellWidth(rows[0] ?? "") <= width, `${width}: ${rows[0]}`);
    }
    const full = plain({ ...many, model: "Claude Opus 5.5" }, 300);
    assert.equal(
        full,
        "Claude Opus 5.5 · high · ctx 182k · cache 3:41 · est. $1.50 · ↑1.5k ↓900 · release-branch · orders-api · Oct $203 / $200 · queue 3",
    );
    const gone: string[] = [];
    for (let width = 160; width >= 20; width--) {
        const shown = renderFooter(width, frame({ ...many, model: "Claude Opus 5.5", paint: undefined }))[0] ?? "";
        for (const piece of ["↑1.5k", "cache 3:41", "release-branch", "orders-api", "Oct $203"])
            if (!shown.includes(piece) && !gone.includes(piece)) gone.push(piece);
    }
    assert.deepEqual(gone, ["↑1.5k", "cache 3:41", "release-branch", "orders-api", "Oct $203"]);
});

test("dropFirst is yours: a part you list is given up in your order, and one you leave out is kept", () => {
    const set = settings({ dropFirst: ["cost"] });
    const shown = (width: number) => plain({ settings: set }, width);
    assert.equal(shown(43), "Opus · high · ctx ? · est. $1.50 · ↑100 ↓20");
    assert.equal(shown(42), "Opus · high · ctx ? · ↑100 ↓20", "cost goes first now, and tokens stay");
    const none = settings({ dropFirst: [] });
    for (let width = 1; width <= 80; width++)
        assert.ok(cellWidth(plain({ settings: none }, width)) <= width, String(width));
});

test("the model's name is cut to what is left, down to 8 cells, before another part is given up", () => {
    const long = "us.anthropic.claude-opus-4-6-v1";
    const set = settings({ segments: ["model", "thinking", "cost", "tokens"], dropFirst: ["tokens"] });
    const wide = plain({ model: long, settings: set }, 200);
    assert.ok(wide.startsWith(long));
    const tail = " · high · est. $1.50 · ↑100 ↓20";
    const cut = plain({ model: long, settings: set }, cellWidth(`us.anthropic…${tail}`));
    assert.equal(cut, `us.anthropic…${tail}`);
    // At 7 cells of name the tokens go instead, and the name grows back.
    const narrow = cellWidth(`us.anth…${tail}`) - 1;
    const instead = plain({ model: long, settings: set }, narrow);
    assert.ok(!instead.includes("↑100"), instead);
    assert.ok(instead.startsWith("us.anthropic.c") && instead.includes("est. $1.50"), instead);
    assert.ok(cellWidth(instead) <= narrow);
});

test("with no model part the others simply go, and a row that cannot hold what is left holds less of it", () => {
    const set = settings({ segments: ["cost", "tokens"], dropFirst: ["tokens"] });
    assert.equal(plain({ settings: set }, 40), "est. $1.50 · ↑100 ↓20");
    assert.equal(plain({ settings: set }, 15), "est. $1.50");
    assert.equal(plain({ settings: set }, 6), "est. …");
    assert.deepEqual(renderFooter(0, frame()), []);
    assert.deepEqual(renderFooter(Number.NaN, frame()), []);
});

test("plugin parts are shown as given, and a tone is a Pi text role", () => {
    const plugins: PluginSegment[] = [
        { id: "c", label: "sea", tone: "success", order: 0 },
        { id: "a", label: "ay", tone: "normal", order: 1 },
        { id: "b", label: "bee", tone: "warning", order: 1 },
        { id: "d", label: "dee", tone: "muted", order: 2 },
        { id: "e", label: "eee", tone: "accent", order: 3 },
        { id: "f", label: "eff", tone: "error", order: 4 },
    ];
    const shown = row({ plugins, settings: settings({ segments: ["plugins"] }) });
    assert.equal(
        shown.replace(/\[muted: · \]/g, "|"),
        "[success:sea]|[text:ay]|[warning:bee]|[muted:dee]|[accent:eee]|[error:eff]",
    );
    const recoloured = row({
        plugins: plugins.slice(1, 2),
        settings: settings({ segments: ["plugins"], colors: { ...DEFAULT_FOOTER.colors, plugins: "mdLink" } }),
    });
    assert.equal(recoloured, "[mdLink:ay]");
});

test("a label is one row of text: escapes, bidirectional controls and lone surrogates never reach the terminal", () => {
    const hostile = {
        model: "\u001b]52;c;evil\u0007A👩‍💻中é‮",
        thinking: "high",
        usage: usage({ contextPercent: 200 }),
    };
    for (let width = 1; width < 100; width++) {
        const rows = renderFooter(width, frame({ ...hostile, paint: undefined }));
        assert.equal(rows.length, 1);
        assert.ok(cellWidth(rows[0] ?? "") <= width);
        assert.doesNotMatch(rows[0] ?? "", /\u001b|‮|evil|\ud83d(?![\udc00-\udfff])/u);
    }
});

test("flag and keycap emoji stay inside Pi's own measure of the width", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    for (const model of ["Model 🇮🇳", "Model 1️⃣", "Model 👩‍💻"]) {
        for (let width = 1; width < 100; width++) {
            const shown =
                renderFooter(width, frame({ model, usage: usage({ contextPercent: 12 }), paint: undefined }))[0] ?? "";
            assert.ok(visibleWidth(shown) <= width, `${model} exceeds ${width} cells: ${shown}`);
        }
    }
});

test("parts are made only for the segments listed", () => {
    assert.deepEqual(
        partsOf(frame({ settings: settings({ segments: ["model", "cost"] }) })).map((part) => part.id),
        ["model", "cost"],
    );
});

// ---- the cache clock ----------------------------------------------------------------------------------------------------

const reply = (ago: number, used: object = { cacheRead: 1000, cacheWrite: 10 }, extra: object = {}) => ({
    type: "message",
    message: { role: "assistant", stopReason: "stop", timestamp: NOW - ago, usage: used, ...extra },
});

test("cache time left counts from the last reply's start, for the active retention", () => {
    const model = { promptCache: { short: 300, long: 3600 } };
    assert.deepEqual(cacheState([reply(79_000)], model, {}, NOW), { state: "warm", remainingMs: 221_000 });
    assert.deepEqual(cacheState([reply(79_000)], model, { PI_CACHE_RETENTION: "long" }, NOW), {
        state: "warm",
        remainingMs: 3_521_000,
    });
    assert.deepEqual(cacheState([reply(300_000)], model, {}, NOW), { state: "cold" });
    assert.deepEqual(cacheState([reply(400_000)], model, {}, NOW), { state: "cold" });
    assert.deepEqual(cacheState([reply(400_000)], model, { PI_CACHE_RETENTION: "long" }, NOW), {
        state: "warm",
        remainingMs: 3_200_000,
    });
    assert.deepEqual(
        cacheState([reply(79_000)], undefined, {}, NOW),
        { state: "warm", remainingMs: 221_000 },
        "a model that declares nothing gets the 5-minute default",
    );
    assert.equal(
        cacheState([reply(79_000)], { promptCache: { short: 300 } }, { PI_CACHE_RETENTION: "long" }, NOW),
        undefined,
        "no lifetime for the active tier: nothing to count",
    );
});

test("cache is hidden without a reply or when the last reply used none; a refresh, a switch and a compaction move it", () => {
    const model = { promptCache: { short: 300, long: 3600 } };
    assert.equal(cacheState([], model, {}, NOW), undefined);
    assert.equal(cacheState([{ type: "model_change" }], model, {}, NOW), undefined);
    assert.equal(cacheState([reply(1000, { cacheRead: 0, cacheWrite: 0 })], model, {}, NOW), undefined);
    assert.deepEqual(
        cacheState([reply(1000), reply(500, {}, { stopReason: "error" })], model, {}, NOW),
        { state: "warm", remainingMs: 299_000 },
        "a failed reply never touched the cache",
    );
    assert.deepEqual(
        cacheState(
            [reply(250_000), { type: "usage", kind: "cache_warm", timestamp: new Date(NOW - 20_000).toISOString() }],
            model,
            {},
            NOW,
        ),
        { state: "warm", remainingMs: 280_000 },
    );
    assert.deepEqual(
        cacheState(
            [reply(10_000), { type: "usage", kind: "other", timestamp: new Date(NOW).toISOString() }],
            model,
            {},
            NOW,
        ),
        { state: "warm", remainingMs: 290_000 },
    );
    assert.deepEqual(cacheState([reply(10_000), { type: "model_change" }], model, {}, NOW), { state: "cold" });
    assert.deepEqual(cacheState([reply(10_000), { type: "compaction" }], model, {}, NOW), { state: "cold" });
    assert.deepEqual(
        cacheState([reply(10_000), { type: "compaction" }, reply(1000)], model, {}, NOW),
        { state: "warm", remainingMs: 299_000 },
        "the reply after a compaction wrote a new cache",
    );
    assert.equal(
        cacheState(
            [{ type: "message", message: { role: "assistant", usage: { cacheRead: 5 }, timestamp: Number.NaN } }],
            model,
            {},
            NOW,
        ),
        undefined,
    );
    assert.equal(cacheState([null, 3, "x"], model, {}, NOW), undefined, "an entry that is not an object says nothing");
});

// ---- in Pi --------------------------------------------------------------------------------------------------------------

function piWith(t: test.TestContext, extra: (pi: FakePi) => void = () => {}) {
    const pi = new FakePi({ agentDir: tempAgentDir(t) });
    extra(pi);
    return pi;
}

test("the countdown draws again when the shown second changes while a cache is warm, and stops when it is cold or the footer goes", async (t) => {
    const pi = piWith(t, (fake) => {
        fake.model = { name: "Opus", promptCache: { short: 300 } };
        fake.entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    timestamp: Date.now() - 299_600,
                    usage: { cacheRead: 5, cacheWrite: 0 },
                },
            },
        ];
    });
    const handle = installFooter(pi.api, pi.ctx, { settings: () => DEFAULT_FOOTER, plugins: () => [], env: {} });
    // 400 ms are left, so the cache is warm at the first draw even when the machine is slow, and cold 500 ms later.
    assert.match(pi.row(200), /cache 0:01/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(pi.renders, 1, "one draw when the shown second changed");
    assert.match(pi.row(200), /cache cold/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(pi.renders, 1, "no timer once the cache is cold");
    (pi.entries[0] as { message: { timestamp: number } }).message.timestamp = Date.now() - 1000;
    assert.match(pi.row(200), /cache 4:5\d/);
    handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(pi.renders, 1, "taking the footer away cancels the pending tick");
});

test("no clock runs, and no entries are read for the cache, when the footer has no cache part", (t) => {
    const pi = piWith(t, (fake) => {
        fake.entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    timestamp: Date.now() - 1000,
                    usage: { cacheRead: 5 },
                },
            },
        ];
    });
    installFooter(pi.api, pi.ctx, {
        settings: () => settings({ segments: ["model", "cost"] }),
        plugins: () => [],
        env: {},
    });
    assert.doesNotMatch(pi.row(200), /cache/);
});

test("the footer is drawn in the colours of the theme in use, and reads the session when it is drawn", (t) => {
    const pi = piWith(t, (fake) => {
        fake.statuses = new Map([["x", "queue 3"]]);
    });
    installFooter(pi.api, pi.ctx, {
        settings: () => DEFAULT_FOOTER,
        plugins: () => [{ id: "spend", label: "Oct $1", tone: "error", order: 0 }],
        env: {},
    });
    const first = pi.row(300);
    assert.ok(first.includes("<mdHeading>Fixture Model</>"), first);
    assert.ok(first.includes("<warning>high</>"));
    assert.ok(first.includes("<error>Oct $1</>"));
    assert.ok(first.includes("<success>queue 3</>"));
    pi.thinking = "low";
    pi.model = { name: "Other" };
    assert.ok(pi.row(300).includes("<warning>low</>") && pi.row(300).includes("Other"));
});

test("the footer watches the branch only while it is shown", (t) => {
    const pi = piWith(t);
    const handle = installFooter(pi.api, pi.ctx, {
        settings: () => settings({ segments: ["model", "branch"] }),
        plugins: () => [],
        env: {},
    });
    assert.equal(pi.branchListeners.size, 1);
    assert.ok(pi.row().includes("main"));
    pi.branch = "feature/x";
    for (const listener of pi.branchListeners) listener();
    assert.equal(pi.renders, 1);
    assert.ok(pi.row().includes("feature/x"));
    handle.dispose();
    assert.equal(pi.branchListeners.size, 0);
});

test("a context that has gone stale draws nothing, and does not throw into Pi's renderer", (t) => {
    const pi = piWith(t);
    installFooter(pi.api, pi.ctx, { settings: () => DEFAULT_FOOTER, plugins: () => [], env: {} });
    Object.defineProperty(pi.ctx, "model", {
        get() {
            throw new Error("This extension ctx is stale after session replacement or reload");
        },
    });
    assert.deepEqual(pi.footer?.render(100), []);
});

test("the session estimate includes tools, summaries and standalone usage across model switches", (t) => {
    const pi = piWith(t, (fake) => {
        fake.entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    provider: "a",
                    model: "model-a",
                    usage: { input: 100, output: 20, cacheWrite: 5, cost: { total: 0.1 } },
                },
            },
            {
                type: "message",
                message: { role: "toolResult", usage: { input: 10, output: 4, cost: { total: 0.02 } } },
            },
            { type: "usage", kind: "future-operation", usage: { cacheRead: 50, cost: { total: 0.03 } } },
            { type: "compaction", usage: { output: 3, cost: { total: 0.004 } } },
            { type: "branch_summary", usage: { output: 2, cost: { total: 0.005 } } },
        ];
        fake.model = { name: "Model B" };
    });
    installFooter(pi.api, pi.ctx, { settings: () => settings({ costDecimals: 4 }), plugins: () => [], env: {} });
    const shown = pi.row(300);
    assert.match(shown, /est\. \$0\.1590/);
    assert.match(shown, /↑115 ↓29/);
});

test("one reply with no price makes the whole estimate unknown", (t) => {
    const pi = piWith(t, (fake) => {
        fake.entries = [
            { type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.5 } } } },
            { type: "message", message: { role: "assistant", usage: { input: 1, output: 1 } } },
        ];
    });
    installFooter(pi.api, pi.ctx, { settings: () => DEFAULT_FOOTER, plugins: () => [], env: {} });
    assert.match(pi.row(300), /est\. \$\?/);
});
