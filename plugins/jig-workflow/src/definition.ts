// A workflow file, checked. A workflow is data: a name, stages, the conditions that let work leave a stage, and the holds. The
// conditions come from the fixed list below and the plugin checks each one itself, so a file never runs code. A file that does
// not pass is rejected whole, with the key at fault, and never half-read.

/** The conditions a workflow can name. Each is decided by the plugin (see docs/conditions.md). */
export const CONDITIONS = [
    "notes-updated",
    "plan-approved",
    "tests-pass-at-head",
    "review-done",
    "pull-request-open",
    "checks-pass",
    "scenarios-pass",
    "you-approve",
] as const;

export type Condition = (typeof CONDITIONS)[number];

/** Conditions that are about each bound repository. The others are about the ticket. */
export const REPOSITORY_CONDITIONS: ReadonlySet<Condition> = new Set([
    "tests-pass-at-head",
    "review-done",
    "pull-request-open",
    "checks-pass",
]);

export function isCondition(value: unknown): value is Condition {
    return typeof value === "string" && (CONDITIONS as readonly string[]).includes(value);
}

export interface Stage {
    id: string;
    goal?: string;
    exit: Condition[];
}

/** One entry of a hold's `calls`: a tool, and optionally one of its actions. */
export interface HoldCall {
    tool: string;
    action?: string;
}

export interface Hold {
    until: Condition;
    calls: HoldCall[];
}

export interface Workflow {
    name: string;
    description?: string;
    /** A regular expression (source text) a ticket key must match for `start` to pick this workflow. */
    match?: string;
    /** The work's branch for `bind`, with `{ticket}` in it. */
    branch: string;
    stages: Stage[];
    holds: Hold[];
}

export interface Parsed {
    workflow?: Workflow;
    /** Each names the key at fault, such as `stages[1].exit[0]: ...`. Empty when the workflow is valid. */
    errors: string[];
}

const FILE_FIELDS = new Set(["name", "description", "match", "branch", "stages", "holds"]);
const STAGE_FIELDS = new Set(["id", "goal", "exit"]);
const HOLD_FIELDS = new Set(["until", "calls"]);
const MATCH_FIELDS = new Set(["ticket"]);

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const STAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const ACTION = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const MAX_TEXT = 500;
const MAX_STAGES = 30;
const MAX_HOLDS = 30;
const MAX_CALLS = 30;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoted(text: unknown): string {
    const value = typeof text === "string" ? text : JSON.stringify(text);
    const clean = String(value).replace(/[\u0000-\u001f\u007f]/g, "?");
    return JSON.stringify(clean.length > 40 ? `${clean.slice(0, 40)}...` : clean);
}

function unknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, at: string, errors: string[]) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${at === "" ? "" : `${at}.`}${key}: unknown field`);
    }
}

/** A `calls` entry: `"git push"` is the tool `git` and its action `push`; `"write"` is the tool alone. */
export function parseCall(text: string): HoldCall | undefined {
    const parts = text.split(" ");
    const [tool, action, ...rest] = parts;
    if (tool === undefined || !TOOL.test(tool) || rest.length > 0) return undefined;
    if (action === undefined) return { tool };
    return ACTION.test(action) ? { tool, action } : undefined;
}

/** Checks the text of a workflow file. `fileName` is the name without `.json`, which the workflow's `name` must equal. */
export function parseWorkflow(text: string, fileName: string): Parsed {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { errors: [`not valid JSON (${(error as Error).message.split("\n")[0]})`] };
    }
    if (!isObject(raw)) return { errors: ["the file must hold one JSON object"] };

    const errors: string[] = [];
    unknownFields(raw, FILE_FIELDS, "", errors);

    const name = raw.name;
    if (typeof name !== "string" || !NAME.test(name)) {
        errors.push("name: must be letters, digits and - (at most 64), and start with a letter or digit");
    } else if (name !== fileName) {
        errors.push(`name: is ${quoted(name)}, and the file is called ${quoted(`${fileName}.json`)}; they must match`);
    }

    let description: string | undefined;
    if (raw.description !== undefined) {
        if (typeof raw.description !== "string" || raw.description.length > MAX_TEXT) {
            errors.push(`description: must be text of at most ${MAX_TEXT} characters`);
        } else description = raw.description;
    }

    let match: string | undefined;
    if (raw.match !== undefined) {
        if (!isObject(raw.match)) {
            errors.push('match: must be an object such as { "ticket": "^PROJ-\\\\d+$" }');
        } else {
            unknownFields(raw.match, MATCH_FIELDS, "match", errors);
            const ticket = raw.match.ticket;
            if (typeof ticket !== "string" || ticket === "") {
                errors.push("match.ticket: must be a regular expression, as text");
            } else {
                try {
                    new RegExp(ticket);
                    match = ticket;
                } catch (error) {
                    errors.push(`match.ticket: not a regular expression (${(error as Error).message})`);
                }
            }
        }
    }

    let branch = "{ticket}";
    if (raw.branch !== undefined) {
        if (typeof raw.branch !== "string" || !raw.branch.includes("{ticket}") || raw.branch.length > 200) {
            errors.push('branch: must be text with {ticket} in it, such as "feature/{ticket}"');
        } else branch = raw.branch;
    }

    const stages = parseStages(raw.stages, errors);
    const holds = parseHolds(raw.holds, errors);

    if (errors.length > 0 || typeof name !== "string") return { errors };
    return {
        errors,
        workflow: {
            name,
            ...(description === undefined ? {} : { description }),
            ...(match === undefined ? {} : { match }),
            branch,
            stages,
            holds,
        },
    };
}

function parseStages(raw: unknown, errors: string[]): Stage[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        errors.push("stages: must be a list with at least one stage");
        return [];
    }
    if (raw.length > MAX_STAGES) errors.push(`stages: at most ${MAX_STAGES} stages`);
    const stages: Stage[] = [];
    const seen = new Set<string>();
    raw.slice(0, MAX_STAGES).forEach((entry, index) => {
        const at = `stages[${index}]`;
        if (!isObject(entry)) {
            errors.push(`${at}: must be an object with an id`);
            return;
        }
        unknownFields(entry, STAGE_FIELDS, at, errors);
        const id = entry.id;
        if (typeof id !== "string" || !STAGE_ID.test(id)) {
            errors.push(`${at}.id: must be lower-case letters, digits and - (at most 64)`);
        } else if (seen.has(id)) {
            errors.push(`${at}.id: ${quoted(id)} is used by an earlier stage`);
        } else seen.add(id);
        let goal: string | undefined;
        if (entry.goal !== undefined) {
            if (typeof entry.goal !== "string" || entry.goal.length > MAX_TEXT) {
                errors.push(`${at}.goal: must be text of at most ${MAX_TEXT} characters`);
            } else goal = entry.goal;
        }
        const exit: Condition[] = [];
        if (entry.exit !== undefined) {
            if (!Array.isArray(entry.exit)) {
                errors.push(`${at}.exit: must be a list of conditions`);
            } else {
                entry.exit.forEach((condition, position) => {
                    const where = `${at}.exit[${position}]`;
                    if (!isCondition(condition)) {
                        errors.push(`${where}: ${quoted(condition)} is not a condition (${CONDITIONS.join(", ")})`);
                    } else if (exit.includes(condition)) {
                        errors.push(`${where}: ${quoted(condition)} is listed twice`);
                    } else exit.push(condition);
                });
            }
        }
        if (typeof id === "string") stages.push({ id, ...(goal === undefined ? {} : { goal }), exit });
    });
    return stages;
}

function parseHolds(raw: unknown, errors: string[]): Hold[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        errors.push("holds: must be a list");
        return [];
    }
    if (raw.length > MAX_HOLDS) errors.push(`holds: at most ${MAX_HOLDS} holds`);
    const holds: Hold[] = [];
    raw.slice(0, MAX_HOLDS).forEach((entry, index) => {
        const at = `holds[${index}]`;
        if (!isObject(entry)) {
            errors.push(`${at}: must be an object with until and calls`);
            return;
        }
        unknownFields(entry, HOLD_FIELDS, at, errors);
        const until = entry.until;
        if (!isCondition(until)) {
            errors.push(`${at}.until: ${quoted(until)} is not a condition (${CONDITIONS.join(", ")})`);
        }
        const calls: HoldCall[] = [];
        if (!Array.isArray(entry.calls) || entry.calls.length === 0) {
            errors.push(`${at}.calls: must be a list with at least one call, such as "git push" or "write"`);
        } else {
            if (entry.calls.length > MAX_CALLS) errors.push(`${at}.calls: at most ${MAX_CALLS} calls`);
            entry.calls.slice(0, MAX_CALLS).forEach((call, position) => {
                const parsed = typeof call === "string" ? parseCall(call) : undefined;
                if (parsed === undefined) {
                    errors.push(
                        `${at}.calls[${position}]: ${quoted(call)} must be a tool name, alone or with one action`,
                    );
                } else calls.push(parsed);
            });
        }
        if (isCondition(until)) holds.push({ until, calls });
    });
    return holds;
}

/** `git push` for a hold's call, as the reason and `status` write it. */
export function callText(call: HoldCall): string {
    return call.action === undefined ? call.tool : `${call.tool} ${call.action}`;
}
