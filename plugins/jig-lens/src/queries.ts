// The questions the summary asks of the index, one function for each section. They are plain functions over an open
// connection, so a test runs each against an index built from sample records, and nothing here knows about Pi or the
// screen. The caller opens the index (read only is enough) and closes it.
//
// A scope picks out the rows first: all of a time range, a session or a ticket. Each has an index on both tables, so a
// query reads the rows of its scope and no others. After that SQLite makes the totals, except for the tools (see
// toolsOf), and the figures it has no function for, a percentile and a median, are made here.
//
// Times are seconds since the epoch, as in the index. A figure the scope has no rows for is `undefined`, and the
// section that would show it is left out.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** The rows a summary covers. A time range runs from `from` up to, not including, `to`. */
export type Scope =
    | { kind: "period"; from: number; to: number }
    | { kind: "session"; session: string }
    | { kind: "ticket"; ticket: string };

/** The condition that picks out a scope's rows, the same for `call` and `turn`, and the values to bind to it. */
function where(scope: Scope): { sql: string; params: SQLInputValue[] } {
    switch (scope.kind) {
        case "period":
            return { sql: "time >= ? AND time < ?", params: [scope.from, scope.to] };
        case "session":
            return { sql: "session = ?", params: [scope.session] };
        case "ticket":
            return { sql: "ticket = ?", params: [scope.ticket] };
    }
}

/** A tool, and its action when it has one. Calls are grouped by this, as the dashboards group them. */
export interface ToolName {
    tool: string;
    action: string | undefined;
}

const text = (value: unknown) => (value === null || value === undefined ? undefined : String(value));
/** Order by code unit, not by locale, so a figure's neighbours do not depend on the machine's language. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const toolOf = (row: Record<string, unknown>): ToolName => ({ tool: String(row.tool), action: text(row.action) });
const keyOf = ({ tool, action }: ToolName) => `${tool}\u0000${action ?? ""}`;

/** The value at nearest rank of a sorted list: the smallest value that `percent` of the list is at or below. */
export function percentile(sorted: readonly number[], percent: number): number | undefined {
    if (sorted.length === 0) return undefined;
    // Whole-number arithmetic: 0.95 * 20 is not exactly 19 in floating point, and one rank off is a different answer.
    const rank = Math.floor((percent * sorted.length + 99) / 100);
    return sorted[Math.max(1, rank) - 1];
}

