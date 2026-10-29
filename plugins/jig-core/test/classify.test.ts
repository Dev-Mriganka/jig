// Classification: every step of the order. The tool's declaration, then classification rules, then Pi's built-in
// defaults, then the tool's hints, then the unknown default.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolAnnotations, ToolInfo } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_TOOLS, classify, effectFromHints, matchesName } from "../src/classify.ts";
import type { ClassifyDeps } from "../src/classify.ts";
import type { CallClass, ClassifyRule, ToolDeclaration } from "../src/contract.ts";

function declaration(tool: string, answer: CallClass | undefined, plugin = "jig-test"): ToolDeclaration {
    return { tool, plugin, classify: () => answer };
}

/** Dependencies for `classify`, with the tools' hints given by name. */
function deps(options: { declarations?: ToolDeclaration[]; rules?: ClassifyRule[]; hints?: Record<string, ToolAnnotations | undefined> } = {}): ClassifyDeps {
    return {
        declarations: new Map((options.declarations ?? []).map((d) => [d.tool, d])),
        classifyRules: options.rules ?? [],
        toolInfo: (name) => (options.hints !== undefined && name in options.hints ? ({ name, annotations: options.hints[name] } as unknown as ToolInfo) : undefined),
    };
}

describe("1. the tool's own declaration", () => {
    test("is used first, with its action, approval and atLeast, and names the plugin", () => {
        const answer: CallClass = { action: "push", environment: "external", effect: "write", atLeast: "ask", approval: "review" };
        const result = classify("git", { action: "push" }, deps({ declarations: [declaration("git", answer, "jig-git")] }));
        assert.deepEqual(result, { ...answer, source: "declaration", plugin: "jig-git" });
    });

    test("beats a classification rule, a built-in default and a hint", () => {
        const rules: ClassifyRule[] = [{ tool: "bash", param: "command", pattern: ".", environment: "production", effect: "write" }];
        const result = classify("bash", { command: "ls" }, deps({
            declarations: [declaration("bash", { environment: "local", effect: "read" })],
            rules,
            hints: { bash: { readOnlyHint: false } },
        }));
        assert.equal(result.source, "declaration");
        assert.equal(result.effect, "read");
    });

    test("receives the call's input", () => {
        const seen: unknown[] = [];
        const tool: ToolDeclaration = { tool: "t", plugin: "p", classify: (input) => { seen.push(input); return { environment: String(input.env), effect: "read" }; } };
        const result = classify("t", { env: "staging" }, deps({ declarations: [tool] }));
        assert.deepEqual(seen, [{ env: "staging" }]);
        assert.equal(result.environment, "staging");
    });

    test("a declaration that cannot classify this input makes the call unknown, and no rule or hint guesses for it", () => {
        const rules: ClassifyRule[] = [{ tool: "git", param: "action", value: "status", environment: "local", effect: "read" }];
        const result = classify("git", { action: "status" }, deps({
            declarations: [declaration("git", undefined, "jig-git")],
            rules,
            hints: { git: { readOnlyHint: true } },
        }));
        assert.equal(result.source, "unknown");
        assert.equal(result.environment, "external");
        assert.equal(result.effect, "write");
        assert.equal(result.plugin, "jig-git");
    });

    test("a declaration that returns something invalid is an error, so the call is blocked rather than guessed", () => {
        const bad = [
            { environment: "", effect: "read" },
            { environment: "local", effect: "delete" },
            { environment: "local", effect: "read", atLeast: "never" },
            { effect: "read" },
        ];
        for (const answer of bad) {
            assert.throws(() => classify("t", {}, deps({ declarations: [declaration("t", answer as unknown as CallClass)] })), /invalid classification/, JSON.stringify(answer));
        }
    });
});

describe("2. classification rules", () => {
    const rule = (extra: Partial<ClassifyRule> = {}): ClassifyRule => ({ tool: "other_db", param: "target", value: "live", environment: "prod", effect: "read", ...extra });

    test("match a parameter value exactly", () => {
        const result = classify("other_db", { target: "live" }, deps({ rules: [rule()] }));
        assert.deepEqual(result, { environment: "prod", effect: "read", source: "rule" });
        assert.equal(classify("other_db", { target: "live-ish" }, deps({ rules: [rule()] })).source, "unknown");
        assert.equal(classify("other_db", { target: "LIVE" }, deps({ rules: [rule()] })).source, "unknown");
    });

    test("match a parameter by pattern", () => {
        const rules = [rule({ value: undefined, pattern: "^(live|prod)-" })];
        assert.equal(classify("other_db", { target: "prod-eu" }, deps({ rules })).source, "rule");
        assert.equal(classify("other_db", { target: "dev-eu" }, deps({ rules })).source, "unknown");
    });

    test("compare numbers and booleans as text, and need the parameter to exist", () => {
        assert.equal(classify("other_db", { target: 7 }, deps({ rules: [rule({ value: "7" })] })).source, "rule");
        assert.equal(classify("other_db", { target: true }, deps({ rules: [rule({ value: "true" })] })).source, "rule");
        assert.equal(classify("other_db", {}, deps({ rules: [rule()] })).source, "unknown");
        assert.equal(classify("other_db", { target: { nested: "live" } }, deps({ rules: [rule()] })).source, "unknown");
    });

    test("can name an action, which the call's `action` parameter must equal, and which the result carries", () => {
        const rules = [rule({ action: "query" })];
        assert.deepEqual(classify("other_db", { action: "query", target: "live" }, deps({ rules })), { action: "query", environment: "prod", effect: "read", source: "rule" });
        assert.equal(classify("other_db", { action: "drop", target: "live" }, deps({ rules })).source, "unknown");
        assert.equal(classify("other_db", { target: "live" }, deps({ rules })).source, "unknown");
    });

    test("can name tools with a wildcard", () => {
        const rules = [rule({ tool: "mcp__db__*" })];
        assert.equal(classify("mcp__db__query", { target: "live" }, deps({ rules })).source, "rule");
        assert.equal(classify("mcp__other__query", { target: "live" }, deps({ rules })).source, "unknown");
    });

    test("the first matching rule wins, so the personal rules (listed first) beat the company's", () => {
        const rules = [rule({ environment: "from-personal" }), rule({ environment: "from-company" })];
        assert.equal(classify("other_db", { target: "live" }, deps({ rules })).environment, "from-personal");
    });

    test("beat a built-in default, which lets a pattern reclassify `bash`", () => {
        const rules: ClassifyRule[] = [{ tool: "bash", param: "command", pattern: "^kubectl ", environment: "external", effect: "write" }];
        assert.deepEqual(classify("bash", { command: "kubectl apply -f x" }, deps({ rules })), { environment: "external", effect: "write", source: "rule" });
        assert.deepEqual(classify("bash", { command: "ls" }, deps({ rules })), { environment: "local", effect: "write", source: "builtin" });
    });

    test("beat a hint", () => {
        const result = classify("other_db", { target: "live" }, deps({ rules: [rule({ effect: "write" })], hints: { other_db: { readOnlyHint: true } } }));
        assert.equal(result.effect, "write");
        assert.equal(result.source, "rule");
    });
});

