// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. `exec.git` starts real git from an argument list with the flags jig-core puts before every subcommand. What
// the plugin tells jig-core (declarations) is recorded for the tests, and `config.section` serves what a test sets.
import { spawn } from "node:child_process";
import type { JigApi, RunOptions, RunResult, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";

/** git's own flags that jig-core puts before every subcommand: no hooks, no fsmonitor, no colour. */
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "color.ui=false"];

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    /** Every git command started: the repository and the arguments (the fixed flags left out). */
    gitCalls: Array<{ repo: string; args: string[] }>;
    /** What `config.section(name)` returns. */
    setSection(name: string, value: unknown): void;
    remove(): void;
}

function runGit(repo: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", [...GIT_FLAGS, ...args], {
            cwd: repo,
            env: {
                PATH: process.env.PATH ?? "",
                HOME: process.env.HOME ?? "",
                LC_ALL: "C",
                GIT_TERMINAL_PROMPT: "0",
                GIT_PAGER: "cat",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@example.invalid",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@example.invalid",
            },
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, options.timeoutMs ?? 60_000);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, stdout, stderr, timedOut });
        });
    });
}

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const gitCalls: FakeJig["gitCalls"] = [];
    const sections = new Map<string, unknown>();
    const api = {
        version: 1,
        declareTool: (declaration: ToolDeclaration) => void declared.set(declaration.tool, declaration),
        config: {
            registerSection: () => {},
            section: (name: string) => sections.get(name),
        },
        exec: {
            run: async () => {
                throw new Error("the review plugin runs git only");
            },
            git: (repo: string, args: readonly string[], options: RunOptions = {}) => {
                gitCalls.push({ repo, args: [...args] });
                return runGit(repo, args, options);
            },
        },
    } as unknown as JigApi;
    publishJig(api);
    return {
        api,
        declared,
        gitCalls,
        setSection: (name, value) => void sections.set(name, value),
        remove: () => withdrawJig(api),
    };
}
