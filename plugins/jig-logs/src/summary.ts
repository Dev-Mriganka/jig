// Turns a search outcome into the short plain text the model reads: a header, what is missing, and one line per hit.
//
// jig-core masks production text line by line and withholds a line it cannot read, so nothing here repeats what the
// model sent: a `match` term such as `{"id"` would read as the start of a JSON payload, and the line that echoed it
// would be replaced. The filters are described by their count, never by their terms.
import { backendOf } from "./backends/index.ts";
import type { LogBackend } from "./backends/index.ts";
import { closedOffMarkers } from "./clip.ts";
import { nextStep } from "./failure.ts";
import type { FailureReason } from "./failure.ts";
import { DEFAULT_CHARS, FEW_HITS, MAX_CHARS, describeHit, hitsPerPage, rawMessage } from "./line.ts";
import type { Fields, Line, Shape } from "./line.ts";
import type { LogQuery } from "./query.ts";
import type { Source } from "./response.ts";
import type { Availability, SearchOutcome, SearchStatus, WindowReport } from "./search.ts";
import { iso } from "./time.ts";
import { plural } from "./values.ts";

const GAP_ROWS = 5;

/**
 * Which of the fetched hits are shown, how each is shown, and where the page starts. It is applied after the search
 * and never sent to it, so the same search with another view costs the same.
 */
export interface View extends Shape {
    /** Plain texts; a hit is shown only when its message contains all of them, ignoring case. */
    match?: string[];
    /** Plain texts; a hit is shown only when its message contains none of them, ignoring case. */
    exclude?: string[];
    offset: number;
}

/** What is left of the call for a program to read: counts and windows, never a message. */
export interface Details {
    status: SearchStatus;
    total: SearchOutcome["total"];
    fetched: number;
    shown: number;
    /** Hits that passed `match` and `exclude`, over all pages. Set when either was given. */
    matched?: number;
    buckets: number;
    splits: number;
    windows: WindowReport[];
}

export interface Summary {
    text: string;
    details: Details;
}

/**
 * The fetched hits that pass `match` and `exclude`, by position. Both read the whole message, not the characters a
 * line keeps, so a term near the end of a long message still finds it.
 */
function eligible(hits: Source[], view: View, fields: Fields): number[] {
    const lower = (terms: string[] | undefined) => terms?.map((term) => term.toLowerCase()) ?? [];
    const needles = lower(view.match);
    const unwanted = lower(view.exclude);
    const positions: number[] = [];
    hits.forEach((hit, position) => {
        if (needles.length === 0 && unwanted.length === 0) return void positions.push(position);
        const message = rawMessage(hit, fields).toLowerCase();
        const passes =
            needles.every((needle) => message.includes(needle)) && !unwanted.some((term) => message.includes(term));
        if (passes) positions.push(position);
    });
    return positions;
}

/** What the filters asked for, by count: the terms themselves are not repeated (see the top of this file). */
function filterWords(view: View): string {
    const parts: string[] = [];
    if (view.match !== undefined) parts.push(`all ${plural(view.match.length, "match term")}`);
    if (view.exclude !== undefined) parts.push(`none of ${plural(view.exclude.length, "exclude term")}`);
    return `contain ${parts.join(" and ")}`;
}

/** The windows that were not fully searched. Neighbours with the same reason read as one. */
function gapLines(windows: WindowReport[], backend: LogBackend): string[] {
    const groups: { from: string; to: string; reason: FailureReason | undefined }[] = [];
    for (const window of windows) {
        if (window.state === "searched") continue;
        const last = groups[groups.length - 1];
        if (last !== undefined && last.to === window.from && last.reason === window.reason) last.to = window.to;
        else groups.push({ from: window.from, to: window.to, reason: window.reason });
    }
    if (groups.length === 0) return [];
    const shownGroups = groups
        .slice(0, GAP_ROWS)
        .map((group) => `${group.from}..${group.to} ${group.reason ?? "unknown"}`);
    const more = groups.length > GAP_ROWS ? ` (+${groups.length - GAP_ROWS} more)` : "";
    const reasons = [
        ...new Set(
            groups.map((group) => group.reason).filter((reason): reason is FailureReason => reason !== undefined),
        ),
    ];
    return [
        `Gaps: ${shownGroups.join("; ")}${more}`,
        ...reasons.slice(0, 3).map((reason) => `Next: ${nextStep(reason, backend)}`),
    ];
}

function availabilityLine(availability: Availability): string {
    const caveat = "This only shows the window has data and proves nothing about retention.";
    if (availability.state === "documents") {
        const holds = `the window holds ${plural(availability.count ?? 0, "document")} in this environment`;
        return `Availability: ${holds} without your phrase or query. ${caveat}`;
    }
    if (availability.state === "none") {
        return `Availability: no documents at all in this environment and window. ${caveat}`;
    }
    const reason = availability.reason ?? "check failed";
    return `Availability: unknown (${reason}). Zero hits proves nothing about retention.`;
}

