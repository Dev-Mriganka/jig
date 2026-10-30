// The summary on a big index: 100 000 calls and 20 000 turns over 90 days. Every query is meant to answer in under
// 200 ms. A test cannot promise that on a loaded machine, so the bound here is five times that; the times are printed,
// so a query that drifts towards the budget shows in the output long before it fails.
//
// Time is not the only check, because it is the noisiest. The plan of every statement is read from SQLite, and none
// may read a whole table: each must be a search in the index of its scope. And the figures are checked against a
// tally that the data generator keeps, so a fast query that counts the wrong rows fails too.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { CALL, insertSql, TURN } from "../src/fields.ts";
import { lastDays } from "../src/period.ts";
import { activeTicket, blockedOf, checksOf, costOf, hasRecords, summarize, toolsOf, waitOf } from "../src/queries.ts";
import type { Scope } from "../src/queries.ts";
import { daysRequest, blockFor } from "../src/summary.ts";
import { openForReading, openIndex } from "../src/store.ts";
import { NOW, paths } from "./support.ts";

const CALLS = 100_000;
const TURNS = 20_000;
/** What a single query may take here. The aim is 200 ms; this is the bound at which the test fails. */
const BOUND_MS = 1000;

process.env.TZ = "UTC";

// ---- the data -------------------------------------------------------------------------------------------------------

