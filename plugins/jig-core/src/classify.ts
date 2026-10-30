// Classification: where a call acts (its environment) and whether it reads or writes (its effect).
//
// The sources are checked in this order, and the first answer wins:
//   1. the tool's own declaration (`declareTool`), for Jig's tools;
//   2. a classification rule in configuration (personal rules first, then the company's);
//   3. the defaults built in for Pi's own tools;
//   4. the tool's annotations (MCP-style hints), which Pi reports for any package's tools;
//   5. the unknown default: a write outside the machine, which asks.
import type { ToolAnnotations, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ApprovalKind, CallClass, ClassifyRule, Effect, EnvironmentName, ToolDeclaration } from "./contract.ts";
import { errorMessage, InvalidInputError } from "./errors.ts";

/** Which source gave the answer. `/jig rules` shows it. */
export type ClassSource = "declaration" | "rule" | "builtin" | "hint" | "unknown";

export interface Classification {
    action?: string;
    environment: EnvironmentName;
    effect: Effect;
    atLeast?: "ask" | "deny";
    approval?: ApprovalKind;
    source: ClassSource;
    /** The plugin that declared the tool, when one did. */
    plugin?: string;
}

/** What `classify` needs to know about the running session. */
export interface ClassifyDeps {
    declarations: ReadonlyMap<string, ToolDeclaration>;
    /** Personal rules first, then the company's. */
    classifyRules: readonly ClassifyRule[];
    /** The tool as Pi lists it, for its annotations. */
    toolInfo(name: string): ToolInfo | undefined;
}

const LOCAL_READ: CallClass = { environment: "local", effect: "read" };
const LOCAL_WRITE: CallClass = { environment: "local", effect: "write" };

/** Pi's own tools. `bash` is a write even for a plain `ls`, because a shell string can do anything; the sandbox is
 *  what protects it. The question tools are reads so that asking the user a question never asks first. */
export const BUILT_IN_TOOLS: Readonly<Record<string, CallClass>> = {
    read: LOCAL_READ,
    ls: LOCAL_READ,
    find: LOCAL_READ,
    grep: LOCAL_READ,
    write: LOCAL_WRITE,
    edit: LOCAL_WRITE,
    bash: LOCAL_WRITE,
    powershell: LOCAL_WRITE,
    ask_user_question: LOCAL_READ,
    ask_questions: LOCAL_READ,
};

/** The default for a tool nothing else classifies: it may write outside the machine, so it asks. */
export const UNKNOWN_CLASS: CallClass = { environment: "external", effect: "write" };

/** Matches a tool name against a rule's `tool`, where `*` stands for any run of characters. */
export function matchesName(pattern: string, name: string): boolean {
    if (!pattern.includes("*")) return pattern === name;
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`).test(name);
}

export function classify(tool: string, input: Readonly<Record<string, unknown>>, deps: ClassifyDeps): Classification {
    const declaration = deps.declarations.get(tool);
    if (declaration !== undefined) {
        // The tool speaks for itself. If it cannot classify this input it says so, and the call is unknown: a
        // user's rule or a hint must not guess for a tool that declared itself.
        let answer: ReturnType<typeof declaration.classify>;
        try {
            answer = declaration.classify(input);
        } catch (error) {
            // A TypeError is the tool saying the input is invalid; anything else is a fault in the tool, which the
            // gate blocks as one.
            if (error instanceof TypeError) throw new InvalidInputError(errorMessage(error));
            throw error;
        }
        if (answer === undefined) return { ...UNKNOWN_CLASS, source: "unknown", plugin: declaration.plugin };
        if (!isValidClass(answer)) throw new Error(`the declaration of ${tool} returned an invalid classification`);
        return { ...answer, source: "declaration", plugin: declaration.plugin };
    }

    for (const rule of deps.classifyRules) {
        if (classifyRuleMatches(rule, tool, input)) {
            return {
                environment: rule.environment,
                effect: rule.effect,
                ...(rule.action === undefined ? {} : { action: rule.action }),
                source: "rule",
            };
        }
    }

    const builtIn = Object.hasOwn(BUILT_IN_TOOLS, tool) ? BUILT_IN_TOOLS[tool] : undefined;
    if (builtIn !== undefined) return { ...builtIn, source: "builtin" };

    const effect = effectFromHints(deps.toolInfo(tool)?.annotations);
    // A tool that is classified only by its hints acts outside the machine as far as Jig can tell.
    if (effect !== undefined) return { environment: "external", effect, source: "hint" };

    return { ...UNKNOWN_CLASS, source: "unknown" };
}

/** A declaration is code from another package: check what it returns before the rules rely on it. */
function isValidClass(answer: CallClass): boolean {
    return (
        typeof answer.environment === "string" &&
        answer.environment !== "" &&
        (answer.effect === "read" || answer.effect === "write") &&
        (answer.atLeast === undefined || answer.atLeast === "ask" || answer.atLeast === "deny")
    );
}

function classifyRuleMatches(rule: ClassifyRule, tool: string, input: Readonly<Record<string, unknown>>): boolean {
    if (!matchesName(rule.tool, tool)) return false;
    // Tools with several operations take an `action` parameter by convention; a rule can name one of them.
    if (rule.action !== undefined && input.action !== rule.action) return false;
    const seen = input[rule.param];
    if (typeof seen !== "string" && typeof seen !== "number" && typeof seen !== "boolean") return false;
    const value = String(seen);
    if (rule.value !== undefined) return value === rule.value;
    return rule.pattern !== undefined && new RegExp(rule.pattern).test(value);
}

/**
 * What a tool's annotations say about its effect. `readOnlyHint` means a read. Otherwise the MCP defaults apply to
 * a hint that is absent (a tool may be destructive, and may reach an open world), and either one means a write.
 * A tool that says it is neither read-only, destructive nor open-world says nothing useful, so it stays unknown.
 */
export function effectFromHints(hints: ToolAnnotations | undefined): Effect | undefined {
    if (hints === undefined) return undefined;
    if (hints.readOnlyHint === true) return "read";
    const destructive = hints.destructiveHint ?? true;
    const openWorld = hints.openWorldHint ?? true;
    return destructive || openWorld ? "write" : undefined;
}