function headerLine(query: LogQuery, outcome: SearchOutcome, shown: number): string {
    const where = `${query.environment} ${iso(query.range.from)}..${iso(query.range.to)}`;
    if (outcome.status === "failed") return `${where}: failed, no window could be searched`;
    const { value, relation } = outcome.total;
    const parts: string[] = [outcome.status, `${relation === "gte" ? "at least " : ""}${plural(value, "hit")}`];
    if (outcome.hits.length > 0) {
        const first = query.order === "desc" ? "newest" : "oldest";
        parts.push(`${outcome.hits.length} fetched (${first} first)`, `${shown} shown`);
    }
    const split = outcome.splits > 0 ? ` (${outcome.splits} split after a timeout)` : "";
    parts.push(`${plural(outcome.windows.length, "bucket")}${split}`);
    return `${where}: ${parts.join(", ")}`;
}

/**
 * One line when a hit shows `{…}` or `[…]`. A model that reads it as "hidden" tells the user that a body is
 * unavailable, when it was only cut. Nothing is hidden: a structure the line cannot hold is closed off, whatever the
 * environment, and the complete message stays in the backend.
 */
function cutNotice(lines: Line[], chars: number): string | undefined {
    const marks = lines.map((line) => closedOffMarkers(line.message));
    const object = marks.some((mark) => mark.object);
    if (!object && !marks.some((mark) => mark.array)) return undefined;
    const label = object ? "{…} is a JSON body" : "[…] is a JSON list";
    const masking = "in production, personal values are masked and IDs are kept";
    // At the widest, more characters are not on offer: a window around the term is.
    const cut = "cut for length, not hidden";
    if (chars >= MAX_CHARS) {
        const longer = `longer than ${MAX_CHARS} characters, ${cut}`;
        return `${label} ${longer}: use around: "<term>" for the part you need; ${masking}.`;
    }
    return `${label} ${cut}: rerun with chars: ${MAX_CHARS} (or around: "<term>") to see it; ${masking}.`;
}

interface Counts {
    /** Hits fetched from the backend. */
    fetched: number;
    /** Of those, the hits that pass `match` and `exclude`. */
    passed: number;
    /** Hits on this page. */
    shown: number;
}

/** What the filters kept, and a reminder that they only see the hits that were fetched. */
function filterLine(view: View, counts: Counts, total: SearchOutcome["total"]): string {
    const { fetched, passed } = counts;
    const kept = `${passed} of ${fetched} fetched hits ${filterWords(view)} (case-insensitive, fetched hits only).`;
    if (total.value <= fetched) return kept;
    const atLeast = total.relation === "gte" ? "at least " : "";
    const holds = `The window holds ${atLeast}${total.value} hits and only ${fetched} were fetched, so more may exist:`;
    return `${kept} ${holds} narrow the window or search for something more exact, and search again.`;
}

/** The lines that say which hits follow: how many passed the filters, which range is on this page, how many remain. */
function pageLines(view: View, counts: Counts, total: SearchOutcome["total"]): string[] {
    const { passed, shown } = counts;
    const filtered = view.match !== undefined || view.exclude !== undefined;
    const out = filtered ? [filterLine(view, counts, total)] : [];
    if (passed === 0) return out;
    const noun = filtered ? "matching hits" : "fetched hits";
    if (view.offset >= passed) {
        const only = `there are only ${passed} ${noun} (offsets 0 to ${passed - 1})`;
        out.push(`offset ${view.offset} is past the end: ${only}.`);
        return out;
    }
    const end = view.offset + shown;
    const remaining = passed - end;
    // A plain page that shows every fetched hit needs no line of its own.
    if (!filtered && view.offset === 0 && remaining === 0) return out;
    const range = shown === 1 ? `Hit ${end}` : `Hits ${view.offset + 1}-${end}`;
    const rest = remaining > 0 ? `${remaining} more: call again with offset ${end}` : "none after these";
    out.push(`${range} of ${passed} ${noun}, ${rest}:`);
    return out;
}

export function summarize(query: LogQuery, outcome: SearchOutcome, view: View): Summary {
    const fields = query.target;
    const passing = eligible(outcome.hits, view, fields);
    const page = passing.slice(view.offset, view.offset + hitsPerPage(view.chars));
    // The default width is for scanning twenty lines. One to three are read, and a request body is one of them.
    const shape: Shape = view.chars === undefined && page.length <= FEW_HITS ? { ...view, chars: MAX_CHARS } : view;
    const lines = page.map((position) => describeHit(outcome.hits[position] as Source, fields, shape));
    const filtered = view.match !== undefined || view.exclude !== undefined;

    const out = [headerLine(query, outcome, lines.length), ...gapLines(outcome.windows, backendOf(query.target))];
    if (outcome.availability !== undefined) out.push(availabilityLine(outcome.availability));
    const notice = cutNotice(lines, shape.chars ?? DEFAULT_CHARS);
    if (notice !== undefined) out.push(notice);
    const counts = { fetched: outcome.hits.length, passed: passing.length, shown: lines.length };
    out.push(...pageLines(view, counts, outcome.total));
    for (const line of lines) out.push(line.time === "" ? line.message : `${line.time} ${line.message}`);

    return {
        text: out.join("\n"),
        details: {
            status: outcome.status,
            total: outcome.total,
            fetched: outcome.hits.length,
            shown: lines.length,
            ...(filtered ? { matched: passing.length } : {}),
            buckets: outcome.windows.length,
            splits: outcome.splits,
            windows: outcome.windows,
        },
    };
}
