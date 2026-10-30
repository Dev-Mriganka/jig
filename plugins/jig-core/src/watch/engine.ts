// The watch engine: background watches for every plugin.
//
// A plugin registers a kind of watch (what to poll, and how often) and starts watches from its own tools. The engine
// polls them, saves each one so it survives a restart of Pi, and tells the agent once when one ends. The `watch` tool
// lists and stops them.
//
// Three rules shape the code:
// - Nothing runs before a session does, and `end()` stops everything. Pi's documentation forbids timers in the
//   factory, and a timer that outlives its session would poll for nobody.
// - A timer callback that throws takes Pi down, so every callback catches, and a plugin's poll that throws is a failed
//   poll, not a crash.
// - What a plugin returns is not trusted: it is checked, copied through JSON and cleaned before it is saved or shown.
import type { JigApi, PollOutcome, WatchDoneEvent, WatchInfo, WatchKind, WatchResult } from "../contract.ts";
import { errorMessage } from "../errors.ts";
import { cleanLine, cleanResult, isWatchResult, plainLine } from "./clean.ts";
import type { Protect } from "./clean.ts";
import { formatAge } from "./format.ts";
import { composeMessage } from "./message.ts";
import type { Notice, WatchMessage } from "./message.ts";
import { createOutbox } from "./outbox.ts";
import type { SavedWatch, WatchStore } from "./store.ts";
import { realTimers } from "./timers.ts";
import type { Timers } from "./timers.ts";

/** The first poll comes this long after a watch starts or is picked up again. */
export const FIRST_POLL_MS = 2_000;
/** A poll that has not answered by now has failed. */
export const POLL_TIMEOUT_MS = 60_000;
/** The time to the next poll is kept between these, whatever the kind or the poll asks for. */
export const MIN_POLL_MS = 5_000;
export const MAX_POLL_MS = 10 * 60_000;
/** Polls that fail in a row before the watch is paused. */
export const PAUSE_AFTER_FAILURES = 3;
export const DEFAULT_TIMEOUT_MINUTES = 60;
export const DEFAULT_STALL_MINUTES = 30;
/** Finished watches stay in `list` this long. */
export const LIST_WINDOW_MS = 24 * 60 * 60_000;
/** Finished watches are deleted from disk after this long. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;

const MAX_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 200;

/** A watch as `list` and `/jig` show it: the contract's `WatchInfo` and what only jig-core needs. */
export interface WatchEntry extends WatchInfo {
    /** Nothing polls it: the plugin that supplies its kind is not loaded. */
    waiting: boolean;
    /** The time since it started. */
    ageMs: number;
    /** What its kind says it watches, when the kind is loaded and says. */
    describes?: string;
}

/** What plugins call: the contract's `watches`. */
type Watches = JigApi["watches"];

/** The contract's `watches`, and what only jig-core's own code uses. */
export interface WatchEngine extends Watches {
    /** A session starts: picks up this session's saved watches, and cleans old files. */
    begin(session: string): void;
    /** The session ends: stops every timer and poll. Saved watches stay. Safe to call twice. */
    end(): void;
    /** What `list` returns, with more for the `watch` tool and `/jig`. */
    entries(): WatchEntry[];
    /** The last thing that went wrong with the files or the messages, for `/jig`. */
    problem(): string | undefined;
}

export interface WatchEngineOptions {
    /** Milliseconds since the epoch. */
    now: () => number;
    timers?: Timers;
    store: WatchStore;
    protect: Protect;
    /** Shows the user a line. Returns whether there was a screen to show it on. */
    notify(message: string, level: "info" | "warning"): boolean;
    /** Tells other plugins that a watch ended. */
    emit(event: WatchDoneEvent): void;
    /** Tells the agent. */
    send(message: WatchMessage): void;
}

/** A watch that is held in memory. */
interface Held {
    saved: SavedWatch;
    /** The next poll. */
    timer?: unknown;
    /** The time limit of the poll in flight. */
    pollTimer?: unknown;
    /** Cancels the poll in flight. */
    abort?: AbortController;
    polling: boolean;
    /** Picked up from disk, and not polled yet in this run. */
    restarted: boolean;
    /** The message of the last failed poll. */
    lastError?: string;
}

