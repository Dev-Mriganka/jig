// What jig-lens does in a session:
//   agent_end      imports the records that were written during the run
//   /lens          imports, starts the viewer if it is not running, and opens the dashboard
//   /lens rebuild  deletes the index and imports every record file again
//   /lens status   the viewer, the index, the last import and the lines that could not be read
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Deps } from "./deps.ts";
import { importRecords } from "./import.ts";
import type { ImportOutcome } from "./import.ts";
import { importLine, indexLines, plural, reason, skippedLine } from "./report.ts";
import { startViewer } from "./start.ts";
import { deleteIndex, openIndex, readStatus } from "./store.ts";
import type { IndexStatus } from "./store.ts";
import { homeUrl, viewerUrl } from "./viewer.ts";
import type { ViewerState } from "./viewer.ts";

const STATE_TEXT: Record<ViewerState, string> = {
    running: "running",
    stopped: "not running (/lens starts it)",
    busy: "the port is taken by something that is not this viewer",
};

type Level = "info" | "warning" | "error";

const tell = (ctx: ExtensionContext, text: string, level: Level = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
};

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

    async function openDashboard(ctx: ExtensionContext): Promise<void> {
        const settings = deps.settings();
        const lines = [importLine(await importer.run())];
        const state = await deps.probe(settings.viewer, settings.port);
        if (state === "busy") {
            lines.push(
                `Port ${settings.port} on 127.0.0.1 is taken by something that is not ${settings.viewer}. `
                    + `Choose another with "port" under "lens" in jig.json.`,
            );
            tell(ctx, lines.join("\n"), "warning");
            return;
        }
        if (state === "stopped") {
            const started = await startViewer(deps, settings, deps.paths());
            lines.push(...started.lines);
            if (!started.ok) {
                tell(ctx, lines.join("\n"), "warning");
                return;
            }
        }
        const page = homeUrl(settings);
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

    async function status(ctx: ExtensionContext): Promise<void> {
        const settings = deps.settings();
        const paths = deps.paths();
        const state = await deps.probe(settings.viewer, settings.port);
        const lines = [
            `Viewer: ${settings.viewer} at ${viewerUrl(settings)}, ${STATE_TEXT[state]}`,
            ...indexLines(paths.index, () => readStatus(paths.index)),
        ];
        const problem = importer.problem();
        if (problem !== undefined) lines.push(`Latest import in this session: ${problem}`);
        tell(ctx, lines.join("\n"));
    }

    pi.registerCommand("lens", {
        description: "Jig dashboard: /lens opens it, /lens rebuild makes the index again, /lens status shows it",
        getArgumentCompletions: (prefix) => {
            const matches = ["rebuild", "status"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args, ctx) => {
            const word = args.trim();
            if (word === "") return openDashboard(ctx);
            if (word === "rebuild") return rebuild(ctx);
            if (word === "status") return status(ctx);
            tell(ctx, "Usage: /lens, /lens rebuild, /lens status", "warning");
        },
    });
}
