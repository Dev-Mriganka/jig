// `/lens usage`: an interactive view of cost and tokens, from Pi's own session files. Periods, bars by hour, day or month or a
// table by model, and cost or tokens. It is loaded only when the command runs, so the rest of the plugin never needs pi-tui.
//
// The interaction was inspired by Thomas Mustier's usage extension (https://github.com/tmustier/pi-extensions); this
// implementation is original.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { clean, money } from "./format.ts";
import { collectHistory, periodRange, summarizeHistory } from "./usage-history.ts";
import type { History, ModelNames, Period } from "./usage-history.ts";

/** The periods, in the order the arrow keys go through them. */
export const PERIODS: ReadonlyArray<{ key: Period; label: string }> = [
    { key: "today", label: "Today" },
    { key: "week", label: "This week" },
    { key: "last-week", label: "Last week" },
    { key: "30-days", label: "30 days" },
    { key: "all", label: "All time" },
];

const count = (value: number): string => value.toLocaleString("en-US");

export interface DashboardOptions {
    /** Pi's sessions folder. */
    sessionsDir: string;
    /** The moment "today" is measured from. */
    now?: Date;
    /** Closes the view and stops the scan. */
    signal?: AbortSignal;
    names?: ModelNames;
}

/** The keys, on the last row. */
export const HELP = "←/→ period · v/Tab view · m metric · ↑/↓ scroll · q/Esc close";

/**
 * Shows the view and returns when it is closed. All reading starts inside the view and stops when it closes. Only the files
 * the period shown can need are read; moving to a longer period scans again, and what was already read is kept.
 */