/** The middle of a sorted list: the middle value, or the mean of the two in the middle. */
export function median(sorted: readonly number[]): number | undefined {
    if (sorted.length === 0) return undefined;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

// ---- cost -----------------------------------------------------------------------------------------------------------

export interface Spend {
    name: string;
    cost: number;
    turns: number;
}

export interface CostFigures {
    turns: number;
    /** Dollars, as Pi's usage data reports them. */
    cost: number;
    /** Everything sent to the model: new input, cache reads and cache writes. Pi's `input` is only the new part. */
    input: number;
    output: number;
    /** The part of `input` that the cache supplied. */
    cacheRead: number;
    /** Most expensive first. */
    byModel: Spend[];
    byRole: Spend[];
}

const byCost = (a: Spend, b: Spend) => b.cost - a.cost || compare(a.name, b.name);

function add(into: Map<string, Spend>, name: string, cost: number, turns: number): void {
    const spend = into.get(name) ?? { name, cost: 0, turns: 0 };
    spend.cost += cost;
    spend.turns += turns;
    into.set(name, spend);
}

/** What the model turns cost, in total and by model and by agent role. */
export function costOf(db: DatabaseSync, scope: Scope): CostFigures | undefined {
    const { sql, params } = where(scope);
    const rows = db
        .prepare(
            `SELECT model, agentRole, count(*) AS turns, sum(cost) AS cost, sum(input) AS input, sum(output) AS output,
                    sum(cacheRead) AS cacheRead, sum(cacheWrite) AS cacheWrite
             FROM turn WHERE ${sql} GROUP BY model, agentRole`,
        )
        .all(...params);
    if (rows.length === 0) return undefined;

    const figures: CostFigures = { turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, byModel: [], byRole: [] };
    const models = new Map<string, Spend>();
    const roles = new Map<string, Spend>();
    for (const row of rows) {
        const turns = Number(row.turns);
        const cost = Number(row.cost);
        figures.turns += turns;
        figures.cost += cost;
        figures.input += Number(row.input) + Number(row.cacheRead) + Number(row.cacheWrite);
        figures.output += Number(row.output);
        figures.cacheRead += Number(row.cacheRead);
        add(models, String(row.model), cost, turns);
        add(roles, String(row.agentRole), cost, turns);
    }
    figures.byModel = [...models.values()].sort(byCost);
    figures.byRole = [...roles.values()].sort(byCost);
    return figures;
}

// ---- tools ----------------------------------------------------------------------------------------------------------

export interface FailingTool extends ToolName {
    calls: number;
    failed: number;
    /** Why they failed, most common first. */
    kinds: Array<{ kind: string; count: number }>;
}

export interface SlowTool extends ToolName {
    /** Calls that have a duration. */
    calls: number;
    p95Ms: number;
}

export interface ToolFigures {
    calls: number;
    /** Calls that ran and failed. */
    failed: number;
    /** Calls that never ran: a rule, the floor or the user stopped them. */
    blocked: number;
    /** The tools that failed most, at most `TOP`. */
    failing: FailingTool[];
    /** The failing tools and failures that did not make the list. */
    failingElsewhere: { tools: number; failures: number };
    /** The tools with the slowest 95th percentile, at most `TOP`. */
    slowest: SlowTool[];
}

/** How many tools a list shows. */
export const TOP = 5;

/** What is known of one tool, and its action, while the calls are read. */
interface ToolTally extends ToolName {
    calls: number;
    failed: number;
    kinds: Map<string, number>;
    durations: number[];
}

/**
 * Calls, failures and durations, in total and by tool. This is the one section that needs a row for every call of
 * the scope: SQLite has no percentile function, so the durations are sorted here, and counting the same rows in
 * SQL as well would read them twice. What costs is the row itself and not the counting, so the rows are read as arrays
 * of values (an object for each of 100 000 rows takes longer than all the rest) and counted in one loop. Measured on
 * 100 000 calls: twice as fast as a GROUP BY for the counts and a second statement for the durations.
 *
 * A tool-first index would not make this cheaper, because the rows it would skip are the ones a session or a ticket
 * already leaves out.
 */
export function toolsOf(db: DatabaseSync, scope: Scope): ToolFigures | undefined {
    const { sql, params } = where(scope);
    const statement = db.prepare(`SELECT tool, action, outcome, errorKind, durationMs FROM call WHERE ${sql}`);
    statement.setReturnArrays(true);
    const rows = statement.all(...params) as unknown as Array<
        [tool: string, action: string | null, outcome: string, errorKind: string | null, durationMs: number | null]
    >;
    if (rows.length === 0) return undefined;

    const figures: ToolFigures = {
        calls: rows.length,
        failed: 0,
        blocked: 0,
        failing: [],
        failingElsewhere: { tools: 0, failures: 0 },
        slowest: [],
    };
    const tools = new Map<string, ToolTally>();
    for (const [tool, action, outcome, errorKind, durationMs] of rows) {
        const name = { tool, action: action ?? undefined };
        const key = keyOf(name);
        let tally = tools.get(key);
        if (tally === undefined) {
            tally = { ...name, calls: 0, failed: 0, kinds: new Map(), durations: [] };
            tools.set(key, tally);
        }
        tally.calls++;
        if (durationMs !== null) tally.durations.push(durationMs);
        if (outcome === "blocked") {
            figures.blocked++;
        } else if (outcome === "error") {
            figures.failed++;
            tally.failed++;
            const kind = errorKind ?? "unknown";
            tally.kinds.set(kind, (tally.kinds.get(kind) ?? 0) + 1);
        }
    }

    const failing = [...tools.values()]
        .filter((tally) => tally.failed > 0)
        .sort((a, b) => b.failed - a.failed || b.calls - a.calls || compare(keyOf(a), keyOf(b)));
    figures.failing = failing.slice(0, TOP).map(({ tool, action, calls, failed, kinds }) => ({
        tool,
        action,
        calls,
        failed,
        // Why they failed, the most common reason first.
        kinds: [...kinds]
            .map(([kind, count]) => ({ kind, count }))
            .sort((a, b) => b.count - a.count || compare(a.kind, b.kind)),
    }));
    figures.failingElsewhere = {
        tools: Math.max(0, failing.length - TOP),
        failures: failing.slice(TOP).reduce((sum, tally) => sum + tally.failed, 0),
    };

    const slow: SlowTool[] = [];
    for (const { tool, action, durations } of tools.values()) {
        if (durations.length === 0) continue;
        durations.sort((a, b) => a - b);
        slow.push({ tool, action, calls: durations.length, p95Ms: percentile(durations, 95) ?? 0 });
    }
    figures.slowest = slow
        .sort((a, b) => b.p95Ms - a.p95Ms || b.calls - a.calls || compare(keyOf(a), keyOf(b)))
        .slice(0, TOP);
    return figures;
}

// ---- your time ------------------------------------------------------------------------------------------------------

export interface WaitedTool extends ToolName {
    questions: number;
    waitedMs: number;
}

export interface WaitFigures {
    /** Calls that asked. */
    questions: number;
    allowed: number;
    allowedForSession: number;
    declined: number;
    /** The question was closed without an answer. */
    dismissed: number;
    totalMs: number;
    medianMs: number;
    /** The tools that waited longest in total, at most `TOP_WAITING`. */
    byTool: WaitedTool[];
}

export const TOP_WAITING = 3;

/** The questions the user was asked: how they answered and how long the calls waited. */
export function waitOf(db: DatabaseSync, scope: Scope): WaitFigures | undefined {
    const { sql, params } = where(scope);
    // A closed question is recorded as a decline with the error kind `dismissed`, so it takes the kind into account.
    const rows = db
        .prepare(
            `SELECT tool, action, answer, coalesce(errorKind, '') = 'dismissed' AS dismissed,
                    count(*) AS n, coalesce(sum(waitedMs), 0) AS waited
             FROM call WHERE ${sql} AND answer IS NOT NULL GROUP BY tool, action, answer, dismissed`,
        )
        .all(...params);
    if (rows.length === 0) return undefined;

    const figures: WaitFigures = {
        questions: 0,
        allowed: 0,
        allowedForSession: 0,
        declined: 0,
        dismissed: 0,
        totalMs: 0,
        medianMs: 0,
        byTool: [],
    };
    const tools = new Map<string, WaitedTool>();
    for (const row of rows) {
        const n = Number(row.n);
        const waited = Number(row.waited);
        figures.questions += n;
        figures.totalMs += waited;
        if (row.answer === "allow") figures.allowed += n;
        else if (row.answer === "allow-session") figures.allowedForSession += n;
        else if (row.answer === "decline") {
            if (Number(row.dismissed) === 1) figures.dismissed += n;
            else figures.declined += n;
        }

        const name = toolOf(row);
        const tool = tools.get(keyOf(name)) ?? { ...name, questions: 0, waitedMs: 0 };
        tool.questions += n;
        tool.waitedMs += waited;
        tools.set(keyOf(name), tool);
    }
    figures.byTool = [...tools.values()]
        .sort((a, b) => b.waitedMs - a.waitedMs || b.questions - a.questions || compare(keyOf(a), keyOf(b)))
        .slice(0, TOP_WAITING);

    // The waits of the scope are few (a question is a person's time), so the median is read from the sorted list.
    const waits = db
        .prepare(
            `SELECT waitedMs FROM call WHERE ${sql} AND answer IS NOT NULL AND waitedMs IS NOT NULL ORDER BY waitedMs`,
        )
        .all(...params)
        .map((row) => Number(row.waitedMs));
    figures.medianMs = median(waits) ?? 0;
    return figures;
}

// ---- blocked --------------------------------------------------------------------------------------------------------

export interface BlockedGroup {
    /** Who decided: `floor`, `rule`, `tool`, `table` or `unknown`. */
    source: string;
    /** `denied`, `no-screen`, `invalid`, `declined`, `dismissed` or `internal`. */
    kind: string;
    count: number;
    /** The tools that were blocked, most often first. */
    tools: Array<ToolName & { count: number }>;
}

export interface BlockedFigures {
    total: number;
    /** Largest group first. */
    groups: BlockedGroup[];
}

/** Calls that never ran, grouped by who decided and why. */
export function blockedOf(db: DatabaseSync, scope: Scope): BlockedFigures | undefined {
    const { sql, params } = where(scope);
    const rows = db
        .prepare(
            `SELECT coalesce(decisionSource, 'unknown') AS source, coalesce(errorKind, 'unknown') AS kind,
                    tool, action, count(*) AS n
             FROM call WHERE ${sql} AND outcome = 'blocked' GROUP BY source, kind, tool, action`,
        )
        .all(...params);
    if (rows.length === 0) return undefined;

    let total = 0;
    const groups = new Map<string, BlockedGroup>();
    for (const row of rows) {
        const n = Number(row.n);
        const key = `${String(row.source)}\u0000${String(row.kind)}`;
        const group = groups.get(key) ?? { source: String(row.source), kind: String(row.kind), count: 0, tools: [] };
        group.count += n;
        group.tools.push({ ...toolOf(row), count: n });
        groups.set(key, group);
        total += n;
    }
    for (const group of groups.values()) {
        group.tools.sort((a, b) => b.count - a.count || compare(keyOf(a), keyOf(b)));
    }
    const sorted = [...groups.values()].sort(
        (a, b) => b.count - a.count || compare(a.source, b.source) || compare(a.kind, b.kind),
    );
    return { total, groups: sorted };
}

// ---- checks ---------------------------------------------------------------------------------------------------------

export type FactValue = string | number | boolean;

export interface Check extends ToolName {
    /** When the call that reported these facts ended. */
    at: number;
    facts: Array<{ name: string; value: FactValue }>;
}

/** SQLite's JSON type of a fact says what its value was; a flag comes back as 1 or 0. */
function factValue(value: unknown, type: unknown): FactValue {
    if (type === "true") return true;
    if (type === "false") return false;
    return typeof value === "number" ? value : String(value);
}

/**
 * The facts each tool reported on its latest call that has any (test counts, a CI conclusion), most recent tool first.
 * `json_each` unfolds the facts, whose names belong to the tools and are not known here.
 */
export function checksOf(db: DatabaseSync, scope: Scope): Check[] {
    const { sql, params } = where(scope);
    // `facts` is a bare column next to max(time): SQLite takes it from the row that has the maximum.
    const rows = db
        .prepare(
            `SELECT latest.tool, latest.action, latest.time AS at,
                    fact.key AS name, fact.value AS value, fact.type AS type
             FROM (SELECT tool, action, max(time) AS time, facts
                   FROM call WHERE ${sql} AND facts IS NOT NULL GROUP BY tool, action) AS latest,
                  json_each(latest.facts) AS fact
             ORDER BY latest.time DESC, latest.tool, latest.action, fact.key`,
        )
        .all(...params);
    const checks = new Map<string, Check>();
    for (const row of rows) {
        const name = toolOf(row);
        const check = checks.get(keyOf(name)) ?? { ...name, at: Number(row.at), facts: [] };
        check.facts.push({ name: String(row.name), value: factValue(row.value, row.type) });
        checks.set(keyOf(name), check);
    }
    return [...checks.values()];
}

// ---- the session's ticket, and whether there is anything to show ----------------------------------------------------

/**
 * The ticket the session is on now: the ticket on its latest record, whether a call or a turn. A session that was
 * moved to another ticket, or off the ticket, answers with where it is now. Both lookups are one step in an index.
 */
export function activeTicket(db: DatabaseSync, session: string): string | undefined {
    const row = db
        .prepare(
            `SELECT ticket FROM (
                 SELECT time, ticket FROM (SELECT time, ticket FROM call WHERE session = ? ORDER BY time DESC LIMIT 1)
                 UNION ALL
                 SELECT time, ticket FROM (SELECT time, ticket FROM turn WHERE session = ? ORDER BY time DESC LIMIT 1)
             ) ORDER BY time DESC LIMIT 1`,
        )
        .get(session, session);
    return text(row?.ticket);
}

/** Whether the index holds any record at all. */
export function hasRecords(db: DatabaseSync): boolean {
    const row = db.prepare("SELECT EXISTS (SELECT 1 FROM call) OR EXISTS (SELECT 1 FROM turn) AS found").get();
    return Number(row?.found) === 1;
}

// ---- all of it ------------------------------------------------------------------------------------------------------

export interface Summary {
    cost: CostFigures | undefined;
    tools: ToolFigures | undefined;
    yourTime: WaitFigures | undefined;
    blocked: BlockedFigures | undefined;
    checks: Check[];
}

/** Every section's figures for one scope. */
export function summarize(db: DatabaseSync, scope: Scope): Summary {
    return {
        cost: costOf(db, scope),
        tools: toolsOf(db, scope),
        yourTime: waitOf(db, scope),
        blocked: blockedOf(db, scope),
        checks: checksOf(db, scope),
    };
}