describe("3. Pi's built-in defaults", () => {
    test("read, ls, find and grep are local reads", () => {
        for (const tool of ["read", "ls", "find", "grep"]) {
            assert.deepEqual(classify(tool, {}, deps()), { environment: "local", effect: "read", source: "builtin" }, tool);
        }
    });

    test("write, edit, bash and powershell are local writes", () => {
        for (const tool of ["write", "edit", "bash", "powershell"]) {
            assert.deepEqual(classify(tool, {}, deps()), { environment: "local", effect: "write", source: "builtin" }, tool);
        }
    });

    test("the question tools are local reads, so a question never asks first", () => {
        for (const tool of ["ask_user_question", "ask_questions"]) {
            assert.deepEqual(classify(tool, {}, deps()), { environment: "local", effect: "read", source: "builtin" }, tool);
        }
    });

    test("beat a hint, and cover exactly these ten tools", () => {
        assert.equal(classify("read", {}, deps({ hints: { read: { destructiveHint: true } } })).source, "builtin");
        assert.deepEqual(Object.keys(BUILT_IN_TOOLS).sort(), ["ask_questions", "ask_user_question", "bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
    });

    test("a name like an object property is not a built-in", () => {
        assert.equal(classify("constructor", {}, deps()).source, "unknown");
        assert.equal(classify("toString", {}, deps()).source, "unknown");
    });
});

describe("4. the tool's hints", () => {
    const via = (hints: ToolAnnotations | undefined) => classify("t", {}, deps({ hints: { t: hints } }));

    test("readOnlyHint means a read, outside the machine", () => {
        assert.deepEqual(via({ readOnlyHint: true }), { environment: "external", effect: "read", source: "hint" });
    });

    test("destructiveHint or openWorldHint means a write", () => {
        assert.deepEqual(via({ destructiveHint: true }), { environment: "external", effect: "write", source: "hint" });
        assert.deepEqual(via({ openWorldHint: true, destructiveHint: false }), { environment: "external", effect: "write", source: "hint" });
    });

    test("a hint that is absent takes the MCP default: destructive, and reaching an open world", () => {
        assert.equal(via({})?.effect, "write");
        assert.equal(via({ idempotentHint: true })?.effect, "write");
        assert.equal(via({ readOnlyHint: false })?.effect, "write");
        assert.equal(via({ destructiveHint: false })?.effect, "write", "open world still defaults to true");
    });

    test("readOnlyHint wins over the others", () => {
        assert.equal(via({ readOnlyHint: true, destructiveHint: true, openWorldHint: true }).effect, "read");
    });

    test("a tool that says it is neither read-only, destructive nor open-world says nothing useful, so it stays unknown", () => {
        assert.equal(via({ readOnlyHint: false, destructiveHint: false, openWorldHint: false }).source, "unknown");
        assert.equal(effectFromHints({ destructiveHint: false, openWorldHint: false }), undefined);
    });

    test("no annotations at all is unknown", () => {
        assert.equal(via(undefined).source, "unknown");
        assert.equal(classify("not-listed", {}, deps()).source, "unknown");
    });
});

describe("5. the unknown default", () => {
    test("is a write outside the machine", () => {
        assert.deepEqual(classify("mystery", { anything: 1 }, deps()), { environment: "external", effect: "write", source: "unknown" });
    });
});

describe("tool names in rules", () => {
    test("match exactly, or with * for any run of characters", () => {
        assert.equal(matchesName("git", "git"), true);
        assert.equal(matchesName("git", "gitx"), false);
        assert.equal(matchesName("*", "anything"), true);
        assert.equal(matchesName("mcp__*", "mcp__db__query"), true);
        assert.equal(matchesName("mcp__*__query", "mcp__db__query"), true);
        assert.equal(matchesName("mcp__*__query", "mcp__db__delete"), false);
        assert.equal(matchesName("a.b", "axb"), false, "a dot is a dot, not any character");
        assert.equal(matchesName("a+b*", "a+bcd"), true);
    });
});