type Kind = WatchKind<unknown, unknown>;

/** How a watch ended, as far as telling anyone goes. */
interface Ending {
    /** Tell the agent. A stop is asked for by the agent or the user, so it is not told. */
    tell: boolean;
    /** The first poll after a restart ended it. */
    afterRestart?: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A copy that has been through JSON, which is what a restart will give back. Throws if there is no such copy. */
function plainJson(value: unknown, what: string): unknown {
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    } catch {
        throw new TypeError(`${what} must be plain JSON`);
    }
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

function minutesOf(value: unknown, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`watches.start: ${name} must be a number of minutes above 0`);
    }
    return value;
}

/** Checks the shape of a kind, which is code from another package, where the mistake is made. */
function checkKind(kind: Partial<Kind> | undefined): void {
    if (typeof kind?.kind !== "string" || kind.kind === "") throw new TypeError("registerKind: the kind needs a name");
    const name = `registerKind(${kind.kind})`;
    if (typeof kind.plugin !== "string" || kind.plugin === "") throw new TypeError(`${name}: the plugin needs a name`);
    const interval = finite(kind.intervalMs);
    if (interval === undefined || interval <= 0) {
        throw new TypeError(`${name}: intervalMs must be a number of milliseconds above 0`);
    }
    if (typeof kind.poll !== "function" || typeof kind.describe !== "function") {
        throw new TypeError(`${name}: the kind needs poll and describe functions`);
    }
}

