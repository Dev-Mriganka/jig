// The log lines every real backend is seeded with, at known times, so one set of expectations holds for Elasticsearch,
// OpenSearch and Loki. All times are offsets from `base`, an hour boundary a few hours ago: recent enough for Loki, which
// refuses samples older than a week, and far enough back that no line is in the future.
import { randomBytes } from "node:crypto";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Line {
    /** Milliseconds since the epoch. */
    at: number;
    /** The environment's own name in the logs, which an environment's `filter` or `selector` finds. */
    env: "staging" | "prod";
    service: string;
    message: string;
}

/** A name for this run's data, so two runs against one backend do not meet. Lower case: an index name must be. */
export function runName(): string {
    return `jigit${randomBytes(4).toString("hex")}`;
}

/** The start of the data: an hour boundary three to four hours ago. */
export function baseTime(clock = Date.now()): number {
    return Math.floor((clock - 3 * HOUR) / HOUR) * HOUR;
}

/** The lines of the staging environment, in time order. Their counts are the expectations of the tests. */
export function dataset(base: number): Line[] {
    const lines: Line[] = [];
    const add = (at: number, env: Line["env"], service: string, message: string) =>
        lines.push({ at, env, service, message });

    // Forty ordinary lines, half a minute apart, from the start of the hour.
    for (let n = 0; n < 40; n++) {
        const id = String(n).padStart(4, "0");
        add(base + n * 30_000, "staging", "orders-api", `order accepted id=ord-${id} total=${10 + n}.50`);
    }
    // Three lines about one request, a few minutes later.
    for (const attempt of [1, 2, 3]) {
        add(
            base + (24 + attempt) * MINUTE,
            "staging",
            "orders-api",
            `payment timeout req-7f3a9c attempt ${attempt} of 3`,
        );
    }
    // Other services of the same environment: two that a list filter keeps, one that it drops.
    for (let n = 0; n < 5; n++) {
        add(base + (10 + n) * MINUTE, "staging", "billing-api", `invoice created inv-${100 + n}`);
        add(base + (12 + n) * MINUTE, "staging", "payments-api", `charge declined card-${200 + n}`);
    }
    // One line a long JSON body, which the result cuts and does not hide.
    add(
        base + 28 * MINUTE,
        "staging",
        "orders-api",
        `order batch ${JSON.stringify({
            batch: "b-1",
            items: Array.from({ length: 30 }, (_, n) => ({ sku: `sku-${n}`, quantity: n + 1, price: 19.99 })),
        })}`,
    );
    // Older lines, a day and two days and a half before, for the windows that are cut into buckets.
    add(base - 26 * HOUR, "staging", "orders-api", "nightly export finished rows=1200");
    add(base - 50 * HOUR, "staging", "orders-api", "nightly export finished rows=1180");
    add(base - 74 * HOUR, "staging", "orders-api", "nightly export finished rows=1175");

    // The production environment: personal data in free text and in a JSON body, which jig-core masks.
    add(base + 5 * MINUTE, "prod", "orders-api", "user jane.doe@example.com logged in from 203.0.113.9");
    add(base + 6 * MINUTE, "prod", "orders-api", 'callback requested {"order":"ord-77","phone":"+14155550123"}');
    add(base + 7 * MINUTE, "prod", "orders-api", "order accepted id=ord-0777 total=99.00");
    add(
        base + 8 * MINUTE,
        "prod",
        "orders-api",
        `customer export ${JSON.stringify({
            customers: Array.from({ length: 12 }, (_, n) => ({
                id: `c-${n}`,
                email: `person${n}@example.com`,
                plan: "basic",
            })),
        })}`,
    );

    return lines.sort((a, b) => a.at - b.at);
}

export const iso = (ms: number): string => new Date(ms).toISOString();
