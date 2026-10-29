// The `/jig` commands:
//   /jig               status
//   /jig rules [tool]  the effective decision per tool and action, and where each came from
//   /jig records       where today's records are, and a one-line summary
import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { classify } from "./classify.ts";
import type { Classification, ClassSource } from "./classify.ts";
import { describeProblem } from "./config.ts";
import { decide } from "./decide.ts";
import { errorMessage } from "./errors.ts";
import { formatDuration, summarize } from "./records.ts";
import type { JigState } from "./state.ts";

/** A list longer than this is shown in a scrollable selector instead of a notice. */
const NOTICE_LINES = 12;
const MAX_RULE_LINES = 300;

export function registerCommands(pi: ExtensionAPI, state: JigState): void {
    pi.registerCommand("jig", {
        description: "Jig tool manager: status, rules per tool, records",
        getArgumentCompletions: (prefix) => {
            const matches = ["rules", "records"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args, ctx) => {
            const [word, ...rest] = args.trim().split(/\s+/);
            if (word === undefined || word === "") return show(ctx, "jig status", statusLines(state));
            if (word === "rules") return show(ctx, "jig rules", ruleLines(state, rest[0], ctx.hasUI));
            if (word === "records") return show(ctx, "jig records", recordsLines(state));
            return show(ctx, "jig", ["Usage: /jig, /jig rules [tool], /jig records"]);
        },
    });
}

async function show(ctx: ExtensionCommandContext, title: string, lines: string[]): Promise<void> {
    if (lines.length <= NOTICE_LINES) ctx.ui.notify(lines.join("\n"), "info");
    else await ctx.ui.select(title, lines);
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

/**
 * How a tool is classified before any call. A declared tool classifies each call from its input, so it may have no
 * answer for the input given here; that is not the unknown default, and the result is undefined.
 */
function probe(state: JigState, name: string, input: Record<string, unknown>): Classification | undefined {
    try {
        const result = classify(name, input, {
            declarations: state.declarations,
            classifyRules: state.policy().classify,
            toolInfo: (tool) => state.pi.getAllTools().find((info) => info.name === tool),
        });
        return result.source === "unknown" && state.declarations.has(name) ? undefined : result;
    } catch {
        return undefined;
    }
}

/** The values of a tool's `action` parameter, when its schema lists them. */
function actionsOf(tool: ToolInfo | undefined): string[] {
    const schema = (tool?.parameters as { properties?: { action?: unknown } } | undefined)?.properties?.action;
    if (typeof schema !== "object" || schema === null) return [];
    const { enum: values, anyOf, oneOf } = schema as { enum?: unknown; anyOf?: unknown; oneOf?: unknown };
    const strings = (list: unknown): string[] =>
        Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    if (Array.isArray(values)) return strings(values);
    const options = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : [];
    return options.flatMap((option: { const?: unknown; enum?: unknown }) =>
        typeof option?.const === "string" ? [option.const] : strings(option?.enum));
}

const CLASS_LABEL: Record<ClassSource, string> = {
    declaration: "declaration",
    rule: "rule",
    builtin: "default",
    hint: "hint",
    unknown: "default, not classified",
};

// ---- /jig ----------------------------------------------------------------------------------------------------------------

export function statusLines(state: JigState): string[] {
    const tools = state.pi.getAllTools();
    const plugins = new Set<string>(["jig-core"]);
    for (const declaration of state.declarations.values()) plugins.add(declaration.plugin);
    const unclassified = tools.filter((tool) => probe(state, tool.name, {})?.source === "unknown").map((tool) => tool.name);
    const problems = [...state.policy().problems.map(describeProblem), ...state.startupProblems];

    const lines = [
        `jig-core governs ${tools.length} tools${state.sessionId === undefined ? "" : ` in session ${state.sessionId}`}`,
        `Plugins: ${[...plugins].join(", ")}`,
        `Tools on the unknown default (they ask until classified): ${unclassified.length === 0 ? "none" : unclassified.join(", ")}`,
        `Open watches: ${state.watches.list().length}`,
        state.personal.found
            ? `Configuration: ${state.personal.file}`
            : `Configuration: none found (${state.personal.file || "not loaded yet"}), defaults apply`,
    ];
    const sections = [...state.sectionChecks.keys()];
    if (sections.length > 0) {
        const shown = sections.map((name) => `${name} (${state.personal.sections.has(name) ? "loaded" : "not set or invalid"})`);
        lines.push(`Plugin sections in the file: ${shown.join(", ")}`);
    }
    if (problems.length > 0) lines.push(`Configuration problems (${problems.length}):`, ...problems.map((problem) => `  ${problem}`));
    if (state.recordsProblem !== undefined) lines.push(`Records: the last write failed: ${state.recordsProblem}`);
    return lines;
}

// ---- /jig rules -------------------------------------------------------------------------------------------------------

export function ruleLines(state: JigState, only: string | undefined, hasUI: boolean): string[] {
    const policy = state.policy();
    const tools = state.pi.getAllTools();
    const names = [...new Set([...tools.map((tool) => tool.name), ...state.declarations.keys()])].sort();
    const lines: string[] = [];

    for (const name of names) {
        if (only !== undefined && name !== only) continue;
        const info = tools.find((tool) => tool.name === name);
        const actions = actionsOf(info);
        for (const action of actions.length === 0 ? [undefined] : actions) {
            const classification = probe(state, name, action === undefined ? {} : { action });
            const label = action === undefined ? name : `${name} ${action}`;
            if (classification === undefined) {
                lines.push(`${label}: decided per call by its declaration (${state.declarations.get(name)?.plugin ?? "unknown plugin"})`);
                continue;
            }
            const verdict = decide({
                call: {
                    tool: name,
                    ...(classification.action === undefined ? {} : { action: classification.action }),
                    environment: classification.environment,
                    environmentKind: policy.environments.kindOf(classification.environment),
                    effect: classification.effect,
                    ...(classification.atLeast === undefined ? {} : { atLeast: classification.atLeast }),
                    unknown: classification.source === "unknown",
                },
                rules: policy.rules,
                sessionAllows: state.sessionAllows,
                hasUI,
            });
            const flag = classification.source === "unknown" ? "  <- not classified: add a classify rule, or a rule that names it" : "";
            const where = `${classification.environment} ${classification.effect} -> ${verdict.decision}`;
            const because = `decision: ${verdict.source}; classified by: ${CLASS_LABEL[classification.source]}`;
            lines.push(`${label}: ${where} (${because})${flag}`);
        }
    }
    if (lines.length === 0) return [only === undefined ? "No tools are registered." : `No tool named ${only}.`];
    return lines.length > MAX_RULE_LINES ? [...lines.slice(0, MAX_RULE_LINES), `... and ${lines.length - MAX_RULE_LINES} more`] : lines;
}

// ---- /jig records ------------------------------------------------------------------------------------------------------

export function recordsLines(state: JigState): string[] {
    let summary;
    try {
        summary = summarize(state.now());
    } catch (error) {
        return [`Records could not be read: ${errorMessage(error)}`];
    }
    if (!summary.exists) return [`Today's records: ${summary.file}`, "Nothing recorded yet today."];
    return [
        `Today's records: ${summary.file}`,
        `${summary.calls} calls (${summary.errors} errors, ${summary.blocked} blocked), ${summary.questions} questions asked, ` +
            `${formatDuration(summary.waitedMs)} waited for you, ${summary.turns} model turns`,
    ];
}
