// The `/jig` commands:
//   /jig               status
//   /jig rules [tool]  the effective decision per tool and action, and where each came from
//   /jig records       where today's records are, and a one-line summary
import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { classify } from "./classify.ts";
import type { Classification, ClassSource } from "./classify.ts";
import { describeProblem, effectiveBackends } from "./config.ts";
import type { EnvironmentInfo } from "./contract.ts";
import { decide } from "./decide.ts";
import { errorMessage } from "./errors.ts";
import { FILE_TOOLS } from "./protected-paths.ts";
import type { ProtectedKind, ProtectedSource } from "./protected-paths.ts";
import { formatDuration, summarize } from "./records.ts";
import { plainLine } from "./watch/clean.ts";
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
        typeof option?.const === "string" ? [option.const] : strings(option?.enum),
    );
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
    const unclassified = tools
        .filter((tool) => probe(state, tool.name, {})?.source === "unknown")
        .map((tool) => tool.name);
    const problems = [
        ...state.policy().problems.map(describeProblem),
        ...state.startupProblems,
        ...state.gates.problems(),
    ];
    const gates = state.gates.list();

    const lines = [
        `jig-core governs ${tools.length} tools${state.sessionId === undefined ? "" : ` in session ${state.sessionId}`}`,
        sandboxLine(state),
        `Plugins: ${[...plugins].join(", ")}`,
        environmentsLine(state),
        secretBackendsLine(state),
        `Tools on the unknown default (they ask until classified): ${unclassified.length === 0 ? "none" : unclassified.join(", ")}`,
        watchesLine(state),
        ...(gates.length === 0
            ? []
            : [
                  `Gates (they can only make a decision stricter): ${gates.map((gate) => `${gate.name} (${gate.plugin})`).join(", ")}`,
              ]),
        state.personal.found
            ? `Configuration: ${state.personal.file}`
            : `Configuration: none found (${state.personal.file || "not loaded yet"}), defaults apply`,
    ];
    const sections = [...state.sectionChecks.keys()];
    if (sections.length > 0) {
        const shown = sections.map((name) => `${name} (${sectionState(state, name)})`);
        lines.push(`Plugin sections in the file: ${shown.join(", ")}`);
    }
    lines.push(...pluginLines(state));
    // Not an error: a company gave defaults that lack something only you can give, so the plugin waits for it.
    for (const [name, messages] of state.personal.incomplete) {
        lines.push(
            `Company defaults for "${name}" are incomplete without a section of yours, so the plugin is not configured: ` +
                `${messages.slice(0, 3).join("; ")}${messages.length > 3 ? `; and ${messages.length - 3} more` : ""}`,
        );
    }
    if (problems.length > 0)
        lines.push(`Configuration problems (${problems.length}):`, ...problems.map((problem) => `  ${problem}`));
    if (state.recordsProblem !== undefined) lines.push(`Records: the last write failed: ${state.recordsProblem}`);
    const watchProblem = state.watches.problem();
    if (watchProblem !== undefined) lines.push(`Watches: ${watchProblem}`);
    return lines;
}

/** What plugins asked `/jig` to show (`status.register`). A plugin that fails shows that it did, and the others still show. */
function pluginLines(state: JigState): string[] {
    const out: string[] = [];
    for (const [plugin, lines] of state.statusLines) {
        try {
            for (const line of lines()) out.push(plainLine(String(line), 300));
        } catch {
            out.push(`${plugin}: its status could not be read`);
        }
    }
    return out.filter((line) => line !== "");
}

/**
 * Whether `bash` is sandboxed, in a line. Without a sandbox plugin it is a plain warning: a shell command can read the
 * credentials that Pi's file tools refuse to.
 */
export function sandboxLine(state: JigState): string {
    const provider = state.sandbox;
    if (provider === undefined) {
        return (
            "bash: NOT sandboxed. No sandbox is registered, so a shell command can read your credentials " +
            "(Pi's file tools refuse them, bash does not). Install jig-sandbox, or run Pi inside a container."
        );
    }
    try {
        if (provider.active) return `bash: sandboxed${provider.mode === undefined ? "" : `, network ${provider.mode}`}`;
        return `bash: NOT sandboxed${provider.note === undefined || provider.note === "" ? "" : `: ${provider.note}`}`;
    } catch {
        return "bash: the sandbox did not say whether it is on";
    }
}

const ENVIRONMENT_SOURCE: Record<EnvironmentInfo["source"], string> = {
    "built-in": "built in",
    company: "a company plugin",
    personal: "your jig.json",
};

/**
 * The environments a call can act in, grouped by who defined them: `Environments: built in: local, external, production;
 * a company plugin: dev (test), prod (production)`. A built-in name is its own kind, so only the others show one.
 */
export function environmentsLine(state: JigState): string {
    const groups: string[] = [];
    const all = state.policy().environments.list();
    for (const source of ["built-in", "company", "personal"] as const) {
        const names = all
            .filter((entry) => entry.source === source)
            .map((entry) => (source === "built-in" ? entry.name : `${entry.name} (${entry.kind})`));
        if (names.length > 0) groups.push(`${ENVIRONMENT_SOURCE[source]}: ${names.join(", ")}`);
    }
    return `Environments (any other name counts as production): ${groups.join("; ")}`;
}

