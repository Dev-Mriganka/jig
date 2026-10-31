// What the plugin keeps while Pi runs: the workflow files read at session start, the settings, the latest context (which gives the
// active ticket), and the results of tool calls the session has seen (evidence for a scenario can name one). Everything else is
// read from the ticket folder and the repositories when it is needed, so nothing here can go stale.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import { Evidence } from "./conditions.ts";
import { settingsFrom } from "./config.ts";
import type { WorkflowSettings } from "./config.ts";
import type { Stage } from "./definition.ts";
import type { Host } from "./host.ts";
import { loadWorkflows } from "./load.ts";
import type { Loaded, LoadedWorkflow, WorkflowFolder } from "./load.ts";
import { readState, statePath, updateState } from "./store.ts";
import type { ReadState, WorkflowState } from "./store.ts";
import { activeTicket, readBound, ticketPaths, ticketsFolder } from "./ticket.ts";
import type { Bound, TicketPaths } from "./ticket.ts";

/** How many tool results the session remembers, for a scenario's evidence to name one. */
const MAX_SEEN = 1000;

/** The ticket an operation is about, with what is known of its workflow. */
export interface Work {
    ticket: string;
    paths: TicketPaths;
    read: ReadState;
}

export class Runtime {
    readonly pi: ExtensionAPI;
    readonly host: Host;
    /** The latest context Pi gave us. Its session manager is live, so the active ticket is read from it each time. */
    ctx: ExtensionContext | undefined;
    loaded: Loaded = { workflows: new Map(), failures: [], disabled: [] };
    settings: WorkflowSettings = settingsFrom(undefined);
    private readonly seen = new Map<string, { tool: string; error: boolean }>();
    private readonly guarded = new Set<string>();

    constructor(pi: ExtensionAPI, host: Host) {
        this.pi = pi;
        this.host = host;
    }

    // ---- the session ------------------------------------------------------------------------------------------------------

    /** Pi's working folder. */
    get cwd(): string {
        return this.ctx?.cwd ?? process.cwd();
    }

    /** Called with the context of an event, so that the next question about the active ticket has the session in hand. */
    touch(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }

    /** Reads the settings and the workflow files, and guards the folders they come from. */
    start(ctx: ExtensionContext): void {
        this.ctx = ctx;
        this.reload();
        const ticket = this.activeTicket();
        if (ticket !== undefined) this.guardState(ticket);
    }

    reload(): void {
        let section: unknown;
        try {
            section = jig().config.section("workflow");
        } catch {
            section = undefined;
        }
        this.settings = settingsFrom(section);
        const folders: WorkflowFolder[] = [
            ...this.settings.folders.map((dir) => ({ dir, source: "configured" as const })),
            { dir: path.join(getAgentDir(), "workflows"), source: "agent folder" },
        ];
        const project = this.projectFolder();
        if (project !== undefined) folders.push({ dir: project, source: "project" });
        this.loaded = loadWorkflows(folders, this.settings.disabled);
        // The folders a workflow is read from are not for the agent to write: an agent that could edit the file that holds it
        // back could lift its own holds. The agent folder is guarded by jig-core already.
        this.guard([...this.settings.folders, path.join(this.cwd, ".pi", "workflows")]);
    }

    /** The project's `.pi/workflows`, only when Pi trusts the project. */
    private projectFolder(): string | undefined {
        try {
            return this.ctx?.isProjectTrusted() === true ? path.join(this.cwd, ".pi", "workflows") : undefined;
        } catch {
            return undefined;
        }
    }

    /** Registers paths with jig-core as guarded: Pi's file tools and the sandbox cannot write them. Only ever adds. */
    guard(paths: readonly string[]): void {
        const fresh = paths.filter((entry) => path.isAbsolute(entry) && !this.guarded.has(entry));
        if (fresh.length === 0) return;
        try {
            jig().config.addProtectedPaths({ guarded: fresh });
            for (const entry of fresh) this.guarded.add(entry);
        } catch {
            // jig-core is not loaded, which is reported where it matters: every tool of this plugin needs it.
        }
    }

    /** Guards a ticket's state file. */
    guardState(ticket: string): void {
        this.guard([statePath(this.paths(ticket).dir)]);
    }

    // ---- the ticket -------------------------------------------------------------------------------------------------------

    activeTicket(): string | undefined {
        const ctx = this.ctx;
        if (ctx === undefined) return undefined;
        try {
            return activeTicket(ctx.sessionManager.getEntries());
        } catch {
            return undefined;
        }
    }

    ticketsFolder(): string {
        let section: unknown;
        try {
            section = jig().config.section("memory");
        } catch {
            section = undefined;
        }
        return ticketsFolder(section);
    }

    paths(ticket: string): TicketPaths {
        return ticketPaths(this.ticketsFolder(), ticket);
    }

    bound(ticket: string): Bound {
        return readBound(this.paths(ticket), this.cwd);
    }

    work(ticket: string): Work {
        const paths = this.paths(ticket);
        const read = readState(paths.dir);
        // A ticket that has a state file has it guarded from the moment the session first looks at it, whichever way it got active.
        if (read.kind !== "none") this.guardState(ticket);
        return { ticket, paths, read };
    }

    /** The workflow a state belongs to, as the files define it now. */
    definition(state: WorkflowState): LoadedWorkflow | undefined {
        return this.loaded.workflows.get(state.workflow);
    }

    /** The tickets that have a workflow, found in the ticket folder: those whose state file exists. */
    tickets(): string[] {
        const folder = this.ticketsFolder();
        try {
            return readdirSync(folder, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && existsSync(statePath(path.join(folder, entry.name))))
                .map((entry) => entry.name)
                .sort();
        } catch {
            return [];
        }
    }

    // ---- evidence ---------------------------------------------------------------------------------------------------------

    evidence(
        work: Work,
        state: WorkflowState,
        options: { live: boolean; approvedNow?: boolean; signal?: AbortSignal },
    ): Evidence {
        return new Evidence({
            host: this.host,
            ticket: work.ticket,
            paths: work.paths,
            cwd: this.cwd,
            state,
            bound: this.bound(work.ticket).roots,
            live: options.live,
            ...(options.approvedNow === undefined ? {} : { approvedNow: options.approvedNow }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** Saves the pull request readings an evaluation made now, so that a hold can use them without the network. */
    saveReadings(work: Work, evidence: Evidence): void {
        if (evidence.freshlyRead.size === 0) return;
        updateState(work.paths.dir, (state) => {
            for (const root of evidence.freshlyRead) {
                const reading = evidence.observed[root];
                if (reading !== undefined) state.observed[root] = reading;
            }
        });
    }

    /** The stage after `stage` in a workflow, if there is one. */
    static next(stages: readonly Stage[], stage: string): Stage | undefined {
        const index = stages.findIndex((candidate) => candidate.id === stage);
        return index < 0 ? undefined : stages[index + 1];
    }

    // ---- what the session has seen ----------------------------------------------------------------------------------------

    noteResult(toolCallId: string, tool: string, error: boolean): void {
        this.seen.set(toolCallId, { tool, error });
        if (this.seen.size > MAX_SEEN) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
    }

    /** What the session saw of a tool call: its tool, and whether it failed. Undefined for a call it never saw. */
    seenResult(toolCallId: string): { tool: string; error: boolean } | undefined {
        return this.seen.get(toolCallId);
    }
}
