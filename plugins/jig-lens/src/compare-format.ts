// The comparison as text: one column for each condition. Like summary.ts this only words and lays out the figures from
// compare.ts, as a block of plain strings, so the screen can draw it again with the colours of the current theme.
import type { Comparison, GroupFigures, Stat, ToolDifference } from "./compare.ts";
import { duration, label, money, plural, table, tokens } from "./format.ts";
import { lastDays } from "./period.ts";
import { plain } from "./summary.ts";
import type { Block, Section } from "./summary.ts";

/** Fewer sessions than this in a group, and the comparison says so. */
export const ENOUGH_SESSIONS = 5;

/** `1.5`, `12`, `130`: a whole number as it is, a fraction with one decimal below 100. */
function number(value: number): string {
    if (Number.isInteger(value) || value >= 100) return String(Math.round(value));
    return value.toFixed(1);
}

const share = (part: number, whole: number) => `${whole <= 0 ? "0.0" : ((100 * part) / whole).toFixed(1)}%`;

/** A median and a mean as `median / mean`. */
const pair = (stat: Stat, format: (value: number) => string) => `${format(stat.median)} / ${format(stat.mean)}`;

const toolName = ({ tool, action }: ToolDifference) => label(action === undefined ? tool : `${tool} ${action}`);

/** The title: the days compared, on the user's own clock. */
function titleFor(now: Date, days: number): string {
    const range = lastDays(now, days);
    return days === 1
        ? `Conditions compared, today ${range.last}`
        : `Conditions compared, last ${days} days, ${range.first} to ${range.last}`;
}

function notes(groups: readonly GroupFigures[]): string[] {
    const lines: string[] = [];
    const smallest = Math.min(...groups.map((group) => group.sessions));
    if (smallest < ENOUGH_SESSIONS) {
        lines.push(
            `too few sessions to compare: a group has fewer than ${ENOUGH_SESSIONS}, so differences may be chance`,
        );
    }
    if (groups.length < 2) lines.push("only one condition in this period, so there is nothing to set it against");
    return lines;
}

function sessionRows(groups: readonly GroupFigures[]): string[][] {
    const row = (name: string, cell: (group: GroupFigures) => string) => [name, ...groups.map(cell)];
    return [
        ["per session: median / mean", ...groups.map((group) => label(group.condition, 32))],
        row("sessions", (group) => String(group.sessions)),
        row("cost", (group) => pair(group.cost, money)),
        row("cost incl. side calls", (group) => money(group.costWithSide)),
        row("input tokens", (group) => pair(group.input, tokens)),
        row("output tokens", (group) => pair(group.output, tokens)),
        row("cache read", (group) =>
            group.cacheShare === undefined ? "-" : pair(group.cacheShare, (value) => `${Math.round(100 * value)}%`),
        ),
        row("turns", (group) => pair(group.turns, number)),
        row("tool calls", (group) => pair(group.calls, number)),
        row("wall time", (group) => pair(group.wallMs, duration)),
        row("failed calls", (group) => `${share(group.failed, group.totalCalls)} of ${group.totalCalls}`),
        row("blocked calls", (group) => `${share(group.blocked, group.totalCalls)} of ${group.totalCalls}`),
        row("side calls", (group) => `${group.sideCalls}, ${money(group.sideCost)}`),
    ];
}

function toolRows(groups: readonly GroupFigures[], tools: readonly ToolDifference[]): string[][] {
    return [
        ["calls per session", ...groups.map((group) => label(group.condition, 32))],
        ...tools.map((tool) => [toolName(tool), ...tool.perSession.map(number)]),
    ];
}

/** The block for a comparison, or a one-line block when the period has no session. */
export function compareBlock(comparison: Comparison, now: Date, days: number): Block {
    const title = titleFor(now, days);
    const { groups, tools } = comparison;
    if (groups.length === 0) return { title, sections: [], empty: "no sessions" };
    const columns = groups.map((_, i) => i + 1);
    const smallest = Math.min(...groups.map((group) => group.sessions));
    const sections: Section[] = [];
    const warning = notes(groups);
    if (warning.length > 0) sections.push({ name: "Note", lines: warning });
    sections.push({ name: "Sessions", lines: table(sessionRows(groups), columns) });
    if (tools.length > 0) sections.push({ name: "Tools", lines: table(toolRows(groups, tools), columns) });
    sections.push({
        name: "Caution",
        lines: [`These numbers are not a test of significance. The smallest group has ${plural(smallest, "session")}.`],
    });
    return { title, sections };
}

/** The lines of a comparison that fit a notification: the notes, the top of the table and the caution. */
export function briefOf(block: Block): string {
    const cut: Block = {
        ...block,
        sections: block.sections.map((section) => ({
            ...section,
            lines:
                section.name === "Sessions" ? section.lines.slice(0, 3) : section.name === "Tools" ? [] : section.lines,
        })),
    };
    cut.sections = cut.sections.filter((section) => section.lines.length > 0);
    return plain([cut]);
}