/**
 * Which secret backends can resolve a reference, and who turned them on or off: `Secret backends on: pass, cmd (cmd enabled
 * by a company plugin); turned off by you: env`.
 */
export function secretBackendsLine(state: JigState): string {
    const { on, byCompany, off } = effectiveBackends(state.personal.config.secrets, state.company);
    const enabled = byCompany.length === 0 ? "" : ` (${byCompany.join(", ")} enabled by a company plugin)`;
    const disabled = off.length === 0 ? "" : `; turned off by you: ${off.join(", ")}`;
    return `Secret backends on: ${on.length === 0 ? "none" : on.join(", ")}${enabled}${disabled}`;
}

/**
 * What `/jig` says about one registered section: loaded, waiting for the part only you can give, "not set" when nothing
 * (no company defaults, nothing in the file) set it, and otherwise a section that did not load. A file that could not be
 * read as a whole says nothing of its sections, so they are not called "not set".
 */
function sectionState(state: JigState, name: string): string {
    const { personal } = state;
    if (personal.sections.has(name)) return "loaded";
    if (personal.incomplete.has(name)) return "company defaults incomplete";
    const unreadable = personal.problems.some((problem) => problem.key === "(file)");
    return personal.invalid.has(name) || unreadable ? "not set or invalid" : "not set";
}

/** `Open watches: 3 (1 paused, 1 waiting for its plugin)`: each watch not finished, and why some do not poll. */
function watchesLine(state: JigState): string {
    const open = state.watches.entries().filter((entry) => entry.status !== "done");
    const paused = open.filter((entry) => entry.status === "paused").length;
    const waiting = open.filter((entry) => entry.waiting).length;
    const notes = [
        ...(paused === 0 ? [] : [`${paused} paused`]),
        ...(waiting === 0 ? [] : [`${waiting} waiting for ${waiting === 1 ? "its" : "their"} plugin`]),
    ];
    return `Open watches: ${open.length}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

// ---- /jig rules -------------------------------------------------------------------------------------------------------

export function ruleLines(state: JigState, only: string | undefined, hasUI: boolean): string[] {
    const policy = state.policy();
    const tools = state.pi.getAllTools();
    const names = [...new Set([...tools.map((tool) => tool.name), ...state.declarations.keys()])].sort();
    const lines: string[] = [];

    const describeRule = (label: string, input: Record<string, unknown>, name: string): void => {
        const classification = probe(state, name, input);
        if (classification === undefined) {
            lines.push(
                `${label}: decided per call by its declaration (${state.declarations.get(name)?.plugin ?? "unknown plugin"})`,
            );
            return;
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
        const flag =
            classification.source === "unknown"
                ? "  <- not classified: add a classify rule, or a rule that names it"
                : "";
        const where = `${classification.environment} ${classification.effect} -> ${verdict.decision}`;
        const because = `decision: ${verdict.source}; classified by: ${CLASS_LABEL[classification.source]}`;
        lines.push(`${label}: ${where} (${because})${flag}`);
    };

    for (const name of names) {
        if (only !== undefined && name !== only) continue;
        const info = tools.find((tool) => tool.name === name);
        const actions = actionsOf(info);
        for (const action of actions.length === 0 ? [undefined] : actions) {
            describeRule(
                action === undefined ? name : `${name} ${action}`,
                action === undefined ? {} : { action },
                name,
            );
        }
        // Actions a tool picks from its input and not from an `action` parameter, such as `bash` run outside its sandbox.
        for (const [action, input] of Object.entries(state.declarations.get(name)?.examples ?? {})) {
            describeRule(`${name} ${action}`, { ...input }, name);
        }
    }
    if (lines.length === 0) return [only === undefined ? "No tools are registered." : `No tool named ${only}.`];
    const shown =
        lines.length > MAX_RULE_LINES
            ? [...lines.slice(0, MAX_RULE_LINES), `... and ${lines.length - MAX_RULE_LINES} more`]
            : lines;
    return only === undefined || FILE_TOOLS.has(only) ? [...shown, ...protectedLines(state)] : shown;
}

const PROTECTED_KIND: Record<ProtectedKind, string> = {
    secret: "secret (the file tools neither read nor write these)",
    guarded: "guarded (the file tools can read these, not write them)",
};
const PROTECTED_SOURCE: Record<ProtectedSource, string> = {
    default: "default",
    personal: "your jig.json",
    company: "a company plugin",
};

/** The protected paths of Pi's file tools, and where each one came from. A floor rule: configuration only adds. */
function protectedLines(state: JigState): string[] {
    const entries = state.policy().protectedPaths;
    const lines = [
        "Protected paths for read, write, edit, grep, find and ls (a floor rule: configuration can only add):",
    ];
    for (const kind of ["secret", "guarded"] as const) {
        const of = entries.filter((entry) => entry.kind === kind);
        if (of.length === 0) continue;
        lines.push(`  ${PROTECTED_KIND[kind]}:`);
        for (const entry of of) lines.push(`    ${entry.shown}  (${PROTECTED_SOURCE[entry.source]})`);
    }
    if (entries.length === 0) lines.push("  none: the agent folder is not known yet");
    return lines;
}

// ---- /jig records ------------------------------------------------------------------------------------------------------

export function recordsLines(state: JigState): string[] {
    let summary: ReturnType<typeof summarize>;
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
