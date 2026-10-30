// The summary as text: what each section says, in short aligned lines. The figures come from queries.ts; this module
// only words and lays them out, so a golden test can pin every line.
//
// A summary is a list of blocks, one for each scope (today, a session, a ticket), and a block is a title and up to five
// sections. A section with nothing to say is left out, and a block with no sections says so on its title line. Blocks
// are plain data (strings only), so the screen can keep one and draw it again with the colours of the current theme.
import type { DatabaseSync } from "node:sqlite";
import { ago, duration, label, money, percent, plural, table, tokens } from "./format.ts";
import { lastDays } from "./period.ts";
import { summarize } from "./queries.ts";
import type {
    BlockedFigures,
    Check,
    CostFigures,
    Scope,
    Spend,
    ToolFigures,
    ToolName,
    WaitFigures,
} from "./queries.ts";

export interface Section {
    name: string;
    /** The lines under the name, without the name's column. The first sits on the name's own line. */
    lines: string[];
}

export interface Block {
    title: string;
    sections: Section[];
    /** Said after the title when the block has no sections. Without it, the title stands alone. */
    empty?: string;
}

/** A scope and the title it is shown under. */
export interface Request {
    title: string;
    scope: Scope;
}

// ---- the requests ---------------------------------------------------------------------------------------------------

/** The last `days` local days, the last of them today. One day is just today. */
export function daysRequest(now: Date, days: number): Request {
    const range = lastDays(now, days);
    const title = days === 1 ? `Today, ${range.last}` : `Last ${days} days, ${range.first} to ${range.last}`;
    return { title, scope: { kind: "period", from: range.from, to: range.to } };
}

/** One session. The title says "this session" for the one the user is in. */
export function sessionRequest(session: string, current: boolean): Request {
    return { title: current ? "This session" : `Session ${label(session, 60)}`, scope: { kind: "session", session } };
}

/** One ticket, over all time. */
export function ticketRequest(ticket: string): Request {
    return { title: `Ticket ${label(ticket, 40)}, all time`, scope: { kind: "ticket", ticket } };
}

// ---- the sections ---------------------------------------------------------------------------------------------------

/** A tool as it is called: `bash`, or `git push` when the call has an action. */
const toolName = ({ tool, action }: ToolName) => label(action === undefined ? tool : `${tool} ${action}`);

const more = (n: number, noun: string) => `${n} more ${noun}${n === 1 ? "" : "s"}`;

/** Rows for a list: the first row starts with the list's name, and the others leave that column empty. */
const listed = <T>(title: string, items: readonly T[], cells: (item: T) => string[]): string[][] =>
    items.map((item, i) => [i === 0 ? title : "", ...cells(item)]);

const MODELS = 5;
const ROLES = 4;
/** The longest model name shown. Model ids can be long, and every other column in the row is short. */
const MODEL_NAME = 40;

/** Rows for a list of spending, with what does not fit added up in a last row. */
function spendRows(title: string, spends: readonly Spend[], limit: number, noun: string): string[][] {
    const rows = listed(title, spends.slice(0, limit), (spend) => [label(spend.name, MODEL_NAME), money(spend.cost)]);
    const rest = spends.slice(limit);
    if (rest.length > 0) {
        rows.push(["", more(rest.length, noun), money(rest.reduce((sum, spend) => sum + spend.cost, 0))]);
    }
    return rows;
}

function costSection(cost: CostFigures): Section {
    const total =
        `${money(cost.cost)} over ${plural(cost.turns, "turn")}, ` +
        `${tokens(cost.input)} tokens in (${percent(cost.cacheRead, cost.input)} read from cache), ` +
        `${tokens(cost.output)} out`;
    // A single role called "main" says nothing the total does not.
    const onlyMain = cost.byRole.length === 1 && cost.byRole[0]?.name === "main";
    const rows = [
        ...spendRows("by model", cost.byModel, MODELS, "model"),
        ...(onlyMain ? [] : spendRows("by agent", cost.byRole, ROLES, "agent")),
    ];
    return { name: "Cost", lines: [total, ...table(rows, [2])] };
}

function toolsSection(tools: ToolFigures): Section {
    const head = [
        plural(tools.calls, "call"),
        tools.failed > 0 ? `${tools.failed} failed` : "none failed",
        ...(tools.blocked > 0 ? [`${tools.blocked} blocked`] : []),
    ].join(", ");
    const rows = listed("failing", tools.failing, (tool) => [
        toolName(tool),
        `${tool.failed} of ${tool.calls}`,
        tool.kinds.map(({ kind, count }) => `${label(kind)} ${count}`).join(", "),
    ]);
    const elsewhere = tools.failingElsewhere;
    if (elsewhere.tools > 0) rows.push(["", more(elsewhere.tools, "tool"), `${elsewhere.failures} failed`, ""]);
    rows.push(
        ...listed("slowest", tools.slowest, (tool) => [
            toolName(tool),
            `p95 ${duration(tool.p95Ms)}`,
            plural(tool.calls, "call"),
        ]),
    );
    return { name: "Tools", lines: [head, ...table(rows, [2])] };
}

