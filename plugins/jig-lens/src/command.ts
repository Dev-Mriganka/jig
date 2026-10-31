// What the user typed after `/lens`, as a command. Parsing is separate from doing, so every spelling, including the
// wrong ones, is tested without a session.
import type { Viewer } from "./viewer.ts";

export type Command =
    | { kind: "summary" }
    | { kind: "ticket"; ticket: string }
    /** Without an id, the session the user is in. */
    | { kind: "session"; session?: string }
    | { kind: "days"; days: number }
    /** The conditions over the last `days` days, side by side. */
    | { kind: "compare"; days: number }
    /** The interactive view of cost and tokens from Pi's own session files. */
    | { kind: "usage-view" }
    | { kind: "viewer"; viewer: Viewer }
    | { kind: "rebuild" }
    | { kind: "status" }
    /** Something was wrong with the arguments. `problem` says what, when there is more to say than the usage. */
    | { kind: "usage"; problem?: string };

export const USAGE =
    "Usage: /lens [ticket KEY | session [id] | days N | compare [days N] | usage | grafana | datasette | rebuild | status]";

/** The commands that show a summary. */
export type SummaryCommand = Extract<Command, { kind: "summary" | "ticket" | "session" | "days" }>;

/** The days `/lens days` accepts: the index keeps no more than 90. */
export const MAX_DAYS = 90;

/** The days `/lens compare` covers when it is not told. */
export const COMPARE_DAYS = 30;

/** The days in `N`, or undefined when it is not a whole number from 1 to 90. */
function daysOf(count: string | undefined): number | undefined {
    const days = count !== undefined && /^\d+$/.test(count) ? Number(count) : Number.NaN;
    return days >= 1 && days <= MAX_DAYS ? days : undefined;
}

/** The words that start a command, with what each does, for the completions. */
export const WORDS: ReadonlyArray<readonly [word: string, what: string]> = [
    ["ticket", "one ticket, over all time"],
    ["session", "one session, this one by default"],
    ["days", `the last N days, 1 to ${MAX_DAYS}`],
    ["compare", "conditions side by side, the last 30 days or days N"],
    ["usage", "cost and tokens from Pi's session files, by period and model"],
    ["grafana", "open the Grafana dashboards"],
    ["datasette", "open the Datasette tables"],
    ["rebuild", "make the index again"],
    ["status", "the viewer, the index and the last import"],
];

const usage = (problem?: string): Command => (problem === undefined ? { kind: "usage" } : { kind: "usage", problem });

/** `/lens <args>`, parsed. White space around and between the words does not matter. */
export function parseCommand(args: string): Command {
    const [word, ...rest] = args
        .trim()
        .split(/\s+/)
        .filter((part) => part !== "");
    switch (word) {
        case undefined:
            return { kind: "summary" };
        case "grafana":
        case "datasette":
            return rest.length === 0 ? { kind: "viewer", viewer: word } : usage(`/lens ${word} takes no arguments.`);
        case "rebuild":
        case "status":
            return rest.length === 0 ? { kind: word } : usage(`/lens ${word} takes no arguments.`);
        case "usage":
            return rest.length === 0 ? { kind: "usage-view" } : usage("/lens usage takes no arguments.");
        case "ticket": {
            const [ticket, ...extra] = rest;
            if (ticket === undefined) return usage("/lens ticket needs a ticket key.");
            return extra.length === 0 ? { kind: "ticket", ticket } : usage("/lens ticket takes one ticket key.");
        }
        case "session": {
            const [session, ...extra] = rest;
            if (extra.length > 0) return usage("/lens session takes one session id.");
            return session === undefined ? { kind: "session" } : { kind: "session", session };
        }
        case "days": {
            const [count, ...extra] = rest;
            const days = daysOf(count);
            if (extra.length > 0 || days === undefined) {
                return usage(`/lens days takes a whole number from 1 to ${MAX_DAYS}.`);
            }
            return { kind: "days", days };
        }
        case "compare": {
            if (rest.length === 0) return { kind: "compare", days: COMPARE_DAYS };
            const [days, count, ...extra] = rest;
            const parsed = daysOf(count);
            if (days !== "days" || extra.length > 0 || parsed === undefined) {
                return usage(`/lens compare takes days N, a whole number from 1 to ${MAX_DAYS}, or nothing.`);
            }
            return { kind: "compare", days: parsed };
        }
        default:
            return usage();
    }
}

/** The completions for what is typed after `/lens `: the first word only. Null when nothing matches. */
export function completions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
    const matches = WORDS.filter(([word]) => word.startsWith(prefix));
    if (matches.length === 0) return null;
    return matches.map(([word, what]) => ({ value: word, label: word, description: what }));
}
