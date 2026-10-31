// `/ps`: the background tasks of this session. In the terminal interface it lists them, shows a task's output as it grows,
// and stops one; everywhere else `/ps list`, `/ps view <id>` and `/ps kill <id|all>` do the same in plain text. The log view
// (follows the end while you are at the bottom, refreshes once a second) is adapted from gvanderclay/pi-bg-bash's `/bg` (MIT,
// see docs/background.md, "Credit").
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { oneLine, taskLine } from "./format.ts";
import { tailText } from "./output.ts";
import type { Tasks } from "./tasks.ts";
import type { Task } from "./types.ts";

const REFRESH_MS = 1_000;
/** Lines the log view uses besides the log: two rules, the title and the keys. */
const CHROME = 4;

/** The parts of Pi's terminal and theme the log view uses, so a test can pass small stand-ins. */
type Screen = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
type Styles = Pick<Theme, "fg" | "bold">;

/** The end of a task's log, scrollable, following the end while you are at the bottom. It never moves the agent's read position. */
export function logView(task: Task, tui: Screen, theme: Styles, done: () => void): Component {
    const read = (): { lines: string[]; cut: boolean } => {
        const { text, cut } = tailText(task, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, Date.now());
        return { lines: (text === "" ? "(no output)" : text).replace(/\t/g, "    ").split("\n"), cut };
    };
    let { lines, cut } = read();
    let rows: string[] = [];
    let wrappedAt = 0;
    let top = Number.POSITIVE_INFINITY;
    const height = (): number => Math.max(3, tui.terminal.rows - CHROME - 2);
    const clamp = (): void => {
        top = Math.max(0, Math.min(top, rows.length - height()));
    };
    const timer = setInterval(() => {
        clamp();
        const atBottom = top >= rows.length - height();
        ({ lines, cut } = read());
        wrappedAt = 0;
        if (atBottom) top = Number.POSITIVE_INFINITY;
        tui.requestRender();
    }, REFRESH_MS);
    timer.unref();
    return {
        render(width: number): string[] {
            if (width !== wrappedAt) {
                rows = lines.flatMap((line) => wrapTextWithAnsi(line, width));
                wrappedAt = width;
            }
            clamp();
            const body = rows.slice(top, top + height());
            const where = `lines ${top + 1}-${top + body.length} of ${rows.length}${cut ? ", earlier output not shown" : ""}`;
            const rule = theme.fg("accent", "─".repeat(width));
            return [
                rule,
                truncateToWidth(theme.fg("accent", theme.bold(taskLine(task, Date.now()))), width),
                ...body,
                truncateToWidth(theme.fg("dim", `${where} • up down pgup pgdn home end scroll • esc back`), width),
                rule,
            ];
        },
        invalidate(): void {
            wrappedAt = 0;
        },
        handleInput(data: string): void {
            clamp();
            if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
                clearInterval(timer);
                done();
            } else if (matchesKey(data, "up")) top -= 1;
            else if (matchesKey(data, "down")) top += 1;
            else if (matchesKey(data, "pageUp")) top -= height();
            else if (matchesKey(data, "pageDown")) top += height();
            else if (matchesKey(data, "home")) top = 0;
            else if (matchesKey(data, "end")) top = Number.POSITIVE_INFINITY;
            tui.requestRender();
        },
    };
}

function listText(tasks: Tasks): string {
    const all = tasks.list();
    const now = Date.now();
    return all.length === 0 ? "No background tasks." : all.map((task) => taskLine(task, now)).join("\n");
}

function viewText(tasks: Tasks, id: string): string {
    const task = tasks.get(id);
    if (!task) return `Unknown task id ${id}. /ps list shows this session's tasks.`;
    const { text, cut } = tailText(task, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, Date.now());
    return `${taskLine(task, Date.now())}\n${text === "" ? "(no output)" : text}${cut ? "\n[earlier output not shown]" : ""}`;
}

async function confirmKill(tasks: Tasks, target: string, ctx: ExtensionCommandContext): Promise<void> {
    const found = target === "all" ? tasks.running() : [tasks.get(target)];
    if (found.length === 0) return ctx.ui.notify("No running background tasks.", "info");
    if (found.some((task) => task === undefined)) {
        return ctx.ui.notify(`Unknown task id ${target}. /ps list shows this session's tasks.`, "error");
    }
    if (!ctx.hasUI)
        return ctx.ui.notify("Stopping a task asks you first: use /ps in an interactive session.", "warning");
    const title =
        target === "all" ? `Stop ${found.length} background task${found.length === 1 ? "" : "s"}?` : `Stop ${target}?`;
    const detail = found.map((task) => oneLine((task as Task).command, 80)).join("\n");
    if (!(await ctx.ui.confirm(title, detail))) return;
    const reports = await tasks.kill(target, "by user");
    ctx.ui.notify(reports.map((report) => report.text).join("\n"), "info");
}

const VIEW = "View its output";
const STOP = "Stop it";
const BACK = "Back";
const CLEAR = "Forget the finished tasks";

export async function psCommand(args: string, ctx: ExtensionCommandContext, tasks: Tasks): Promise<void> {
    tasks.setContext(ctx);
    const [sub, target] = args.trim().split(/\s+/);
    if (sub === "list") return ctx.ui.notify(listText(tasks), "info");
    if (sub === "view") {
        if (!target) return ctx.ui.notify("Usage: /ps view <id>", "warning");
        return ctx.ui.notify(viewText(tasks, target), "info");
    }
    if (sub === "kill") {
        if (!target) return ctx.ui.notify("Usage: /ps kill <id|all>", "warning");
        return confirmKill(tasks, target, ctx);
    }
    if (sub) return ctx.ui.notify("Usage: /ps [list | view <id> | kill <id|all>]", "warning");
    if (tasks.list().length === 0) return ctx.ui.notify("No background tasks.", "info");
    if (!ctx.hasUI) return ctx.ui.notify(listText(tasks), "info");
    // The list comes back after each view or stop, with the state as it is then, until you leave it.
    for (;;) {
        const all = tasks.list();
        const now = Date.now();
        const rows = all.map((task) => taskLine(task, now));
        const hasFinished = all.some((task) => task.state !== "running");
        const choice = await ctx.ui.select("Background tasks", hasFinished ? [...rows, CLEAR] : rows);
        if (choice === undefined) return;
        if (choice === CLEAR) {
            tasks.clearFinished();
            continue;
        }
        const task = all[rows.indexOf(choice)];
        if (task === undefined) return;
        const action = await ctx.ui.select(choice, task.state === "running" ? [VIEW, STOP, BACK] : [VIEW, BACK]);
        if (action === STOP) await confirmKill(tasks, task.id, ctx);
        else if (action === VIEW) {
            if (ctx.mode === "tui") {
                await ctx.ui.custom<void>((tui, theme, _keys, done) => logView(task, tui, theme, () => done()));
            } else ctx.ui.notify(viewText(tasks, task.id), "info");
        }
    }
}

/** Registers `/ps`. */
export function registerPs(pi: ExtensionAPI, tasks: Tasks): void {
    pi.registerCommand("ps", {
        description: "jig-sandbox: the background tasks; shows a task's output and stops one",
        getArgumentCompletions: (prefix) => {
            const matches = ["list", "view", "kill"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: (args, ctx) => psCommand(args, ctx, tasks),
    });
}
