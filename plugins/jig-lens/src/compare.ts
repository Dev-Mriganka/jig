// `/lens compare`: how sessions under different conditions (the `condition` tag jig-core writes from `$JIG_CONDITION`)
// differ. Like queries.ts it is a plain function over an open connection, and nothing here knows about Pi or the screen.
//
// A session is a main session, one whose lines have the agent role `main`. The lines of its child agents (they carry
// the parent's id in `parentSession`) count toward it, so a session is the whole of one piece of work. A child whose
// parent has no line in the period is left out. The condition of a session is the one on its earliest main line;
// sessions without one are grouped as `(none)`.
//
// A side call is a short separate Pi process, such as a judge model call: its role is not `main` and it has no parent
// session. It is not a session, but its cost belongs to its condition, so it is counted apart and added to the cost.
//
// The period is a range of lines, not of sessions: a session that began before it or goes on after it counts only for
// the lines inside.
import type { DatabaseSync } from "node:sqlite";
import { median } from "./queries.ts";
import type { ToolName } from "./queries.ts";

/** The group of sessions that have no condition. A real condition cannot be called this: it has no brackets. */
export const NONE = "(none)";

/** The tools in the list of largest differences. */
export const TOOLS = 8;

export interface Stat {
    median: number;
    mean: number;
}

/** What one group of sessions did, per session unless said otherwise. */
export interface GroupFigures {
    condition: string;
    sessions: number;
    cost: Stat;
    /** Everything sent to the model: new input, cache reads and cache writes, as in the summary. */
    input: Stat;
    output: Stat;
    /** The share of the input the cache supplied. Undefined when no session of the group sent any input. */
    cacheShare: Stat | undefined;
    turns: Stat;
    calls: Stat;
    /** From the first to the last line of the session, children included. */
    wallMs: Stat;
    /** Over all the group's sessions together. */
    totalCalls: number;
    failed: number;
    blocked: number;
    /** Side calls under this condition (one for each process that wrote lines), and what they cost together. */
    sideCalls: number;
    sideCost: number;
    /** The cost of the sessions and the side calls together, divided by the number of sessions. */
    costWithSide: number;
}

/** A tool and its calls per session in each group, in the order of the groups. */
export interface ToolDifference extends ToolName {
    perSession: number[];
}

export interface Comparison {
    /** By name, with `(none)` last. */
    groups: GroupFigures[];
    /** The tools whose calls per session differ most between groups; empty with fewer than two groups. */
    tools: ToolDifference[];
}

/** The condition of a session or a side call: that of its earliest line that says one. */
interface Tagged {
    condition: string | undefined;
    /** The time of the line the condition came from. */
    conditionAt: number;
}

/** One session while its lines are read. */
interface Session extends Tagged {
    hasMain: boolean;
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    turns: number;
    calls: number;
    failed: number;
    blocked: number;
    first: number;
    last: number;
    tools: Map<string, { name: ToolName; calls: number }>;
}

/** One side-call process while its lines are read. */
interface Side extends Tagged {
    cost: number;
}

/** The first five columns both queries start with; the rest differ. */
type Line = [
    session: string,
    parentSession: string | null,
    agentRole: string,
    condition: string | null,
    time: number,
    ...rest: unknown[],
];

