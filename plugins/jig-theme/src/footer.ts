// The one-line footer: the parts you chose, in your order, in the colours of the theme, and never wider than the terminal.
//
// A part is a label with the Pi text role it is drawn in. On a narrow terminal parts go in the order of `dropFirst`, and the
// model's name is cut to what is left of the row, down to 8 cells; only when nothing in `dropFirst` is left is it cut further.
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cacheLabel, cacheState } from "./cache.ts";
import type { CacheState } from "./cache.ts";
import type { ContextLimits, FooterSettings, SegmentId } from "./config.ts";
import type { ForegroundRole } from "./roles.ts";
import { toneRole } from "./segments.ts";
import type { PluginSegment } from "./segments.ts";
import { collectUsage, number } from "./usage.ts";
import type { SessionUsage } from "./usage.ts";
import { cellWidth, clean, fit } from "./width.ts";

export { cellWidth, fit };

/** One thing the footer shows. `id` is the footer part it belongs to; a part such as `statuses` can show several. */
export interface Part {
    id: SegmentId;
    label: string;
    role: ForegroundRole;
}

export interface FooterFrame {
    settings: FooterSettings;
    usage: SessionUsage;
    model?: string;
    thinking?: string;
    statuses?: ReadonlyMap<string, string>;
    /** The git branch, or null/undefined outside a repository. */
    branch?: string | null;
    /** The folder Pi runs in. Its last part is shown. */
    cwd?: string;
    plugins?: readonly PluginSegment[];
    /** Time left on the prompt cache; absent when there is nothing to show. */
    cache?: CacheState;
    now?: number;
    /** Draws a label in a Pi text role. Without it the footer is plain text, which is what a test reads. */
    paint?: (value: string, role: ForegroundRole) => string;
}

