// What a backend's reply is read into. Reading a reply is the backend's own work (see backends/); this is the shape
// the shared search receives, and the one helper every reader needs. Nothing here trusts the shape of what came back.
import { isObject } from "./values.ts";

/** The fields of one hit that were asked for: for Elasticsearch its `_source`, for Loki its labels, time and line. */
export type Source = Record<string, unknown>;

export interface SearchPage {
    /** How many hits the bucket holds, as far as the backend can tell. */
    total: number;
    /** "gte" when the backend only knows a lower bound. */
    relation: "eq" | "gte";
    hits: Source[];
    /** Set when this reply is known to be missing data. */
    incomplete?: "search_timeout" | "failed_shards";
}

/** The reply's JSON object, or undefined when the text is anything else. */
export function parseBody(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
}