function waitSection(wait: WaitFigures): Section {
    const answers = [
        [wait.allowed, "allowed"],
        [wait.allowedForSession, "allowed for the session"],
        [wait.declined, "declined"],
        [wait.dismissed, "dismissed"],
    ]
        .filter(([count]) => Number(count) > 0)
        .map(([count, what]) => `${count} ${what}`);
    const head = plural(wait.questions, "question") + (answers.length === 0 ? "" : `: ${answers.join(", ")}`);
    const waited = `waited ${duration(wait.totalMs)} in total, median ${duration(wait.medianMs)}`;
    const rows = listed("by tool", wait.byTool, (tool) => [
        toolName(tool),
        duration(tool.waitedMs),
        plural(tool.questions, "question"),
    ]);
    return { name: "Your time", lines: [head, waited, ...table(rows, [2])] };
}

const BLOCKED_GROUPS = 6;
const BLOCKED_TOOLS = 3;

function blockedSection(blocked: BlockedFigures): Section {
    const rows = blocked.groups.slice(0, BLOCKED_GROUPS).map((group) => {
        const shown = group.tools.slice(0, BLOCKED_TOOLS).map((tool) => `${toolName(tool)} ${tool.count}`);
        if (group.tools.length > BLOCKED_TOOLS) shown.push(`${group.tools.length - BLOCKED_TOOLS} more`);
        return [label(group.source), label(group.kind), String(group.count), shown.join(", ")];
    });
    const rest = blocked.groups.slice(BLOCKED_GROUPS);
    if (rest.length > 0) {
        rows.push([more(rest.length, "group"), "", String(rest.reduce((sum, group) => sum + group.count, 0)), ""]);
    }
    return { name: "Blocked", lines: [plural(blocked.total, "call"), ...table(rows, [2])] };
}

const CHECKS = 5;
const FACTS = 6;

/** A fact as `name value`. */
const factText = ({ name, value }: Check["facts"][number]) =>
    `${label(name, 24)} ${typeof value === "string" ? label(value, 24) : String(value)}`;

function checksSection(checks: readonly Check[], now: Date): Section {
    const rows = checks.slice(0, CHECKS).map((check) => {
        const facts = check.facts.slice(0, FACTS).map(factText);
        if (check.facts.length > FACTS) facts.push(`${check.facts.length - FACTS} more`);
        return [toolName(check), facts.join(", "), ago(check.at, now)];
    });
    if (checks.length > CHECKS) rows.push([more(checks.length - CHECKS, "tool"), "", ""]);
    return { name: "Checks", lines: table(rows) };
}

/** The summary of one scope: its sections, or a note that there is nothing in it. */
export function blockFor(db: DatabaseSync, request: Request, now: Date): Block {
    const summary = summarize(db, request.scope);
    const sections: Section[] = [];
    if (summary.cost !== undefined) sections.push(costSection(summary.cost));
    if (summary.tools !== undefined) sections.push(toolsSection(summary.tools));
    if (summary.yourTime !== undefined) sections.push(waitSection(summary.yourTime));
    if (summary.blocked !== undefined) sections.push(blockedSection(summary.blocked));
    if (summary.checks.length > 0) sections.push(checksSection(summary.checks, now));
    return sections.length === 0
        ? { title: request.title, sections, empty: "no records" }
        : { title: request.title, sections };
}

// ---- the lines ------------------------------------------------------------------------------------------------------

/** How the parts of a block are dressed. The screen gives them colours; plain text leaves them as they are. */
export interface Style {
    title(text: string): string;
    label(text: string): string;
    dim(text: string): string;
}

export const PLAIN: Style = { title: (text) => text, label: (text) => text, dim: (text) => text };

/** The section names sit in a column as wide as the longest, `Your time`. */
const NAME_WIDTH = 9;

/** The block's lines, separated by an empty line. A section's lines go under its name, which is on the first. */
export function render(blocks: readonly Block[], style: Style = PLAIN): string[] {
    const lines: string[] = [];
    blocks.forEach((block, index) => {
        if (index > 0) lines.push("");
        if (block.sections.length === 0) {
            lines.push(style.title(block.title) + (block.empty === undefined ? "" : style.dim(`: ${block.empty}`)));
            return;
        }
        lines.push(style.title(block.title));
        for (const section of block.sections) {
            section.lines.forEach((line, i) => {
                const name = i === 0 ? style.label(section.name.padEnd(NAME_WIDTH)) : " ".repeat(NAME_WIDTH);
                lines.push(`  ${name}  ${line}`);
            });
        }
    });
    return lines;
}

/** The summary as plain text. */
export const plain = (blocks: readonly Block[]): string => render(blocks).join("\n");

/** The shortened summary, for a screen that is only a notification: each section is cut to its first line. */
export function short(blocks: readonly Block[]): string {
    const cut = blocks.map((block) => ({
        ...block,
        sections: block.sections.map((section) => ({ ...section, lines: section.lines.slice(0, 1) })),
    }));
    return plain(cut);
}
