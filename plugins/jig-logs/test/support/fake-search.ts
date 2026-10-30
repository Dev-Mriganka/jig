// A fake search backend, in two forms that answer from the same responder:
//   - a server on 127.0.0.1 for the direct backend, so real requests cross a real socket;
//   - a transport for the transport backend, registered on the fake jig-core.
// Both record what they were sent. A responder decides each answer, and it can answer with a timeout, a stall, a reset
// connection or an error of the kind a real backend sends. `fixtureResponder` answers from documents the way a backend
// does: it applies the range and the filters of the request body, sorts, counts and cuts to `size`.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Transport } from "../../../jig-core/src/contract.ts";

/** The address the configuration names. The fake server answers it through `routeTo`. */
export const PUBLIC_URL = "https://logs.test:9200";

export type Json = Record<string, any>;

export interface Recorded {
    method: string;
    /** The request path: a slash, the index pattern, `/_search`. */
    path: string;
    /** The index pattern in the path. */
    index: string;
    /** Header names in lower case. */
    headers: Record<string, string>;
    body: Json;
}

export interface Answer {
    status?: number;
    /** The reply, serialised as JSON. */
    json?: unknown;
    /** The reply as it is, for a reply that is not JSON. */
    text?: string;
    /** Headers to send with the reply, such as `location`. */
    headers?: Record<string, string>;
    /** Wait this long before answering. */
    delayMs?: number;
    /** Never answer: the backend is stuck. */
    hang?: boolean;
    /** Break the connection without an answer. */
    reset?: boolean;
}

/** Answers request `number`, counting from 1. */
export type Responder = (request: Recorded, number: number) => Answer | Promise<Answer>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- replies as a backend writes them ----------------------------------------------------------------------------

export interface ReplyOptions {
    hits?: Json[];
    total?: number;
    relation?: "eq" | "gte";
    timedOut?: boolean;
    failedShards?: number;
}

/** A successful `_search` reply. */
export function searchReply(options: ReplyOptions = {}): Answer {
    const hits = options.hits ?? [];
    const failed = options.failedShards ?? 0;
    return {
        json: {
            took: 12,
            timed_out: options.timedOut ?? false,
            _shards: { total: 5, successful: 5 - failed, skipped: 0, failed },
            hits: {
                total: { value: options.total ?? hits.length, relation: options.relation ?? "eq" },
                max_score: null,
                hits,
            },
        },
    };
}

/** An error reply of the kind OpenSearch and Elasticsearch send. */
export function errorReply(status: number, type: string): Answer {
    const cause = { type, reason: "synthetic" };
    return { status, json: { error: { root_cause: [cause], ...cause }, status } };
}

