// The index tables. Each column of `call` and `turn` is a field of jig-core's record (its records.ts), under the same
// name, so a query on the index reads like the record. The lists below are the one place that says how a field is read
// from a line and how its column is declared; a field jig-core adds later is ignored until it is added here.

/** How a record field becomes a column. */
type Kind =
    | "text"    // TEXT
    | "count"   // INTEGER: milliseconds and token counts
    | "number"  // REAL
    | "time"    // REAL: the record's ISO 8601 time as seconds since the epoch, which is what Grafana reads as a time
    | "json";   // TEXT: an object kept as JSON, for json_extract

export interface Field {
    name: string;
    kind: Kind;
    /** A line without it is not a record of this kind. */
    required?: true;
}

const required = (name: string, kind: Kind = "text"): Field => ({ name, kind, required: true });
const optional = (name: string, kind: Kind = "text"): Field => ({ name, kind });

/** The fields every line has. */
const LINE: readonly Field[] = [
    required("id"),
    required("time", "time"),
    required("session"),
    optional("parentSession"),
    required("agentRole"),
    optional("ticket"),
];

export const CALL: readonly Field[] = [
    ...LINE,
    required("tool"),
    optional("action"),
    optional("plugin"),
    optional("environment"),
    optional("environmentKind"),
    optional("effect"),
    optional("decision"),
    optional("decisionSource"),
    optional("approval"),
    optional("answer"),
    optional("waitedMs", "count"),
    required("outcome"),
    optional("errorKind"),
    optional("error"),
    optional("durationMs", "count"),
    required("toolCallId"),
    optional("parentToolCallId"),
    optional("spill"),
    optional("facts", "json"),
];

export const TURN: readonly Field[] = [
    ...LINE,
    required("model"),
    required("input", "count"),
    required("output", "count"),
    required("cacheRead", "count"),
    required("cacheWrite", "count"),
    required("cost", "number"),
];

const SQL_TYPE: Record<Kind, string> = { text: "TEXT", count: "INTEGER", number: "REAL", time: "REAL", json: "TEXT" };

function createTable(table: string, fields: readonly Field[]): string {
    const columns = fields.map((field) => {
        // The id is the key that makes a repeated import harmless: INSERT OR IGNORE skips a line already imported.
        const rule = field.name === "id" ? " NOT NULL PRIMARY KEY" : field.required ? " NOT NULL" : "";
        return `    ${field.name} ${SQL_TYPE[field.kind]}${rule}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${table} (\n${columns.join(",\n")}\n);`;
}

/**
 * Everything the index needs, as one script that is safe to run again. Plain tables, not STRICT ones: Datasette reads
 * the same file with whatever SQLite its Python was built with, and a database with a STRICT table needs 3.37 or later.
 */
export const SCHEMA = [
    createTable("call", CALL),
    createTable("turn", TURN),
    // How far each record file has been read: everything before `bytes` is in the tables. `skipped` counts the lines
    // in it that could not be read, and `at` is when it was last imported.
    `CREATE TABLE IF NOT EXISTS imported (
    file TEXT NOT NULL PRIMARY KEY,
    bytes INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    at REAL NOT NULL
);`,
    // Every summary and dashboard starts from one of three scopes: a time range, a session or a ticket. Each scope
    // has an index on both tables, ending in `time` so that a scope's rows come out in order. `IF NOT EXISTS` is also
    // how an index made before an index was added gets it, the next time the file is opened for writing, with no
    // rebuild.
    //
    // None starts with `tool`: no query asks for one tool's rows. The per-tool figures are made from the rows of a
    // scope, and a tool-first index only made session and ticket scopes slower (the planner chose it over their own).
    "CREATE INDEX IF NOT EXISTS call_time ON call (time);",
    "CREATE INDEX IF NOT EXISTS call_session ON call (session, time);",
    "CREATE INDEX IF NOT EXISTS call_ticket ON call (ticket, time);",
    "CREATE INDEX IF NOT EXISTS turn_time ON turn (time);",
    "CREATE INDEX IF NOT EXISTS turn_session ON turn (session, time);",
    "CREATE INDEX IF NOT EXISTS turn_ticket ON turn (ticket, time);",
].join("\n");

/** `INSERT OR IGNORE INTO call (id, time, ...) VALUES (?, ?, ...)`. */
export function insertSql(table: "call" | "turn", fields: readonly Field[]): string {
    const names = fields.map((field) => field.name).join(", ");
    const marks = fields.map(() => "?").join(", ");
    return `INSERT OR IGNORE INTO ${table} (${names}) VALUES (${marks})`;
}
