// What jig-lens does in a session:
//   agent_end            imports the records that were written during the run
//   /lens                imports, then shows today, this session and its ticket in Pi
//   /lens ticket KEY     the same for one ticket, over all time
//   /lens session [id]   the same for one session (this one by default)
//   /lens days N         the same for the last N days
//   /lens usage          an interactive view of cost and tokens, from Pi's own session files
//   /lens grafana        imports, starts Grafana if it is not running, and opens its dashboards
//   /lens datasette      the same for Datasette
//   /lens rebuild        deletes the index and imports every record file again
//   /lens status         the viewer, the index, the last import and the lines that could not be read
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completions, parseCommand, USAGE } from "./command.ts";
import type { SummaryCommand } from "./command.ts";
import type { Deps } from "./deps.ts";
import { registerDisplay, show } from "./display.ts";
import { plural } from "./format.ts";
import { importRecords } from "./import.ts";
import type { ImportOutcome } from "./import.ts";
import { importLine, indexLines, reason, skippedLine } from "./report.ts";
import { summaryFor } from "./scopes.ts";
import { startViewer } from "./start.ts";
import { deleteIndex, openIndex, readIndex, readStatus } from "./store.ts";
import type { IndexStatus } from "./store.ts";
import type { Block } from "./summary.ts";
import { createModelNames, MODEL_NAMES_EVENT } from "./usage-names.ts";
import { homeUrl, viewerUrl } from "./viewer.ts";
import type { Viewer, ViewerState } from "./viewer.ts";

type Level = "info" | "warning" | "error";

const tell = (ctx: ExtensionContext, text: string, level: Level = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
};

/** The id of the session the user is in, which is what the records are filed under. Undefined when Pi cannot say. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
    try {
        return ctx.sessionManager.getSessionId();
    } catch {
        return undefined;
    }
}

/**
 * Imports one at a time within this process. Other Pi sessions import at the same moment, and the index copes with that
 * (see import.ts); this only keeps one session's `agent_end` and `/lens` from running over each other.
 */
function createImporter(deps: Deps) {
    let queue: Promise<unknown> = Promise.resolve();
    let last: string | undefined;

    async function once(fresh: boolean): Promise<ImportOutcome> {
        const paths = deps.paths();
        let db: DatabaseSync | undefined;
        try {
            if (fresh) deleteIndex(paths.index);
            db = openIndex(paths.index);
            const result = await importRecords(db, { records: paths.records, now: deps.now() });
            last = result.problems.length === 0 ? undefined : result.problems.join("; ");
            return { result, ...(last === undefined ? {} : { problem: last }) };
        } catch (error) {
            last = reason(error);
            return { problem: last };
        } finally {
            db?.close();
        }
    }

    return {
        /** Imports what is new, or with `fresh` makes the index again first. Never rejects. */
        run(fresh = false): Promise<ImportOutcome> {
            const next = queue.then(() => once(fresh));
            queue = next;
            return next;
        },
        /** What went wrong in the latest import of this session, if anything did. */
        problem: () => last,
    };
}