const keyOf = ({ tool, action }: ToolName) => `${tool}\u0000${action ?? ""}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stat(values: readonly number[]): Stat {
    const sorted = [...values].sort((a, b) => a - b);
    return { median: median(sorted) ?? 0, mean: values.reduce((sum, value) => sum + value, 0) / (values.length || 1) };
}

function note(into: Tagged, condition: string | null, time: number): void {
    if (time < into.conditionAt) {
        into.conditionAt = time;
        into.condition = condition ?? undefined;
    }
}

/**
 * The comparison over the lines in `[from, to)`, in seconds since the epoch. It reads every line of the period once,
 * as the tools figures do, because a line's session and condition are known only from the main lines around it.
 */
export function compareOf(db: DatabaseSync, from: number, to: number): Comparison {
    const sessions = new Map<string, Session>();
    const sides = new Map<string, Side>();

    /** The session a line counts toward, noting its time and, for a main line, its condition. Undefined for a side call
     *  (whose process is noted in `sides`) and for a child with no parent. */
    function place([session, parent, role, condition, time]: Line): Session | undefined {
        if (role !== "main" && parent === null) {
            const side = sides.get(session) ?? { condition: undefined, conditionAt: Number.POSITIVE_INFINITY, cost: 0 };
            note(side, condition, time);
            sides.set(session, side);
            return undefined;
        }
        const id = role === "main" ? session : String(parent);
        let found = sessions.get(id);
        if (found === undefined) {
            found = {
                condition: undefined,
                conditionAt: Number.POSITIVE_INFINITY,
                hasMain: false,
                cost: 0,
                input: 0,
                output: 0,
                cacheRead: 0,
                turns: 0,
                calls: 0,
                failed: 0,
                blocked: 0,
                first: time,
                last: time,
                tools: new Map(),
            };
            sessions.set(id, found);
        }
        found.first = Math.min(found.first, time);
        found.last = Math.max(found.last, time);
        if (role === "main") {
            found.hasMain = true;
            note(found, condition, time);
        }
        return found;
    }

    const turns = db.prepare(
        `SELECT session, parentSession, agentRole, condition, time, cost, input, output, cacheRead, cacheWrite
         FROM turn WHERE time >= ? AND time < ?`,
    );
    turns.setReturnArrays(true);
    for (const row of turns.all(from, to) as unknown as Line[]) {
        const [cost, input, output, cacheRead, cacheWrite] = row.slice(5) as number[];
        const session = place(row);
        if (session === undefined) {
            const side = sides.get(row[0]);
            if (side !== undefined) side.cost += cost ?? 0;
            continue;
        }
        session.turns++;
        session.cost += cost ?? 0;
        session.input += (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
        session.output += output ?? 0;
        session.cacheRead += cacheRead ?? 0;
    }

    const calls = db.prepare(
        `SELECT session, parentSession, agentRole, condition, time, tool, action, outcome
         FROM call WHERE time >= ? AND time < ?`,
    );
    calls.setReturnArrays(true);
    for (const row of calls.all(from, to) as unknown as Line[]) {
        const [tool, action, outcome] = row.slice(5) as [string, string | null, string];
        const session = place(row);
        if (session === undefined) continue;
        session.calls++;
        if (outcome === "error") session.failed++;
        else if (outcome === "blocked") session.blocked++;
        const name = { tool, action: action ?? undefined };
        const key = keyOf(name);
        const entry = session.tools.get(key) ?? { name, calls: 0 };
        entry.calls++;
        session.tools.set(key, entry);
    }

    const byCondition = new Map<string, Session[]>();
    for (const session of sessions.values()) {
        if (!session.hasMain) continue;
        const name = session.condition ?? NONE;
        byCondition.set(name, [...(byCondition.get(name) ?? []), session]);
    }
    // Side calls of a condition that has no session cannot be set against anything, so they are left out.
    const sideByCondition = new Map<string, Side[]>();
    for (const side of sides.values()) {
        const name = side.condition ?? NONE;
        sideByCondition.set(name, [...(sideByCondition.get(name) ?? []), side]);
    }
    const names = [...byCondition.keys()].sort((a, b) => (a === NONE ? 1 : b === NONE ? -1 : compare(a, b)));
    const groups = names.map((name) => figuresOf(name, byCondition.get(name) ?? [], sideByCondition.get(name) ?? []));
    return { groups, tools: toolDifferences(names.map((name) => byCondition.get(name) ?? [])) };
}

function figuresOf(condition: string, sessions: readonly Session[], sides: readonly Side[]): GroupFigures {
    const shares = sessions.filter((session) => session.input > 0).map((session) => session.cacheRead / session.input);
    const total = (pick: (session: Session) => number) => sessions.reduce((sum, session) => sum + pick(session), 0);
    const sideCost = sides.reduce((sum, side) => sum + side.cost, 0);
    return {
        condition,
        sessions: sessions.length,
        cost: stat(sessions.map((session) => session.cost)),
        input: stat(sessions.map((session) => session.input)),
        output: stat(sessions.map((session) => session.output)),
        cacheShare: shares.length === 0 ? undefined : stat(shares),
        turns: stat(sessions.map((session) => session.turns)),
        calls: stat(sessions.map((session) => session.calls)),
        wallMs: stat(sessions.map((session) => (session.last - session.first) * 1000)),
        totalCalls: total((session) => session.calls),
        failed: total((session) => session.failed),
        blocked: total((session) => session.blocked),
        sideCalls: sides.length,
        sideCost,
        costWithSide: (total((session) => session.cost) + sideCost) / sessions.length,
    };
}

/** The tools whose calls per session differ most between the groups, the largest difference first. */
function toolDifferences(groups: ReadonlyArray<readonly Session[]>): ToolDifference[] {
    if (groups.length < 2) return [];
    const names = new Map<string, ToolName>();
    const perGroup = groups.map((sessions) => {
        const counts = new Map<string, number>();
        for (const session of sessions) {
            for (const [key, { name, calls }] of session.tools) {
                names.set(key, name);
                counts.set(key, (counts.get(key) ?? 0) + calls);
            }
        }
        return { counts, sessions: sessions.length };
    });
    const tools = [...names].map(([key, name]) => ({
        ...name,
        perSession: perGroup.map(({ counts, sessions }) => (counts.get(key) ?? 0) / sessions),
    }));
    const spread = (tool: ToolDifference) => Math.max(...tool.perSession) - Math.min(...tool.perSession);
    return tools
        .filter((tool) => spread(tool) > 0)
        .sort((a, b) => spread(b) - spread(a) || compare(keyOf(a), keyOf(b)))
        .slice(0, TOOLS);
}
