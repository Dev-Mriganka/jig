// What one `logs` call asks for, in terms every backend understands. A backend turns it into the request of its own
// store (see backends/). The model's text only ever reaches that request as one value, never as a key, a field name or
// a clause of its own, so a call cannot ask a store for anything else: no scripts, aggregations or other indexes.
import type { Target } from "./config.ts";
import type { Range } from "./time.ts";

/** What `text` is: an exact phrase, or a query in the backend's own language (Lucene, LogQL). */
export type SearchKind = "phrase" | "query";

/** Which end of the window the hits come from; the sort inside each request follows it. */
export type Order = "asc" | "desc";

/** What one `logs` call asks for, after its parameters were checked and the defaults applied. */
export interface LogQuery {
    /** The environment as the tool names it. */
    environment: string;
    target: Target;
    kind: SearchKind;
    text: string;
    /** How many hits to fetch in all. */
    size: number;
    /** asc: the oldest hits of the window. desc: the newest. */
    order: Order;
    range: Range;
    /**
     * Plain texts a hit must contain, and plain texts it must not. The view applies them to the hits fetched, whatever
     * the backend does. A backend that can look for them itself may send them too, so that the hits fetched are the
     * ones that pass (Loki does).
     */
    match?: string[];
    exclude?: string[];
}