export function createWatchEngine(options: WatchEngineOptions): WatchEngine {
    const { now, store, protect } = options;
    const timers = options.timers ?? realTimers;
    const kinds = new Map<string, Kind>();
    /** This session's watches: the open and paused ones, and the ones that finished recently. */
    const held = new Map<string, Held>();
    let session: string | undefined;
    let problem: string | undefined;

    const outbox = createOutbox<Notice>({ now, timers, send: tellAgent });

    // ---- small things --------------------------------------------------------------------------------------------

    /** Whether the entry is still the one that runs: not stopped, not finished, and the session has not ended. */
    function isRunning(entry: Held): boolean {
        return session !== undefined && held.get(entry.saved.id) === entry && entry.saved.status === "open";
    }

    function stopTimers(entry: Held): void {
        if (entry.timer !== undefined) timers.clearTimeout(entry.timer);
        if (entry.pollTimer !== undefined) timers.clearTimeout(entry.pollTimer);
        entry.timer = undefined;
        entry.pollTimer = undefined;
    }

    function persist(saved: SavedWatch): void {
        try {
            store.save(saved);
        } catch (error) {
            // The watch goes on in memory; it just would not survive a restart.
            problem = `could not save watch ${saved.id}: ${errorMessage(error)}`;
        }
    }

    /** Runs code from Pi or another plugin that must not be able to stop the engine. */
    function guarded(work: () => void): void {
        try {
            work();
        } catch {
            // Whatever it did is its own business.
        }
    }

    /** The title as it is shown to anyone: a secret registered since the watch started is not in it. */
    function titleOf(saved: SavedWatch): string {
        return protect.redact(saved.title);
    }

    function finishedAtOf(saved: SavedWatch): number {
        return Date.parse(saved.finishedAt ?? saved.startedAt);
    }

    function tellAgent(notices: Notice[]): void {
        try {
            options.send(composeMessage(notices));
        } catch (error) {
            const what = notices.length === 1 ? "a watch" : `${notices.length} watches`;
            problem = `could not tell the agent about ${what}: ${errorMessage(error)}`;
        }
    }

    // ---- polling ---------------------------------------------------------------------------------------------------

    /** Schedules the next poll. */
    function arm(entry: Held, delayMs: number): void {
        stopTimers(entry);
        entry.timer = timers.setTimeout(() => {
            entry.timer = undefined;
            poll(entry).catch((error: unknown) => {
                problem = `a poll of watch ${entry.saved.id} failed unexpectedly: ${errorMessage(error)}`;
            });
        }, delayMs);
    }

    /** The time to the next poll: what the poll or the kind asks for, kept between 5 s and 10 min, and never past the
     *  deadline, where the last poll is made. */
    function nextDelay(saved: SavedWatch, kind: Kind, outcome?: PollOutcome<unknown>): number {
        const asked = finite(outcome?.nextPollMs) ?? finite(kind.intervalMs) ?? MIN_POLL_MS;
        const delay = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, asked));
        return Math.max(0, Math.min(delay, Date.parse(saved.deadlineAt) - now()));
    }

    /** One poll, limited to 60 s. Cancelling `controller` ends it at once, whatever the plugin's code does. */
    function limited(entry: Held, controller: AbortController, work: () => Promise<unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            entry.pollTimer = timers.setTimeout(() => {
                reject(new Error(`the poll did not answer within ${POLL_TIMEOUT_MS / 1000} s`));
                controller.abort();
            }, POLL_TIMEOUT_MS);
            const cancelled = () => reject(new Error("the poll was cancelled"));
            controller.signal.addEventListener("abort", cancelled, { once: true });
            work().then(resolve, reject);
        });
    }

    /** What a poll returned, checked and copied. Throws when it is not an outcome. */
    function checked(answer: unknown): PollOutcome<unknown> {
        if (typeof answer !== "object" || answer === null) throw new Error("the poll returned no outcome");
        const raw = answer as Record<string, unknown>;
        if (raw.done !== undefined && !isWatchResult(raw.done)) {
            throw new Error("the poll's finish line is not a result");
        }
        const nextPollMs = finite(raw.nextPollMs);
        return {
            state: plainJson(raw.state, "the state a poll returns"),
            ...(raw.done === undefined ? {} : { done: raw.done }),
            ...(nextPollMs === undefined ? {} : { nextPollMs }),
        };
    }

    async function poll(entry: Held): Promise<void> {
        const { saved } = entry;
        const kind = kinds.get(saved.kind);
        if (!isRunning(entry) || kind === undefined || entry.polling) return;

        const firstAfterRestart = entry.restarted;
        entry.restarted = false;
        entry.polling = true;
        const controller = new AbortController();
        entry.abort = controller;

        let outcome: PollOutcome<unknown> | undefined;
        let failure: string | undefined;
        try {
            const asked = limited(entry, controller, async () => kind.poll(saved.spec, saved.state, controller.signal));
            outcome = checked(await asked);
        } catch (error) {
            failure = errorMessage(error);
        }
        entry.polling = false;
        entry.abort = undefined;
        if (entry.pollTimer !== undefined) timers.clearTimeout(entry.pollTimer);
        entry.pollTimer = undefined;
        // Stopped, or the session ended, while the poll was out: its answer is of no use now.
        if (!isRunning(entry)) return;

        try {
            afterPoll(entry, kind, outcome, failure, { tell: true, afterRestart: firstAfterRestart });
        } catch (error) {
            problem = `watch ${saved.id} could not be updated: ${errorMessage(error)}`;
        }
    }

    /** What follows a poll: finish, pause, or schedule the next one. */
    function afterPoll(
        entry: Held,
        kind: Kind,
        outcome: PollOutcome<unknown> | undefined,
        failure: string | undefined,
        ending: Ending,
    ): void {
        const { saved } = entry;

        if (outcome !== undefined && failure === undefined) {
            saved.state = outcome.state;
            saved.failures = 0;
            entry.lastError = undefined;
            if (outcome.done !== undefined) return finish(entry, outcome.done, ending);
        } else {
            entry.lastError = failure;
            saved.failures += 1;
        }
        // The last poll is made at the deadline. If it did not finish the watch, nothing more can be learned.
        if (now() >= Date.parse(saved.deadlineAt)) return finish(entry, timedOut(entry), ending);
        if (saved.failures >= PAUSE_AFTER_FAILURES) return pause(entry);

        checkStall(entry);
        persist(saved);
        arm(entry, nextDelay(saved, kind, outcome));
    }

    function timedOut(entry: Held): WatchResult {
        const { saved } = entry;
        const limit = formatAge(Date.parse(saved.deadlineAt) - Date.parse(saved.startedAt));
        const why = entry.lastError === undefined ? "" : ` The last check failed: ${entry.lastError}`;
        return { outcome: "timed-out", summary: `It was not finished after ${limit}, so Pi stopped watching.${why}` };
    }

    /** The user gets one "still waiting" notice when a watch outlives its stall time. It does not wake the agent. */
    function checkStall(entry: Held): void {
        const { saved } = entry;
        if (saved.stalled === true || now() < Date.parse(saved.stallAt)) return;
        const ran = formatAge(now() - Date.parse(saved.startedAt));
        let seen = false;
        guarded(() => {
            seen = options.notify(`Still waiting for "${titleOf(saved)}": it has been running for ${ran}.`, "warning");
        });
        // With no screen nobody saw it, so it is still owed to a session that has one.
        if (seen) saved.stalled = true;
    }

    /** Three failures in a row: the watch stops polling until the session starts again. */
    function pause(entry: Held): void {
        const { saved } = entry;
        saved.status = "paused";
        stopTimers(entry);
        persist(saved);
        const error = cleanLine(entry.lastError ?? "", protect, MAX_ERROR_CHARS);
        const title = titleOf(saved);
        const cause = error === "" ? "" : ` (${error})`;
        guarded(() => {
            const notice = `Paused "${title}": ${saved.failures} polls in a row failed${cause}.`;
            options.notify(`${notice} It starts again when this session next starts.`, "warning");
        });
        outbox.add({
            event: "paused",
            id: saved.id,
            kind: saved.kind,
            plugin: saved.plugin,
            title,
            failures: saved.failures,
            ...(error === "" ? {} : { error }),
        });
    }

    /** Ends a watch: cleans and saves its result, tells other plugins, and (unless asked not to) tells the agent. */
    function finish(entry: Held, raw: WatchResult, ending: Ending): void {
        const { saved } = entry;
        if (saved.status === "done") return;
        stopTimers(entry);
        const result = cleanResult(raw, protect);
        saved.status = "done";
        saved.result = result;
        saved.finishedAt = iso(now());
        delete saved.state;
        persist(saved);

        const event: WatchDoneEvent = {
            id: saved.id, kind: saved.kind, plugin: saved.plugin, title: saved.title, result: structuredClone(result),
        };
        // A listener that fails does not change how the watch ended.
        guarded(() => options.emit(event));

        if (!ending.tell) return;
        outbox.add({
            event: "finished",
            id: saved.id,
            kind: saved.kind,
            plugin: saved.plugin,
            title: titleOf(saved),
            result,
            ...(ending.afterRestart === true ? { afterRestart: true } : {}),
        });
    }

    // ---- the contract -----------------------------------------------------------------------------------------------

    const registerKind: Watches["registerKind"] = (kind) => {
        checkKind(kind);
        // Registering a kind again replaces it: Pi loads plugins again on a reload.
        kinds.set(kind.kind, kind as Kind);
        // A watch that was waiting for this plugin starts polling now.
        for (const entry of held.values()) {
            const waiting = entry.saved.kind === kind.kind && isRunning(entry) && entry.timer === undefined;
            if (waiting && !entry.polling) arm(entry, FIRST_POLL_MS);
        }
    };

    const start: Watches["start"] = (watch) => {
        if (session === undefined) throw new Error("a watch can be started only while a session is running");
        const kind = kinds.get(watch?.kind);
        if (kind === undefined) {
            const name = plainLine(String(watch?.kind), 60);
            throw new Error(`no watch kind is registered as "${name}": is the plugin that supplies it loaded?`);
        }
        if (typeof watch.title !== "string" || watch.title.trim() === "") {
            throw new TypeError("watches.start: the watch needs a title");
        }
        const spec = plainJson(watch.spec, "watches.start: the spec");
        const timeoutMinutes = minutesOf(watch.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES, "timeoutMinutes");
        const stallMinutes = minutesOf(watch.stallMinutes, DEFAULT_STALL_MINUTES, "stallMinutes");

        const startedAt = now();
        const saved: SavedWatch = {
            version: 1,
            id: store.newId(),
            kind: kind.kind,
            plugin: kind.plugin,
            title: plainLine(watch.title, MAX_TITLE_CHARS),
            spec,
            status: "open",
            startedAt: iso(startedAt),
            deadlineAt: iso(startedAt + timeoutMinutes * 60_000),
            stallAt: iso(startedAt + stallMinutes * 60_000),
            session,
            failures: 0,
        };
        const entry: Held = { saved, polling: false, restarted: false };
        held.set(saved.id, entry);
        persist(saved);
        arm(entry, FIRST_POLL_MS);
        return saved.id;
    };

    /** This session's watches that `list` shows, oldest first. */
    function listed(): Held[] {
        const time = now();
        const byAge = (a: Held, b: Held) =>
            Date.parse(a.saved.startedAt) - Date.parse(b.saved.startedAt) || (a.saved.id < b.saved.id ? -1 : 1);
        return [...held.values()]
            .filter((entry) => entry.saved.status !== "done" || time - finishedAtOf(entry.saved) <= LIST_WINDOW_MS)
            .sort(byAge);
    }

    function infoOf(saved: SavedWatch): WatchInfo {
        return {
            id: saved.id,
            kind: saved.kind,
            plugin: saved.plugin,
            title: saved.title,
            status: saved.status,
            startedAt: saved.startedAt,
            ...(saved.result === undefined ? {} : { result: structuredClone(saved.result) }),
        };
    }

    const list: Watches["list"] = () => listed().map((entry) => infoOf(entry.saved));

    const stop: Watches["stop"] = (id) => {
        const entry = typeof id === "string" ? held.get(id.trim()) : undefined;
        if (entry === undefined || entry.saved.status === "done") return false;
        entry.abort?.abort();
        finish(entry, { outcome: "stopped", summary: "Stopped before it finished." }, { tell: false });
        return true;
    };

    // ---- what only jig-core uses ------------------------------------------------------------------------------------

    /** What the kind says the spec watches, as one short line, or undefined. */
    function describeSpec(saved: SavedWatch): string | undefined {
        let text: unknown;
        guarded(() => { text = kinds.get(saved.kind)?.describe(saved.spec); });
        return typeof text === "string" && text !== "" ? plainLine(text, MAX_TITLE_CHARS) : undefined;
    }

    function entriesForTool(): WatchEntry[] {
        const time = now();
        return listed().map(({ saved }) => {
            const describes = describeSpec(saved);
            return {
                ...infoOf(saved),
                waiting: saved.status === "open" && !kinds.has(saved.kind),
                ageMs: time - Date.parse(saved.startedAt),
                ...(describes === undefined ? {} : { describes }),
            };
        });
    }

    function readSaved(): SavedWatch[] {
        try {
            const { watches, unreadable } = store.load();
            if (unreadable > 0) {
                problem = `${unreadable} saved watch file${unreadable === 1 ? "" : "s"} could not be read`;
            }
            return watches;
        } catch (error) {
            problem = `could not read the saved watches: ${errorMessage(error)}`;
            return [];
        }
    }

    /** A saved watch of this session that was open when Pi closed: it goes on, with a fresh count if it was paused. */
    function pickUp(watch: SavedWatch): void {
        if (watch.status === "paused") {
            watch.status = "open";
            watch.failures = 0;
            persist(watch);
        }
        const entry: Held = { saved: watch, polling: false, restarted: true };
        held.set(watch.id, entry);
        if (kinds.has(watch.kind)) arm(entry, FIRST_POLL_MS);
    }

    function begin(sessionId: string): void {
        stopAll();
        session = sessionId;
        const time = now();
        for (const watch of readSaved()) {
            if (watch.status !== "done") {
                // Another session's watch stays as it is, until that session is opened again.
                if (watch.session === sessionId) pickUp(watch);
                continue;
            }
            const age = time - finishedAtOf(watch);
            if (age > RETENTION_MS) {
                try {
                    store.remove(watch.id);
                } catch (error) {
                    problem = `could not delete watch ${watch.id}: ${errorMessage(error)}`;
                }
            } else if (watch.session === sessionId && age <= LIST_WINDOW_MS) {
                held.set(watch.id, { saved: watch, polling: false, restarted: false });
            }
        }
    }

    function stopAll(): void {
        for (const entry of held.values()) {
            stopTimers(entry);
            entry.abort?.abort();
        }
        held.clear();
        outbox.clear();
    }

    function end(): void {
        stopAll();
        session = undefined;
    }

    return { registerKind, start, list, stop, begin, end, entries: entriesForTool, problem: () => problem };
}