export async function showDashboard(ctx: ExtensionContext, options: DashboardOptions): Promise<void> {
    const controller = new AbortController();
    try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            let history: History | undefined;
            let failure: string | undefined;
            let period = 0;
            let view: "graphs" | "models" = "graphs";
            let metric: "cost" | "tokens" = "cost";
            let offset = 0;
            let scanned = 0;
            let closed = false;
            let scan: AbortController | undefined;
            let scanSince = Number.POSITIVE_INFINITY;
            const now = options.now ?? new Date();

            const stopAll = () => {
                closed = true;
                scan?.abort();
                controller.abort();
                options.signal?.removeEventListener("abort", close);
            };
            function close() {
                if (closed) return;
                stopAll();
                done();
            }
            options.signal?.addEventListener("abort", close, { once: true });
            const paint = (role: "accent" | "muted" | "success" | "warning", value: string) =>
                theme.fg(role, clean(value));

            function load() {
                const need = +periodRange(PERIODS[period]?.key ?? "today", now).start;
                if (scanSince <= need && failure === undefined) return;
                scan?.abort();
                history = undefined;
                failure = undefined;
                scanned = 0;
                scanSince = need;
                scan = new AbortController();
                const mine = scan;
                void collectHistory({
                    sessionsDir: options.sessionsDir,
                    since: need,
                    signal: AbortSignal.any([controller.signal, mine.signal]),
                    onProgress(files) {
                        scanned = files;
                        if (!closed && files % 25 === 0) tui.requestRender();
                    },
                })
                    .then((value) => {
                        if (!closed && scan === mine) {
                            history = value;
                            tui.requestRender();
                        }
                    })
                    .catch((error: unknown) => {
                        if (!closed && scan === mine) {
                            failure = `Could not read the session files: ${clean(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
                            tui.requestRender();
                        }
                    });
            }

            const component = {
                invalidate() {},
                dispose() {
                    stopAll();
                },
                handleInput(data: string) {
                    if (matchesKey(data, Key.escape) || data === "q") {
                        close();
                        return;
                    }
                    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
                        period = (period + (matchesKey(data, Key.left) ? -1 : 1) + PERIODS.length) % PERIODS.length;
                        offset = 0;
                        load();
                    } else if (data === "v" || matchesKey(data, Key.tab)) {
                        view = view === "graphs" ? "models" : "graphs";
                        offset = 0;
                    } else if (data === "m") {
                        metric = metric === "cost" ? "tokens" : "cost";
                        offset = 0;
                    } else if (matchesKey(data, Key.down)) {
                        offset++;
                    } else if (matchesKey(data, Key.up)) {
                        offset = Math.max(0, offset - 1);
                    }
                    tui.requestRender();
                },
                render(width: number): string[] {
                    const height = Math.max(1, Math.min(24, (tui.terminal?.rows ?? 24) - 4));
                    const shown = PERIODS[period] ?? PERIODS[0];
                    const rows = [
                        paint("accent", "Usage history"),
                        PERIODS.map((p, i) =>
                            i === period ? paint("accent", `[${p.label}]`) : paint("muted", p.label),
                        ).join("  "),
                    ];
                    if (history === undefined) {
                        rows.push(
                            paint(
                                failure === undefined ? "muted" : "warning",
                                failure ?? `Scanning Pi's session files… ${scanned} files`,
                            ),
                        );
                    } else if (shown !== undefined) {
                        const summary = summarizeHistory(history.records, shown.key, now, options.names);
                        rows.push(
                            paint(
                                "success",
                                `${count(summary.tokens)} tokens · est. ${money(summary.cost)}${summary.unknownCosts > 0 ? ` + ${count(summary.unknownCosts)} unpriced` : ""}`,
                            ),
                        );
                        rows.push(
                            paint(
                                "muted",
                                `${view === "graphs" ? "Graphs" : "Models"} · Metric: ${metric} · ${count(summary.records)} usage records`,
                            ),
                        );
                        const slots = Math.max(0, height - rows.length - 2);
                        const amount = (item: { cost: number; tokens: number; unknownCosts: number }) =>
                            metric === "cost"
                                ? `${money(item.cost)}${item.unknownCosts > 0 ? "+" : ""}`
                                : count(item.tokens);
                        let body: string[];
                        if (view === "graphs") {
                            const max = Math.max(1e-12, ...summary.buckets.map((b) => b[metric]));
                            const barWidth = Math.max(0, width - 29);
                            body = summary.buckets.map((b) => {
                                const label = truncateToWidth(clean(b.label), 12, "").padEnd(12);
                                const bar = "━".repeat(Math.round((b[metric] / max) * barWidth));
                                return `${label} ${paint("accent", bar)} ${amount(b)}`;
                            });
                        } else {
                            const models = [...summary.models].sort((a, b) => b[metric] - a[metric]);
                            body = models.map((m) => {
                                const value = amount(m);
                                const label = truncateToWidth(
                                    clean(`${m.provider} / ${m.model}`),
                                    Math.max(1, width - value.length - 2),
                                    "…",
                                );
                                return `${label}  ${paint("success", value)}`;
                            });
                        }
                        offset = Math.min(offset, Math.max(0, body.length - slots));
                        rows.push(
                            ...(body.length > 0
                                ? body.slice(offset, offset + slots)
                                : [paint("muted", "No usage recorded for this period.")]),
                        );
                        const notes = [
                            `${count(history.files)} session files`,
                            history.older > 0 ? `${count(history.older)} older files not read` : "",
                            history.skipped > 0 ? `${count(history.skipped)} unreadable files or lines skipped` : "",
                            body.length > slots
                                ? `${offset + 1}–${Math.min(body.length, offset + slots)}/${body.length}`
                                : "",
                        ].filter((note) => note !== "");
                        rows.push(paint("muted", notes.join(" · ")));
                    }
                    rows.push(paint("muted", HELP));
                    return rows.slice(0, height).map((row) => truncateToWidth(row, Math.max(0, width), ""));
                },
            };
            if (options.signal?.aborted) {
                queueMicrotask(close);
                return component;
            }
            load();
            return component;
        });
    } finally {
        controller.abort();
    }
}