/** A small deterministic random generator, so that the data and the figures are the same on every run. */
function random(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TOOLS: Array<[string, string | undefined]> = [
    ["bash", undefined],
    ["read", undefined],
    ["edit", undefined],
    ["write", undefined],
    ["grep", undefined],
    ["find", undefined],
    ["git", "status"],
    ["git", "push"],
    ["git", "commit"],
    ["git", "diff"],
    ["ci", "watch"],
    ["ci", "status"],
    ["pr", "create"],
    ["pr", "view"],
    ["jira", "get"],
    ["jira", "search"],
    ["jira", "transition"],
    ["http", undefined],
    ["flow", "test"],
    ["release", "plan"],
];
const MODELS = ["claude-sonnet-5-5", "claude-opus-5", "claude-haiku-5", "gpt-5.2"];
const ROLES = ["main", "main", "main", "reviewer", "scout"];
const SESSIONS = 300;
const TICKETS = 40;
/** The ticket that a quarter of all calls belong to, to read a ticket as big as a busy project. */
const BIG_TICKET = "PROJ-1000";

interface Tally {
    failed: number;
    blocked: number;
    questions: number;
    waits: number[];
    cost: number;
    /** Durations by tool and action, in the order they were made. */
    durations: Map<string, number[]>;
    bigTicketCalls: number;
    sessionCalls: Map<string, number>;
    /** Calls on the last day, and on the last seven. */
    today: number;
    week: number;
}

/**
 * The index, made as the importer would: rows in the order of their time, in one transaction. Returns what the data
 * holds, counted while it was made and not read back from the index.
 */
function build(file: string): Tally {
    const db = openIndex(file);
    const rand = random(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const sessions = Array.from(
        { length: SESSIONS },
        (_, i) => `session-${String(i).padStart(4, "0")}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    );
    const ticketOf = new Map(
        sessions.map((session, i) => [
            session,
            i % 4 === 0 ? BIG_TICKET : rand() < 0.5 ? `PROJ-${1001 + (i % (TICKETS - 1))}` : null,
        ]),
    );
    const end = NOW.getTime() / 1000;
    const span = 90 * 86400 - 86400;
    const tally: Tally = {
        failed: 0,
        blocked: 0,
        questions: 0,
        waits: [],
        cost: 0,
        durations: new Map(),
        bigTicketCalls: 0,
        sessionCalls: new Map(),
        today: 0,
        week: 0,
    };
    const todayFrom = lastDays(NOW, 1).from;
    const weekFrom = lastDays(NOW, 7).from;

    const insertCall = db.prepare(insertSql("call", CALL));
    const insertTurn = db.prepare(insertSql("turn", TURN));
    db.exec("BEGIN");
    for (let i = 0; i < CALLS; i++) {
        const [tool, action] = pick(TOOLS);
        const session = pick(sessions);
        const ticket = ticketOf.get(session) ?? null;
        const row: Record<string, string | number | null> = Object.fromEntries(CALL.map((field) => [field.name, null]));
        Object.assign(row, {
            id: `c${i}`,
            time: end - span + (i / CALLS) * span,
            session,
            agentRole: pick(ROLES),
            ticket,
            tool,
            action: action ?? null,
            plugin: "jig-test",
            environment: "local",
            environmentKind: "local",
            effect: "read",
            decision: "allow",
            decisionSource: "table",
            outcome: "ok",
            toolCallId: `tc${i}`,
            durationMs: Math.round(Math.exp(rand() * 9)),
        });
        const r = rand();
        if (r < 0.04) {
            Object.assign(row, {
                outcome: "error",
                errorKind: pick(["tool", "tool", "tool", "not-run", "withheld"]),
                error: "it failed",
            });
            tally.failed++;
        } else if (r < 0.07) {
            const [source, kind] = pick([
                ["floor", "denied"],
                ["floor", "no-screen"],
                ["rule", "denied"],
                ["table", "declined"],
                ["unknown", "dismissed"],
                ["tool", "invalid"],
            ] as const);
            Object.assign(row, {
                outcome: "blocked",
                errorKind: kind,
                decisionSource: source,
                decision: kind === "declined" || kind === "dismissed" ? "ask" : "deny",
                durationMs: null,
            });
            tally.blocked++;
        }
        if (rand() < 0.03) {
            const waited = Math.round(500 + rand() * 60_000);
            Object.assign(row, {
                decision: "ask",
                approval: "dialog",
                answer: pick(["allow", "allow", "allow-session", "decline"]),
                waitedMs: waited,
            });
            tally.questions++;
            tally.waits.push(waited);
        }
        if (rand() < 0.03)
            row.facts = JSON.stringify({
                passed: Math.round(rand() * 100),
                failed: Math.round(rand() * 3),
                conclusion: pick(["success", "failure"]),
            });

        if (row.durationMs !== null) {
            const key = `${tool}\u0000${action ?? ""}`;
            tally.durations.set(key, [...(tally.durations.get(key) ?? []), Number(row.durationMs)]);
        }
        if (ticket === BIG_TICKET) tally.bigTicketCalls++;
        if (Number(row.time) >= todayFrom) tally.today++;
        if (Number(row.time) >= weekFrom) tally.week++;
        tally.sessionCalls.set(session, (tally.sessionCalls.get(session) ?? 0) + 1);
        insertCall.run(...CALL.map((field) => row[field.name] ?? null));
    }
    for (let i = 0; i < TURNS; i++) {
        const session = pick(sessions);
        const row: Record<string, string | number | null> = {
            id: `t${i}`,
            time: end - span + (i / TURNS) * span,
            session,
            parentSession: null,
            agentRole: pick(ROLES),
            ticket: ticketOf.get(session) ?? null,
            model: pick(MODELS),
            input: Math.round(rand() * 3000),
            output: Math.round(rand() * 800),
            cacheRead: Math.round(rand() * 90_000),
            cacheWrite: Math.round(rand() * 2000),
            cost: rand() * 0.2,
        };
        tally.cost += Number(row.cost);
        insertTurn.run(...TURN.map((field) => row[field.name] ?? null));
    }
    db.exec("COMMIT");
    db.close();
    return tally;
}

/** The big index is made once, for all the tests of this file, and removed after the last. */
let folder = "";
let db: DatabaseSync;
let tally: Tally;
let buildMs = 0;

before(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), "jig-lens-perf-"));
    const file = paths(folder).index;
    const started = performance.now();
    tally = build(file);
    buildMs = performance.now() - started;
    const reading = openForReading(file);
    assert.ok(reading);
    db = reading;
});

after(() => {
    if (db.isOpen) db.close();
    rmSync(folder, { recursive: true, force: true });
});

// ---- timing and plans -----------------------------------------------------------------------------------------------

/** The best of three runs, in milliseconds: the least disturbed by whatever else the machine is doing. */
function best(run: () => unknown): number {
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
        const started = performance.now();
        run();
        fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
}

const range = (days: number): Scope => {
    const { from, to } = lastDays(NOW, days);
    return { kind: "period", from, to };
};

const SESSION = "session-0007-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SCOPES: Array<[string, Scope]> = [
    ["90 days (every call)", range(90)],
    ["7 days", range(7)],
    ["today", range(1)],
    ["a session", { kind: "session", session: SESSION }],
    ["a big ticket", { kind: "ticket", ticket: BIG_TICKET }],
    ["a small ticket", { kind: "ticket", ticket: "PROJ-1007" }],
];

const QUERIES = {
    cost: costOf,
    tools: toolsOf,
    "your time": waitOf,
    blocked: blockedOf,
    checks: checksOf,
} as const;

test("the index holds 100 000 calls and 20 000 turns, and was made in order of time", (t) => {
    t.diagnostic(`built in ${buildMs.toFixed(0)} ms`);
    assert.equal(db.prepare("SELECT count(*) AS n FROM call").get()?.n, CALLS);
    assert.equal(db.prepare("SELECT count(*) AS n FROM turn").get()?.n, TURNS);
    assert.equal(hasRecords(db), true);
});

test("every query answers within the bound on every scope, and the times are printed", (t) => {
    const lines: string[] = [];
    let slowest = 0;
    for (const [scopeName, scope] of SCOPES) {
        for (const [queryName, query] of Object.entries(QUERIES)) {
            const ms = best(() => query(db, scope));
            slowest = Math.max(slowest, ms);
            lines.push(`${scopeName.padEnd(22)} ${queryName.padEnd(10)} ${ms.toFixed(1).padStart(7)} ms`);
            assert.ok(ms < BOUND_MS, `${queryName} on ${scopeName} took ${ms.toFixed(0)} ms (bound ${BOUND_MS} ms)`);
        }
    }
    t.diagnostic(`slowest query: ${slowest.toFixed(1)} ms (the aim is under 200)\n${lines.join("\n")}`);
});

test("the whole summary of the widest scope, and of the three scopes /lens shows, fits the bound too", (t) => {
    const wide = best(() => summarize(db, range(90)));
    const usual = best(() => {
        blockFor(db, daysRequest(NOW, 1), NOW);
        blockFor(db, { title: "This session", scope: { kind: "session", session: SESSION } }, NOW);
        activeTicket(db, SESSION);
        blockFor(db, { title: "Ticket", scope: { kind: "ticket", ticket: BIG_TICKET } }, NOW);
    });
    t.diagnostic(`all five sections over 90 days: ${wide.toFixed(0)} ms; what /lens shows: ${usual.toFixed(0)} ms`);
    assert.ok(wide < BOUND_MS * 3, `${wide.toFixed(0)} ms`);
    assert.ok(usual < BOUND_MS, `${usual.toFixed(0)} ms`);
});

test("the active ticket and the check for records are a step in an index each", () => {
    assert.ok(best(() => activeTicket(db, SESSION)) < 50);
    assert.ok(best(() => hasRecords(db)) < 50);
});

/** The statements a function prepares, recorded as it runs. */
function recording(db: DatabaseSync): { db: DatabaseSync; statements: string[] } {
    const statements: string[] = [];
    const spy = new Proxy(db, {
        get(target, name) {
            if (name === "prepare") {
                return (sql: string) => {
                    statements.push(sql);
                    return target.prepare(sql);
                };
            }
            const member = Reflect.get(target, name) as unknown;
            return typeof member === "function" ? member.bind(target) : member;
        },
    });
    return { db: spy, statements };
}

/** The plan of a statement, a line for each step. It is read with every value left empty, which does not change it. */
function planOf(sql: string): string[] {
    const marks = sql.split("?").length - 1;
    return db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array<null>(marks).fill(null))
        .map((row) => String(row.detail));
}

/** The steps of a plan that read the call or turn table. */
const readsOf = (plan: readonly string[]) => plan.filter((step) => /^(SCAN|SEARCH) (call|turn)\b/.test(step));

test("no statement reads a whole table: each is a search in the index of its scope", () => {
    const indexFor = { period: "time", session: "session", ticket: "ticket" } as const;
    let checked = 0;
    for (const [scopeName, scope] of SCOPES) {
        const spy = recording(db);
        for (const query of Object.values(QUERIES)) query(spy.db, scope);
        assert.ok(spy.statements.length >= 5, scopeName);
        for (const sql of spy.statements) {
            const reads = readsOf(planOf(sql));
            assert.ok(reads.length > 0, `${scopeName}: no read of a table in\n${sql}`);
            for (const step of reads) {
                assert.match(
                    step,
                    new RegExp(`^SEARCH (call|turn) USING (COVERING )?INDEX (call|turn)_${indexFor[scope.kind]} `),
                    `${scopeName}: ${step}\n${sql}`,
                );
                checked++;
            }
        }
    }
    assert.ok(checked >= 30, `${checked} steps were read`);
});

test("the active ticket is looked up in the session's index, one step in each table", () => {
    const spy = recording(db);
    activeTicket(spy.db, SESSION);
    assert.equal(spy.statements.length, 1);
    const reads = readsOf(planOf(spy.statements[0] ?? ""));
    assert.deepEqual(
        reads.map((step) => step.replace(/ \(.*$/, "")),
        ["SEARCH call USING INDEX call_session", "SEARCH turn USING INDEX turn_session"],
    );
    for (const step of reads)
        assert.match(step, /\(session=\?\)$/, "by session alone, and the index gives it in time order");
});

// ---- the figures ----------------------------------------------------------------------------------------------------

test("on the whole index the figures are the ones the data was made with", () => {
    const all = range(90);
    const tools = toolsOf(db, all);
    assert.equal(tools?.calls, CALLS);
    assert.equal(tools?.failed, tally.failed);
    assert.equal(tools?.blocked, tally.blocked);
    assert.equal(blockedOf(db, all)?.total, tally.blocked);
    const cost = costOf(db, all);
    assert.equal(cost?.turns, TURNS);
    assert.ok(Math.abs((cost?.cost ?? 0) - tally.cost) < 1e-6);
    const wait = waitOf(db, all);
    assert.equal(wait?.questions, tally.questions);
    assert.equal(
        wait?.totalMs,
        tally.waits.reduce((sum, ms) => sum + ms, 0),
    );
    const waits = [...tally.waits].sort((a, b) => a - b);
    const middle = Math.floor(waits.length / 2);
    assert.equal(
        wait?.medianMs,
        waits.length % 2 === 1 ? waits[middle] : ((waits[middle - 1] ?? 0) + (waits[middle] ?? 0)) / 2,
    );
});

test("the five slowest tools are the five with the largest 95th percentile, worked out from the data", () => {
    const expected = [...tally.durations]
        .map(([key, values]) => {
            const sorted = [...values].sort((a, b) => a - b);
            const [tool = "", action = ""] = key.split("\u0000");
            return {
                name: key,
                label: action === "" ? tool : `${tool} ${action}`,
                calls: sorted.length,
                p95: sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0,
            };
        })
        .sort((a, b) => b.p95 - a.p95 || b.calls - a.calls || (a.name < b.name ? -1 : 1))
        .slice(0, 5)
        .map((tool) => [tool.label, tool.calls, tool.p95]);
    const actual = toolsOf(db, range(90))?.slowest.map((tool) => [
        tool.action === undefined ? tool.tool : `${tool.tool} ${tool.action}`,
        tool.calls,
        tool.p95Ms,
    ]);
    assert.deepEqual(actual, expected);
});

test("a session, a ticket and a day hold exactly their own rows", () => {
    assert.equal(toolsOf(db, { kind: "session", session: SESSION })?.calls, tally.sessionCalls.get(SESSION));
    assert.equal(toolsOf(db, { kind: "ticket", ticket: BIG_TICKET })?.calls, tally.bigTicketCalls);
    assert.equal(toolsOf(db, range(1))?.calls, tally.today);
    assert.equal(toolsOf(db, range(7))?.calls, tally.week);
    assert.ok(
        0 < tally.today && tally.today < tally.week && tally.week < CALLS,
        `${tally.today} < ${tally.week} < ${CALLS}`,
    );
});

test("the active ticket of a session on a ticket is that ticket, and of one on none is none", () => {
    assert.equal(
        activeTicket(db, "session-0000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
        BIG_TICKET,
        "every fourth session",
    );
    assert.equal(activeTicket(db, "no-such-session"), undefined);
    const others = Array.from(
        { length: SESSIONS },
        (_, i) => `session-${String(i).padStart(4, "0")}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    ).filter((session) => activeTicket(db, session) === undefined);
    assert.ok(others.length > 20, `${others.length} sessions are on no ticket`);
});