export function registerLens(pi: ExtensionAPI, deps: Deps): void {
    const importer = createImporter(deps);
    // The failure the user was last told about, so a session where every run fails says so once.
    let told: string | undefined;

    // The records of a run are all written by the time it ends, so this is when the index catches up. It is cheap when
    // nothing is new, and it never throws into Pi.
    pi.on("agent_end", async (_event, ctx) => {
        const { problem } = await importer.run();
        if (problem === undefined) {
            told = undefined;
        } else if (problem !== told) {
            told = problem;
            tell(ctx, `jig-lens could not import the records: ${problem}`, "warning");
        }
    });

    registerDisplay(pi);

    // Names for the models in `/lens usage`, from whichever plugin knows them. Listened to from the start, so a name sent
    // before the command runs is kept.
    const modelNames = createModelNames();
    pi.events.on(MODEL_NAMES_EVENT, (payload) => modelNames.learn(payload));
    let usageView: AbortController | undefined;

    /**
     * `/lens usage`: an interactive view that reads Pi's session files. It needs a terminal. The view is loaded only now, so
     * the rest of the plugin never needs pi-tui, and one that is already open is closed first.
     */
    async function usage(ctx: ExtensionContext): Promise<void> {
        if (ctx.mode !== "tui") {
            tell(ctx, "/lens usage needs the terminal.", "info");
            return;
        }
        usageView?.abort();
        const controller = (usageView = new AbortController());
        try {
            const { showDashboard } = await import("./usage-dashboard.ts");
            if (!controller.signal.aborted) {
                await showDashboard(ctx, { sessionsDir: deps.sessionsDir(), now: deps.now(), signal: controller.signal, names: modelNames.names });
            }
        } catch (error) {
            if (!controller.signal.aborted) tell(ctx, `Could not open the usage view: ${reason(error)}`, "warning");
        } finally {
            if (usageView === controller) usageView = undefined;
        }
    }

    /** `/lens`, `/lens ticket`, `/lens session` and `/lens days`: import, then show the summary. */
    async function summary(ctx: ExtensionContext, command: SummaryCommand): Promise<void> {
        // With no screen (print and JSON modes) there is nobody to show it to, and the end of each run imports anyway.
        if (!ctx.hasUI) return;
        const session = sessionIdOf(ctx);
        if (command.kind === "session" && command.session === undefined && session === undefined) {
            tell(ctx, "Pi cannot say which session this is. Give an id: /lens session ID", "warning");
            return;
        }

        const outcome = await importer.run();
        let blocks: Block[] | undefined;
        try {
            blocks = readIndex(deps.paths().index, (db) => summaryFor(command, db, deps.now(), session));
        } catch (error) {
            const cannot = `The index cannot be read (${reason(error)}). /lens rebuild makes it again.`;
            tell(ctx, `${importLine(outcome)}\n${cannot}`, "warning");
            return;
        }
        if (blocks === undefined) {
            tell(ctx, `${importLine(outcome)}\nThere is no index to read yet.`, "warning");
            return;
        }

        show(pi, ctx, blocks);
        // After the summary, so the figures are what the user reads first: a file that was not read may be missing.
        if (outcome.result === undefined || outcome.problem !== undefined || outcome.result.skipped > 0) {
            tell(ctx, importLine(outcome), "warning");
        }
    }

    /** `/lens grafana` and `/lens datasette`: import, start the viewer if it is not running, and open its page. */
    async function openViewer(ctx: ExtensionContext, viewer: Viewer): Promise<void> {
        const settings = deps.settings();
        const lines = [importLine(await importer.run())];
        const state = await deps.probe(viewer, settings.port);
        if (state === "busy") {
            lines.push(
                `Port ${settings.port} on 127.0.0.1 is taken by something that is not ${viewer}. `
                    + `Choose another with "port" under "lens" in jig.json.`,
            );
            tell(ctx, lines.join("\n"), "warning");
            return;
        }
        if (state === "stopped") {
            const started = await startViewer(deps, viewer, settings, deps.paths());
            lines.push(...started.lines);
            if (!started.ok) {
                tell(ctx, lines.join("\n"), "warning");
                return;
            }
        }
        const page = homeUrl(viewer, settings);
        lines.push((await deps.open(page)) ? `Opened ${page} in your browser.` : `Open ${page} in your browser.`);
        tell(ctx, lines.join("\n"));
    }

    async function rebuild(ctx: ExtensionContext): Promise<void> {
        const outcome = await importer.run(true);
        if (outcome.result === undefined) {
            tell(ctx, importLine(outcome), "warning");
            return;
        }
        let status: IndexStatus | undefined;
        try {
            status = readStatus(deps.paths().index);
        } catch {
            // The import has just succeeded, so the counts are a courtesy.
        }
        const held = status === undefined
            ? "Rebuilt the index."
            : `Rebuilt the index from ${plural(status.files, "record file")}: `
                + `${plural(status.calls, "call")} and ${plural(status.turns, "turn")}.`;
        const skipped = outcome.result.skipped > 0 ? ` ${skippedLine(outcome.result.skipped)}` : "";
        tell(ctx, held + skipped, outcome.problem === undefined ? "info" : "warning");
    }

    /**
     * Which viewer answers on the port. Both use it, so it asks for Grafana first, and for Datasette only when
     * something else answered: when nothing listens, the answer is the same for both.
     */
    async function answering(port: number): Promise<{ viewer: Viewer | undefined; state: ViewerState }> {
        const grafana = await deps.probe("grafana", port);
        if (grafana !== "busy") return { viewer: "grafana", state: grafana };
        const datasette = await deps.probe("datasette", port);
        return datasette === "running"
            ? { viewer: "datasette", state: "running" }
            : { viewer: undefined, state: "busy" };
    }

    async function status(ctx: ExtensionContext): Promise<void> {
        const settings = deps.settings();
        const paths = deps.paths();
        const { viewer, state } = await answering(settings.port);
        const url = viewerUrl(settings);
        const viewerLine = state === "running"
            ? `Viewer: ${viewer} at ${url}, running`
            : state === "stopped"
                ? `Viewer: none running at ${url} (/lens grafana or /lens datasette starts one)`
                : `Viewer: the port is taken by something that is neither Grafana nor Datasette (${url})`;
        const lines = [viewerLine, ...indexLines(paths.index, () => readStatus(paths.index))];
        const problem = importer.problem();
        if (problem !== undefined) lines.push(`Latest import in this session: ${problem}`);
        tell(ctx, lines.join("\n"));
    }

    pi.registerCommand("lens", {
        description: "Jig summary of cost, failures and your waiting time: /lens, ticket KEY, session, days N; "
            + "usage for cost and tokens by period and model; grafana or datasette for a dashboard; rebuild, status",
        getArgumentCompletions: completions,
        handler: async (args, ctx) => {
            const command = parseCommand(args);
            switch (command.kind) {
                case "usage":
                    tell(ctx, command.problem === undefined ? USAGE : `${command.problem}\n${USAGE}`, "warning");
                    return;
                case "usage-view":
                    return usage(ctx);
                case "viewer":
                    return openViewer(ctx, command.viewer);
                case "rebuild":
                    return rebuild(ctx);
                case "status":
                    return status(ctx);
                default:
                    return summary(ctx, command);
            }
        },
    });
}
