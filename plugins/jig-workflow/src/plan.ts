// `plan.md`: what it must hold, its fingerprint, and the numbered acceptance scenarios in it. The plan is the one place where
// the user says, before code is written, what "done" means; approving it means approving this exact text.
import { hash } from "./host.ts";

/** A plan longer than this is too long to review, and is refused. */
export const MAX_PLAN_CHARS = 60_000;
export const MAX_SCENARIOS = 50;

export interface Scenario {
    number: number;
    text: string;
    /** A hash of the scenario's words, so that a result belongs to the scenario it was recorded for. */
    hash: string;
}

export interface Plan {
    fingerprint: string;
    approach: string;
    /** The repository names the plan lists. */
    repositories: string[];
    scenarios: Scenario[];
    /** What stops the plan from being submitted. */
    problems: string[];
}

/** The plan's text with line endings made alike, which is what the fingerprint covers. */
export function normalized(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

export function fingerprintOf(text: string): string {
    return hash(normalized(text));
}

interface Section {
    title: string;
    level: number;
    lines: string[];
}

function sectionsOf(text: string): Section[] {
    const sections: Section[] = [];
    let current: Section | undefined;
    let inFence = false;
    for (const line of normalized(text).split("\n")) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        const heading = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading !== null) {
            current = { title: (heading[2] ?? "").trim().toLowerCase(), level: (heading[1] ?? "").length, lines: [] };
            sections.push(current);
        } else current?.lines.push(line);
    }
    return sections;
}

/** The text of a section: its own lines, and those of the sections below it. */
function bodyOf(sections: readonly Section[], index: number): string {
    const start = sections[index];
    if (start === undefined) return "";
    const lines = [...start.lines];
    for (const next of sections.slice(index + 1)) {
        if (next.level <= start.level) break;
        lines.push(`${"#".repeat(next.level)} ${next.title}`, ...next.lines);
    }
    return lines.join("\n");
}

const NUMBERED = /^ {0,3}(\d+)[.)]\s+(.*)$/;

/** The lines of a body that are not inside a code block: a list in an example is not part of the plan's own. */
function unfenced(body: string): string[] {
    let inFence = false;
    return body.split("\n").filter((line) => {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return false;
        }
        return !inFence;
    });
}

function scenariosIn(body: string, problems: string[]): Scenario[] {
    const found: Array<{ number: number; lines: string[] }> = [];
    for (const line of unfenced(body)) {
        const item = NUMBERED.exec(line);
        if (item !== null) found.push({ number: Number(item[1]), lines: [item[2] ?? ""] });
        else if (found.length > 0 && line.trim() !== "" && /^\s/.test(line)) found.at(-1)?.lines.push(line.trim());
    }
    if (found.length === 0) {
        problems.push("## Scenarios: needs a numbered list, 1. 2. 3., of what you will see when it works");
        return [];
    }
    if (found.length > MAX_SCENARIOS) problems.push(`## Scenarios: at most ${MAX_SCENARIOS} scenarios`);
    const scenarios: Scenario[] = [];
    found.slice(0, MAX_SCENARIOS).forEach((entry, index) => {
        const text = entry.lines.join(" ").replace(/\s+/g, " ").trim();
        if (entry.number !== index + 1) {
            problems.push(
                `## Scenarios: the numbers must go 1, 2, 3 with no gap (found ${entry.number} where ${index + 1} belongs)`,
            );
        }
        if (text === "") problems.push(`## Scenarios: scenario ${index + 1} is empty`);
        scenarios.push({ number: index + 1, text, hash: hash(text) });
    });
    return scenarios;
}

function listItems(body: string): string[] {
    const names: string[] = [];
    for (const line of unfenced(body)) {
        const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (item === null) continue;
        const name = (item[1] ?? "").replace(/[`*_]/g, "").trim().split(/\s+/)[0] ?? "";
        if (name !== "") names.push(name);
    }
    return names;
}

/** Reads a plan. It never throws: what is wrong with it is in `problems`. */
export function parsePlan(text: string): Plan {
    const problems: string[] = [];
    if (text.length > MAX_PLAN_CHARS) {
        problems.push(`plan.md is ${text.length} characters, and ${MAX_PLAN_CHARS} is the most that can be reviewed`);
    }
    const sections = sectionsOf(text);
    const find = (title: string): number => sections.findIndex((section) => section.title === title);
    const missing = (title: string): boolean => {
        const first = find(title);
        if (first < 0) return true;
        if (sections.findIndex((section, index) => index > first && section.title === title) >= 0) {
            problems.push(`## ${title[0]?.toUpperCase()}${title.slice(1)}: the plan has this heading twice`);
        }
        return false;
    };

    let approach = "";
    if (missing("approach"))
        problems.push("## Approach: add the heading, with at least a line on how the change will be made");
    else {
        approach = bodyOf(sections, find("approach")).trim();
        if (approach === "") problems.push("## Approach: is empty");
    }

    let repositories: string[] = [];
    if (missing("repositories"))
        problems.push("## Repositories: add the heading, with a list of the repositories the change touches");
    else {
        repositories = listItems(bodyOf(sections, find("repositories")));
        if (repositories.length === 0) problems.push("## Repositories: needs a list, one repository per line");
    }

    let scenarios: Scenario[] = [];
    if (missing("scenarios")) {
        problems.push("## Scenarios: add the heading, with a numbered list of what you will see when it works");
    } else scenarios = scenariosIn(bodyOf(sections, find("scenarios")), problems);

    return { fingerprint: fingerprintOf(text), approach, repositories, scenarios, problems };
}

/**
 * Warnings that do not stop a submission: a bound repository the plan does not name, and a name that no bound repository has.
 * `bound` lists, for each bound repository, the names it answers to.
 */
export function repositoryWarnings(
    plan: Plan,
    bound: ReadonlyArray<{ root: string; names: readonly string[] }>,
): string[] {
    if (bound.length === 0) return [];
    const warnings: string[] = [];
    const listed = plan.repositories.map((name) => name.toLowerCase());
    for (const repo of bound) {
        if (!repo.names.some((name) => listed.includes(name.toLowerCase()))) {
            warnings.push(`the plan does not name ${repo.names[0]}, which is bound to the ticket`);
        }
    }
    for (const name of plan.repositories) {
        if (!bound.some((repo) => repo.names.some((candidate) => candidate.toLowerCase() === name.toLowerCase()))) {
            warnings.push(`the plan names ${name}, and no bound repository has that name`);
        }
    }
    return warnings;
}
