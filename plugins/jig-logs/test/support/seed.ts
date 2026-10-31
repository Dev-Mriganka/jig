// Puts the dataset into a real backend, and removes it. These use `fetch` directly, as the test's own setup: the tool
// under test never writes.
import type { Line } from "./dataset.ts";

export interface Connection {
    url: string;
    /** Headers every request carries: `Authorization` for Elasticsearch, `X-Scope-OrgID` for a Loki with tenants. */
    headers?: Readonly<Record<string, string>>;
}

export async function send(
    connection: Connection,
    method: string,
    path: string,
    body?: unknown,
    type = "application/json",
) {
    const response = await fetch(`${connection.url}${path}`, {
        method,
        headers: {
            ...(body === undefined ? {} : { "content-type": type }),
            ...connection.headers,
        },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
        throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
}

// ---- Elasticsearch and OpenSearch (the same API) -------------------------------------------------------------------

/**
 * Makes the index with the mapping a log index has (keywords for the fields a filter reads), puts the lines in, and makes
 * them searchable. `fields` names the time and message fields: the dataset's own, or others for a field-selection test.
 */
export async function seedIndex(
    connection: Connection,
    index: string,
    lines: readonly Line[],
    fields: { time: string; message: string; epoch?: boolean } = { time: "@timestamp", message: "message" },
): Promise<void> {
    await send(connection, "PUT", `/${index}`, {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
            properties: {
                [fields.time]: fields.epoch === true ? { type: "date", format: "epoch_millis" } : { type: "date" },
                [fields.message]: { type: "text" },
                env: { type: "keyword" },
                service: { type: "keyword" },
            },
        },
    });
    const bulk = lines
        .flatMap((line) => [
            JSON.stringify({ index: {} }),
            JSON.stringify({
                [fields.time]: fields.epoch === true ? line.at : new Date(line.at).toISOString(),
                [fields.message]: line.message,
                env: line.env,
                service: line.service,
            }),
        ])
        .join("\n");
    const reply = JSON.parse(
        await send(connection, "POST", `/${index}/_bulk?refresh=true`, `${bulk}\n`, "application/x-ndjson"),
    );
    if (reply.errors === true) throw new Error(`the bulk load failed: ${JSON.stringify(reply.items).slice(0, 300)}`);
}

export async function dropIndex(connection: Connection, index: string): Promise<void> {
    await send(connection, "DELETE", `/${index}`);
}

// ---- Loki ---------------------------------------------------------------------------------------------------------

/** Pushes the lines as streams labelled with `run`, `env` and `service`. */
export async function seedLoki(connection: Connection, run: string, lines: readonly Line[]): Promise<void> {
    const streams = new Map<string, { stream: Record<string, string>; values: Array<[string, string]> }>();
    for (const line of lines) {
        const key = `${line.env}/${line.service}`;
        let stream = streams.get(key);
        if (stream === undefined) {
            stream = { stream: { run, env: line.env, service: line.service }, values: [] };
            streams.set(key, stream);
        }
        stream.values.push([(BigInt(line.at) * 1_000_000n).toString(), line.message]);
    }
    // Loki wants the lines of a stream in time order.
    for (const stream of streams.values()) stream.values.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
    await send(connection, "POST", "/loki/api/v1/push", { streams: [...streams.values()] });
}