/** One hit as the backend returns it. */
export function hit(n: number, source: Json = {}): Json {
    return {
        _index: "app-staging-2026.10.13",
        _id: `id-${n}`,
        _source: {
            "@timestamp": `2026-10-13T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
            message: `message ${n}`,
            ...source,
        },
    };
}

/** The [from, to) range of a recorded search, as epoch milliseconds. */
export function rangeOf(request: Recorded): { from: number; to: number } {
    const filters: Json[] = request.body.query.bool.filter;
    const range = filters.find((filter) => filter.range)?.range as Json;
    const bounds = Object.values(range)[0] as { gte: string; lt: string };
    return { from: Date.parse(bounds.gte), to: Date.parse(bounds.lt) };
}

/** A search that fetches no hits: a later bucket that only counts, or the check for data. */
export function onlyCounts(request: Recorded): boolean {
    return request.body.size === 0;
}

// ---- answering from documents ---------------------------------------------------------------------------------

export type Doc = Record<string, unknown>;

function read(doc: Doc, field: string): unknown {
    return doc[field] ?? doc[field.replace(/\.keyword$/, "")];
}

/** The fake understands plain words, `A AND B` and `A OR B`; it is not Lucene. */
function matchesQuery(message: string, query: string): boolean {
    const text = message.toLowerCase();
    const has = (word: string) => text.includes(word.trim().toLowerCase().replace(/^"|"$/g, ""));
    if (query.includes(" AND ")) return query.split(" AND ").every(has);
    if (query.includes(" OR ")) return query.split(" OR ").some(has);
    return has(query);
}

function evaluate(body: Json, docs: readonly Doc[]): Answer {
    const filters: Json[] = body.query.bool.filter ?? [];
    const must: Json[] = body.query.bool.must ?? [];
    let rows = [...docs];
    let timeField = "@timestamp";
    for (const clause of filters) {
        if (clause.range !== undefined) {
            const [field, bounds] = Object.entries(clause.range)[0] as [string, Json];
            timeField = field;
            rows = rows.filter((doc) => {
                const time = Date.parse(String(read(doc, field)));
                return time >= Date.parse(bounds.gte) && time < Date.parse(bounds.lt);
            });
        } else if (clause.term !== undefined) {
            const [field, value] = Object.entries(clause.term)[0] as [string, unknown];
            rows = rows.filter((doc) => read(doc, field) === value);
        } else if (clause.terms !== undefined) {
            const [field, values] = Object.entries(clause.terms)[0] as [string, unknown[]];
            rows = rows.filter((doc) => values.includes(read(doc, field)));
        }
    }
    for (const clause of must) {
        if (clause.match_phrase !== undefined) {
            const [field, text] = Object.entries(clause.match_phrase)[0] as [string, string];
            rows = rows.filter((doc) => String(read(doc, field)).toLowerCase().includes(text.toLowerCase()));
        } else if (clause.query_string !== undefined) {
            const { query, default_field: field } = clause.query_string as Json;
            rows = rows.filter((doc) => matchesQuery(String(read(doc, field)), query));
        }
    }
    const direction = body.sort?.[0]?.[timeField]?.order === "desc" ? -1 : 1;
    rows.sort((a, b) => direction * (Date.parse(String(read(a, timeField))) - Date.parse(String(read(b, timeField)))));
    const fields: string[] | undefined = body._source;
    const hits = rows.slice(0, body.size).map((doc, n) => ({
        _index: "fixture",
        _id: `doc-${n}`,
        _source:
            fields === undefined
                ? doc
                : Object.fromEntries(fields.filter((field) => field in doc).map((field) => [field, doc[field]])),
    }));
    return searchReply({ hits, total: rows.length });
}

/** Answers every search from `docs`. */
export function fixtureResponder(docs: readonly Doc[]): Responder {
    return (request) => evaluate(request.body, docs);
}

// ---- the server -----------------------------------------------------------------------------------------------

export interface FakeServer {
    /** `http://127.0.0.1:<port>` */
    url: string;
    requests: Recorded[];
    close(): Promise<void>;
}

export async function startServer(responder: Responder): Promise<FakeServer> {
    const requests: Recorded[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            const path = req.url ?? "";
            const headers = Object.fromEntries(
                Object.entries(req.headers).map(([name, value]) => [
                    name,
                    Array.isArray(value) ? value.join(",") : (value ?? ""),
                ]),
            );
            const text = Buffer.concat(chunks).toString("utf8");
            const recorded: Recorded = {
                method: req.method ?? "",
                path,
                index: path.split("/")[1] ?? "",
                headers,
                body: text === "" ? {} : JSON.parse(text),
            };
            requests.push(recorded);
            try {
                const answer = await responder(recorded, requests.length);
                if (answer.reset) return void req.socket.destroy();
                if (answer.hang) return;
                if (answer.delayMs !== undefined) await sleep(answer.delayMs);
                res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
                res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
            } catch (error) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "fake_server_error", reason: String(error) } }));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** A `fetch` that sends the configured address to the fake server instead. */
export function routeTo(server: FakeServer): typeof fetch {
    return (input, init) => fetch(String(input).replace(PUBLIC_URL, server.url), init);
}

// ---- the transport --------------------------------------------------------------------------------------------

export interface FakeTransport extends Transport {
    requests: Recorded[];
}

/**
 * A transport that answers like the server. With `ignoreSignal` it does not stop when its signal fires, as another
 * package's code might not.
 */
export function fakeTransport(responder: Responder, options: { ignoreSignal?: boolean } = {}): FakeTransport {
    const requests: Recorded[] = [];
    return {
        requests,
        async request(request, signal) {
            const path = new URL(request.url).pathname;
            const recorded: Recorded = {
                method: request.method,
                path,
                index: path.split("/")[1] ?? "",
                headers: Object.fromEntries(
                    Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
                ),
                body: request.body === undefined ? {} : JSON.parse(request.body),
            };
            requests.push(recorded);
            const answer = await responder(recorded, requests.length);
            if (answer.reset) throw new Error("the connection was reset");
            if (answer.hang) {
                return new Promise((_, reject) => {
                    if (options.ignoreSignal !== true)
                        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            }
            if (answer.delayMs !== undefined) await sleep(answer.delayMs);
            return {
                status: answer.status ?? 200,
                headers: { "content-type": "application/json" },
                body: answer.text ?? JSON.stringify(answer.json ?? {}),
            };
        },
    };
}
