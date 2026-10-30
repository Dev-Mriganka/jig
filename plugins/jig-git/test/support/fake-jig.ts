// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would
// under jig-core. Programs are real: `exec.run` and `exec.git` start real processes from an argument list, with a minimal
// environment and the hardening flags jig-core puts before every git subcommand. Secrets and masking are trivial.
// Everything the plugin tells jig-core (declarations, watch kinds, started watches, facts) is recorded for the tests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
    Facts,
    JigApi,
    Preview,
    RunOptions,
    RunResult,
    StartWatch,
    ToolDeclaration,
    WatchInfo,
    WatchKind,
} from "../../../jig-core/src/contract.ts";
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";

/** git's own flags that jig-core puts before every subcommand: no hooks, no fsmonitor, no colour. */
export const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "color.ui=false"];

/** Keys of a repository's own config that make git run a program. jig-core refuses a repository that sets one. */
const DANGEROUS = new Set([
    "credential.helper",
    "core.sshcommand",
    "core.hookspath",
    "core.fsmonitor",
    "diff.external",
    "gpg.program",
    "include.path",
]);

/** Variables a test sets on the Pi process that jig-core would also pass on: the user's identity and their own ssh. */
const PASS_ON = [
    "HOME",
    "PATH",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_SSH",
    "GIT_SSH_VARIANT",
    "SSH_AUTH_SOCK",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GH_HOST",
];

export interface StartedWatch extends StartWatch<unknown> {
    id: string;
}

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    kinds: Map<string, WatchKind<unknown, unknown>>;
    started: StartedWatch[];
    stopped: string[];
    sections: Map<string, (raw: unknown) => readonly string[]>;
    /** The approved preview of each call that asked, by tool call id. */
    approved: Map<string, Preview>;
    facts: Map<string, Facts[]>;
    /** Every program started, in order: the file, the arguments (git's fixed flags left out) and the working directory. */
    started_processes: Array<{ file: string; args: string[]; cwd?: string }>;
    /** What `config.section("git")` returns. Set with `setSection`. */
    setSection(name: string, value: unknown): void;
    /** Makes the next git call fail as jig-core does when the repository's config would run a command. */
    refuseGit(message: string): void;
    /**
     * Makes the next git call whose arguments satisfy `match` end the way a call does when its reply is lost: the plugin gets
     * `result` instead of git's own answer. With `run`, git is started first, so what the call did still happens.
     */
    loseGitReply(match: (args: readonly string[]) => boolean, result: Partial<RunResult>, run: boolean): void;
    /** Shortens the timeout of the programs `only` accepts (all, when it is left out), so a slow program is cut off at once. */
    forceTimeout(ms: number | undefined, only?: (file: string, args: readonly string[]) => boolean): void;
    /** Forgets the watches started, the programs run, the facts and the approved previews. */
    reset(): void;
    remove(): void;
}

function minimalEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const env: Record<string, string> = {
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_EDITOR: "true",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
    };
    for (const name of PASS_ON) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    return { ...env, ...extra };
}

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const kinds = new Map<string, WatchKind<unknown, unknown>>();
    const started: StartedWatch[] = [];
    const stopped: string[] = [];
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const values = new Map<string, unknown>();
    const approved = new Map<string, Preview>();
    const facts = new Map<string, Facts[]>();
    const processes: FakeJig["started_processes"] = [];
    let refusal: string | undefined;
    let forced: { ms: number; only: (file: string, args: readonly string[]) => boolean } | undefined;
    let lost: { match: (args: readonly string[]) => boolean; result: Partial<RunResult>; run: boolean } | undefined;

    const spawnProcess = (file: string, args: readonly string[], options: RunOptions): Promise<RunResult> =>
        new Promise((resolve, reject) => {
            const child = spawn(file, [...args], {
                cwd: options.cwd,
                env: minimalEnv(options.env),
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
                // A process group of its own, so a stop reaches ssh and the other helpers git starts.
                detached: true,
            });
            const killGroup = () => {
                try {
                    if (child.pid) process.kill(-child.pid, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
            };
            const limit = options.maxOutputBytes ?? 10 * 1024 * 1024;
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            let settled = false;
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                if (stdout.length < limit) stdout += chunk;
            });
            child.stderr.on("data", (chunk: string) => {
                if (stderr.length < limit) stderr += chunk;
            });
            const timer = setTimeout(
                () => {
                    timedOut = true;
                    killGroup();
                },
                forced?.only(file, args) ? forced.ms : (options.timeoutMs ?? 60_000),
            );
            const stop = () => killGroup();
            options.signal?.addEventListener("abort", stop, { once: true });
            if (options.signal?.aborted) stop();
            child.once("error", (error: NodeJS.ErrnoException) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error.code === "ENOENT") reject(new Error(`${file} is not installed or not on PATH`));
                else reject(error);
            });
            child.once("close", (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", stop);
                resolve({ code: code ?? 1, stdout, stderr, timedOut });
            });
            child.stdin.on("error", () => {});
            child.stdin.end(options.input);
        });

    const run = (file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
        processes.push({ file, args: [...args], cwd: options.cwd });
        return spawnProcess(file, args, options);
    };

    const git = async (repo: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
        if (refusal !== undefined) {
            const message = refusal;
            refusal = undefined;
            throw new Error(message);
        }
        if (fs.existsSync(path.join(repo, ".git"))) {
            const keys = await spawnProcess("git", ["config", "--local", "--name-only", "--list"], { cwd: repo });
            const hit = keys.stdout.split("\n").find((key) => DANGEROUS.has(key.trim().toLowerCase()));
            if (hit)
                throw new Error(
                    `${path.join(repo, ".git", "config")} sets ${hit.trim().toLowerCase()}, which would run with your credentials: remove it or ask the user`,
                );
        }
        processes.push({ file: "git", args: [...args], cwd: repo });
        const interception = lost?.match(args) ? lost : undefined;
        if (interception) lost = undefined;
        if (interception && !interception.run)
            return { code: 128, stdout: "", stderr: "", timedOut: false, ...interception.result };
        const real = await spawnProcess("git", [...GIT_FLAGS, ...args], { ...options, cwd: repo });
        return interception ? { ...real, ...interception.result } : real;
    };

    const api: JigApi = {
        version: 1,
        declareTool: (declaration) => void declared.set(declaration.tool, declaration),
        approvedPreview: (id) => approved.get(id),
        addFacts: (id, added) => void facts.set(id, [...(facts.get(id) ?? []), added]),
        setTicket: () => {},
        signIn: {
            register: () => {},
            headers: async () => ({}),
        },
        environments: {
            kindOf: (name: string) => (name === "local" || name === "external" ? name : name === "production" || name === "prod" ? "production" : "test"),
        },
        transports: {
            register: () => {},
            request: async () => {
                throw new Error("no transports in tests");
            },
        },
        secrets: {
            resolve: async () => {
                throw new Error("no secrets in tests");
            },
        },
        mask: { text: (input) => input, value: (input) => input },
        watches: {
            registerKind: (kind) => void kinds.set(kind.kind, kind as WatchKind<unknown, unknown>),
            start: (watch) => {
                const id = `w${started.length + 1}`;
                started.push({ ...(watch as StartWatch<unknown>), id });
                return id;
            },
            list: (): WatchInfo[] =>
                started.map((watch) => ({
                    id: watch.id,
                    kind: watch.kind,
                    plugin: "jig-git",
                    title: watch.title,
                    status: stopped.includes(watch.id) ? "done" : "open",
                    startedAt: new Date(0).toISOString(),
                })),
            stop: (id) => {
                const open = started.some((watch) => watch.id === id) && !stopped.includes(id);
                if (open) stopped.push(id);
                return open;
            },
        },
        config: {
            addEnvironments: () => {},
            addRules: () => {},
            addClassifyRules: () => {},
            addMaskFields: () => {},
            registerSection: (name, validate) => void sections.set(name, validate),
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                return value !== undefined && (validate === undefined || validate(value).length === 0)
                    ? value
                    : undefined;
            },
        },
        exec: { run, git },
    };

    publishJig(api);
    return {
        api,
        declared,
        kinds,
        started,
        stopped,
        sections,
        approved,
        facts,
        started_processes: processes,
        setSection: (name, value) => void values.set(name, value),
        refuseGit: (message) => {
            refusal = message;
        },
        loseGitReply: (match, result, run) => {
            lost = { match, result, run };
        },
        forceTimeout: (ms, only = () => true) => {
            forced = ms === undefined ? undefined : { ms, only };
        },
        reset: () => {
            started.length = 0;
            stopped.length = 0;
            processes.length = 0;
            facts.clear();
            approved.clear();
            values.clear();
            forced = undefined;
            lost = undefined;
            refusal = undefined;
        },
        remove: () => withdrawJig(api),
    };
}