/** 850, 3.4k, 1.2M. */
export function count(value: number): string {
    return value < 1000
        ? String(value)
        : value < 1_000_000
          ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
          : `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 182k, 3.4k, 850, 1.2M: whole thousands once a size is in the tens of thousands, where tenths are noise. */
export function contextCount(value: number): string {
    return value < 1000
        ? String(Math.round(value))
        : value < 10_000
          ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
          : value < 1_000_000
            ? `${Math.round(value / 1000)}k`
            : `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * The context size in tokens, drawn in the worse of two measures: its absolute size (what matters on a 1M window, where a
 * share never warns while every turn is already expensive) and its share of the window (which still protects a small
 * one). A size Pi has not measured yet, right after a compaction, shows as `ctx ?`.
 */
function contextPart(usage: SessionUsage, limits: ContextLimits, normal: ForegroundRole): Part {
    const percent = number(usage.contextPercent);
    const tokens =
        number(usage.contextTokens) ??
        (percent !== undefined && usage.contextWindow ? (percent / 100) * usage.contextWindow : undefined);
    const byShare =
        percent === undefined ? 0 : percent >= limits.highPercent ? 2 : percent >= limits.warnPercent ? 1 : 0;
    const bySize = tokens === undefined ? 0 : tokens >= limits.highTokens ? 2 : tokens >= limits.warnTokens ? 1 : 0;
    const level = Math.max(byShare, bySize);
    const size = tokens !== undefined ? contextCount(tokens) : percent !== undefined ? `${Math.round(percent)}%` : "?";
    const over = percent !== undefined && percent > 100 ? " OVER" : "";
    return {
        id: "context",
        label: `ctx ${size}${over}`,
        role: level === 2 ? "error" : level === 1 ? "warning" : normal,
    };
}

/** The parts the frame has, in the order of `settings.segments`. A part with nothing to say is not there. */
export function partsOf(frame: FooterFrame): Part[] {
    const { settings, usage } = frame;
    const roles = settings.colors;
    const parts: Part[] = [];
    for (const id of settings.segments) {
        switch (id) {
            case "model":
                parts.push({ id, label: clean(frame.model) || "No model", role: roles.model });
                break;
            case "thinking":
                parts.push({ id, label: clean(frame.thinking) || "off", role: roles.thinking });
                break;
            case "context":
                parts.push(contextPart(usage, settings.context, roles.context));
                break;
            case "cache":
                if (frame.cache !== undefined) {
                    const closing = frame.cache.state === "warm" && frame.cache.remainingMs < 60_000;
                    parts.push({ id, label: cacheLabel(frame.cache), role: closing ? "warning" : roles.cache });
                }
                break;
            case "cost":
                parts.push({
                    id,
                    label:
                        usage.estimatedCost === undefined
                            ? "est. $?"
                            : `est. $${usage.estimatedCost.toFixed(settings.costDecimals)}`,
                    role: roles.cost,
                });
                break;
            case "tokens":
                parts.push({
                    id,
                    label: `↑${count(usage.input + usage.cacheWrite)} ↓${count(usage.output)}`,
                    role: roles.tokens,
                });
                break;
            case "branch": {
                const branch = clean(frame.branch);
                if (branch !== "") parts.push({ id, label: branch, role: roles.branch });
                break;
            }
            case "cwd": {
                const folder = clean(frame.cwd === undefined ? "" : path.basename(frame.cwd));
                if (folder !== "") parts.push({ id, label: folder, role: roles.cwd });
                break;
            }
            case "statuses":
                for (const [, value] of [...(frame.statuses ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
                    const label = clean(value);
                    if (label !== "") parts.push({ id, label, role: roles.statuses });
                }
                break;
            case "plugins":
                for (const segment of frame.plugins ?? [])
                    parts.push({ id, label: segment.label, role: toneRole(segment.tone, roles.plugins) });
                break;
        }
    }
    return parts;
}

/** Below this many cells the model's name is not worth keeping over another part. */
const MODEL_MINIMUM = 8;

/** The footer for a row of `rawWidth` cells: always one row, and never wider than the row. */
export function renderFooter(rawWidth: number, frame: FooterFrame): string[] {
    const width = Number.isFinite(rawWidth) ? Math.max(0, Math.floor(rawWidth)) : 0;
    if (width === 0) return [];
    const { settings } = frame;
    const paint = frame.paint ?? ((value: string) => value);
    const separator = settings.separator;
    const gap = cellWidth(separator);
    const parts = partsOf(frame);
    const widthOf = (list: readonly Part[]) =>
        list.reduce((sum, part) => sum + cellWidth(part.label), 0) + Math.max(0, list.length - 1) * gap;
    const draw = (list: readonly Part[]) => [
        list.map((part) => paint(part.label, part.role)).join(paint(separator, "muted")),
    ];

    for (let dropped = 0; dropped <= settings.dropFirst.length; dropped++) {
        const gone = settings.dropFirst.slice(0, dropped);
        const kept = parts.filter((part) => !gone.includes(part.id));
        const at = kept.findIndex((part) => part.id === "model");
        if (at < 0) {
            if (widthOf(kept) <= width) return draw(kept);
            continue;
        }
        const others = kept.filter((_, index) => index !== at);
        const room = width - widthOf(others) - (others.length > 0 ? gap : 0);
        // A name that fits whole always stays; a long one is cut only down to MODEL_MINIMUM, then another part goes.
        const need =
            dropped === settings.dropFirst.length ? 1 : Math.min(MODEL_MINIMUM, cellWidth(kept[at]?.label ?? ""));
        if (room >= need) {
            return draw(kept.map((part, index) => (index === at ? { ...part, label: fit(part.label, room) } : part)));
        }
    }
    // Everything that may go has gone and it still does not fit: each part gets what is left, in order.
    const everything = parts.filter((part) => !settings.dropFirst.includes(part.id));
    let remaining = width;
    const fitted: Part[] = [];
    for (const part of everything) {
        const before = fitted.length > 0 ? gap : 0;
        if (remaining <= before) break;
        const label = fit(part.label, remaining - before);
        fitted.push({ ...part, label });
        remaining -= before + cellWidth(label);
    }
    return draw(fitted);
}

// ---- in Pi ------------------------------------------------------------------------------------------------------------

/** The branch the cache clock reads; a context gone stale after a reload says nothing rather than throwing into the renderer. */
function branchOf(ctx: ExtensionContext): readonly unknown[] {
    try {
        return ctx.sessionManager.getBranch();
    } catch {
        return [];
    }
}

export interface FooterHandle {
    /** Draws the footer again, because something it shows has changed. */
    refresh(): void;
    /** Takes the footer away: Pi's own comes back when the caller asks for it. */
    dispose(): void;
}

export interface FooterOptions {
    settings: () => FooterSettings;
    plugins: () => readonly PluginSegment[];
    env?: NodeJS.ProcessEnv;
}

/** Gives Pi the footer. Everything it shows is read when it is drawn, so a refresh is only a request to draw. */
export function installFooter(pi: ExtensionAPI, ctx: ExtensionContext, options: FooterOptions): FooterHandle {
    const env = options.env ?? process.env;
    let requestRender = () => {};
    let unwatchBranch: (() => void) | undefined;
    // The cache countdown is the only part of the footer that changes without an event: one timer, armed only while a cache is
    // warm, fires when the shown seconds change and is cleared with the footer.
    let tick: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        requestRender = () => {};
        if (tick !== undefined) clearTimeout(tick);
        tick = undefined;
        unwatchBranch?.();
        unwatchBranch = undefined;
    };
    const arm = (cache: CacheState | undefined) => {
        if (cache?.state !== "warm" || tick !== undefined) return;
        tick = setTimeout(
            () => {
                tick = undefined;
                requestRender();
            },
            (cache.remainingMs % 1000 || 1000) + 10,
        );
        tick.unref();
    };
    ctx.ui.setFooter((tui, theme, data) => {
        requestRender = () => tui.requestRender();
        unwatchBranch = data.onBranchChange?.(() => tui.requestRender());
        return {
            invalidate() {},
            render: (width: number) => {
                try {
                    const settings = options.settings();
                    const now = Date.now();
                    const cache = settings.segments.includes("cache")
                        ? cacheState(branchOf(ctx), ctx.model, env, now)
                        : undefined;
                    arm(cache);
                    return renderFooter(width, {
                        settings,
                        usage: collectUsage(ctx),
                        model: ctx.model?.name ?? ctx.model?.id,
                        thinking: pi.getThinkingLevel?.(),
                        statuses: data.getExtensionStatuses?.(),
                        branch: settings.segments.includes("branch") ? data.getGitBranch?.() : undefined,
                        cwd: ctx.cwd,
                        plugins: options.plugins(),
                        cache,
                        now,
                        paint: (value, role) => theme.fg(role, value),
                    });
                } catch {
                    // The footer is never worth breaking the screen for: a stale context or a malformed entry shows nothing.
                    return [];
                }
            },
            dispose: stop,
        };
    });
    return { refresh: () => requestRender(), dispose: stop };
}
