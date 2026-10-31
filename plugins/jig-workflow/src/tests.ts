// Running a repository's tests, and recording what happened against the exact commit. The command comes from the user's
// `workflow.tests` or from the build file in the repository's root. It runs inside the sandbox when there is one; without it,
// only after the user has approved the exact commands (the gate makes the call ask, and the tool checks the approval).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestRule, WorkflowSettings } from "./config.ts";
import { withEnvironment } from "./environment.ts";
import type { Host } from "./host.ts";
import type { RepoView } from "./repos.ts";
import type { TestResult } from "./store.ts";

/** What `workflow test` will run in one repository. */
export interface TestPlan {
    root: string;
    name: string;
    /** Absent when no command is known: then `problem` says what to set. */
    command?: string;
    timeoutSeconds: number;
    /** Plain variables the command runs with. */
    env?: Readonly<Record<string, string>>;
    /** Where the command came from: `jig.json` or the build file that was found. */
    source?: string;
    problem?: string;
}

/** How many lines of output the tool hands back, and how many characters at most. */
const TAIL_LINES = 60;
const TAIL_CHARS = 8000;

// ---- the command ---------------------------------------------------------------------------------------------------------

function escapeRegExp(text: string): string {
    return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** A path pattern as a regular expression: `*` is any run of characters but `/`, `**` any run at all, `?` one character. */
export function globToRegExp(pattern: string): RegExp {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i] as string;
        if (char === "*" && pattern[i + 1] === "*") {
            source += ".*";
            i++;
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else source += escapeRegExp(char);
    }
    return new RegExp(`^${source}$`);
}

const isPattern = (key: string): boolean => /[/*?]/.test(key);

/** Whether a `workflow.tests` key names this repository: by folder or origin name, or as a pattern over its path. */
export function ruleMatches(rule: Pick<TestRule, "key">, view: RepoView, cwd: string): boolean {
    if (!isPattern(rule.key))
        return rule.key === view.name || (view.remoteName !== undefined && rule.key === view.remoteName);
    const pattern = globToRegExp(rule.key);
    const relative = path.relative(cwd, view.root).split(path.sep).join("/");
    return pattern.test(view.root) || (!relative.startsWith("..") && pattern.test(relative));
}

const NPM_PLACEHOLDER = /no test specified/;

/** The default command for the build file found in the root, and the file: the first row of the table in the docs that is found. */
export function detectCommand(root: string): { command: string; file: string } | undefined {
    const has = (name: string): boolean => existsSync(path.join(root, name));
    if (has("gradlew")) return { command: "./gradlew test", file: "gradlew" };
    for (const file of ["build.gradle", "build.gradle.kts"]) if (has(file)) return { command: "gradle test", file };
    if (has("pom.xml")) return { command: "mvn -q test", file: "pom.xml" };
    if (has("package.json")) {
        try {
            const scripts = (
                JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: { test?: unknown } }
            ).scripts;
            if (typeof scripts?.test === "string" && !NPM_PLACEHOLDER.test(scripts.test)) {
                return { command: "npm test", file: "package.json" };
            }
        } catch {
            // A package.json that is not valid has no test script to run.
        }
    }
    for (const file of ["pyproject.toml", "pytest.ini", "tox.ini", "setup.py"])
        if (has(file)) return { command: "pytest", file };
    if (has("go.mod")) return { command: "go test ./...", file: "go.mod" };
    if (has("Cargo.toml")) return { command: "cargo test", file: "Cargo.toml" };
    return undefined;
}

/** The command for a repository: the first `workflow.tests` entry that matches, else the build file's default. */
export function planTests(settings: WorkflowSettings, view: RepoView, cwd: string): TestPlan {
    const rule = settings.tests.find((candidate) => ruleMatches(candidate, view, cwd));
    if (rule !== undefined) {
        return {
            root: view.root,
            name: view.name,
            command: rule.command,
            timeoutSeconds: rule.timeoutSeconds ?? settings.testTimeoutSeconds,
            ...(rule.env === undefined ? {} : { env: rule.env }),
            source: `workflow.tests "${rule.key}"`,
        };
    }
    const found = detectCommand(view.root);
    if (found !== undefined) {
        return {
            root: view.root,
            name: view.name,
            command: found.command,
            timeoutSeconds: settings.testTimeoutSeconds,
            source: found.file,
        };
    }
    return {
        root: view.root,
        name: view.name,
        timeoutSeconds: settings.testTimeoutSeconds,
        problem: `no test command is known for ${view.name}: set workflow.tests in jig.json, such as { "${view.name}": "npm test" }`,
    };
}

/** What a user's yes to a plan rests on, besides the commits: the folder, the command, its variables and its time limit. */
export function testIdentity(plan: TestPlan): Array<string | number | undefined> {
    return [plan.root, plan.command, plan.timeoutSeconds, JSON.stringify(plan.env ?? {})];
}

// ---- running it ---------------------------------------------------------------------------------------------------------

export interface TestRun {
    result: TestResult;
    /** The end of what the command printed, for the agent to read. Not saved. */
    tail: string;
    truncated: boolean;
}

export function tailOf(output: string): string {
    const lines = output.replace(/\r\n?/g, "\n").trimEnd().split("\n");
    const kept = lines.slice(-TAIL_LINES).join("\n");
    return kept.length > TAIL_CHARS ? kept.slice(-TAIL_CHARS) : kept;
}

/**
 * Runs the command of a plan in its repository and describes how it ended, against the commit and tree the repository was in
 * when the run began (`view`). `sandboxed` says where: in the sandbox through `host.sandbox`, or as the user through a shell.
 * A run that is cancelled throws; nothing is recorded for it.
 */
export async function runTests(
    host: Host,
    plan: TestPlan,
    view: RepoView,
    options: { sandboxed: boolean; signal?: AbortSignal },
): Promise<TestRun> {
    if (plan.command === undefined) throw new Error(plan.problem ?? "no test command");
    if (view.head === undefined) throw new Error(view.problem ?? `${view.name} has no commit to test`);
    const started = host.now();
    const timeoutMs = plan.timeoutSeconds * 1000;
    const signal = options.signal === undefined ? {} : { signal: options.signal };
    let code: number | null;
    let timedOut: boolean;
    let output: string;
    let truncated = false;
    if (options.sandboxed) {
        // The sandbox takes a command and nothing else, so the variables are set by the command line itself.
        const ran = await host.sandbox.run(withEnvironment(plan.command, plan.env), {
            cwd: plan.root,
            timeoutMs,
            ...signal,
        });
        ({ code, timedOut, output, truncated } = ran);
    } else {
        const ran = await host.run("/bin/sh", ["-c", plan.command], {
            cwd: plan.root,
            timeoutMs,
            ...(plan.env === undefined ? {} : { env: plan.env }),
            ...signal,
        });
        code = ran.code;
        timedOut = ran.timedOut;
        output = [ran.stdout, ran.stderr].filter((part) => part !== "").join("\n");
    }
    const finished = host.now();
    return {
        result: {
            head: view.head,
            clean: view.clean === true,
            passed: code === 0 && !timedOut,
            command: plan.command,
            exitCode: code,
            timedOut,
            sandboxed: options.sandboxed,
            at: finished.toISOString(),
            durationMs: Math.max(0, finished.getTime() - started.getTime()),
        },
        tail: tailOf(output),
        truncated,
    };
}
