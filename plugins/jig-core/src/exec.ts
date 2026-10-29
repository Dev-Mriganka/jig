// Running programs for Jig's tools: from an argument list, never a shell, with a timeout, an output cap and a minimal
// environment. Git gets extra care, because it runs in repositories the agent's shell can write to.
//
// Why so careful: these programs run outside the sandbox, with the user's credentials. Anything in a repository that
// git would execute (a hook, a `core.fsmonitor` command, a configured ssh command) has to be switched off or
// refused first, and a program name has to mean the program the user installed, not one the agent planted.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { RunOptions, RunResult } from "./contract.ts";
import { gitConfigRefusal } from "./git-config-guard.ts";

/** A call that could not run, or whose outcome is not a normal exit: the program is missing, it was aborted, or the
 *  repository's own configuration was refused. A program that ran and failed is a `RunResult` with its exit code. */
export class ExecError extends Error {}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** The exit code reported when a program was stopped for taking too long, as `timeout(1)` does. */
export const TIMEOUT_CODE = 124;

/**
 * Put before the subcommand of every git call. They switch off what a repository could make git execute:
 * - `core.fsmonitor`: a command that git runs on status, diff and checkout;
 * - `core.hooksPath`: hooks planted in `.git/hooks` run with the user's credentials; `/dev/null` has none. Hooks a
 *   team keeps on purpose (husky, git-lfs) do not run either.
 */
export const GIT_FIXED_FLAGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "color.ui=false"];

// ---- the environment ------------------------------------------------------------------------------------------------

/** What every program inherits from Pi's environment. Nothing else is passed on: not tokens, not cloud credentials. */
const BASE_ENV = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
];

/** What git also inherits: the user's own ssh agent and ssh command, so a push signs in the way the user set up. */
const GIT_ENV = ["SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "DBUS_SESSION_BUS_ADDRESS"];

/** Set for every git call. The values keep git from waiting for a person or running a pager, and a repository-local
 *  remote URL cannot pick a transport that runs commands (`ext::`). */
const GIT_FIXED_ENV: Readonly<Record<string, string>> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GCM_INTERACTIVE: "never",
    NO_COLOR: "1",
    LC_ALL: "C",
    GIT_ALLOW_PROTOCOL: "file:git:https:ssh",
};

/** Set for `gh` as well: no prompts, no update notice, no pager. */
const GH_FIXED_ENV: Readonly<Record<string, string>> = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
};

/** Folders the agent's own shell can write to: the working folder of Pi and of the call. */
function writableFolders(cwd: string | undefined): string[] {
    const folders: string[] = [];
    for (const folder of [safeCwd(), cwd]) {
        if (folder === undefined) continue;
        const real = realPath(folder);
        if (real !== path.parse(real).root) folders.push(real);
    }
    return folders;
}

function safeCwd(): string | undefined {
    try {
        return process.cwd();
    } catch {
        return undefined;
    }
}

function realPath(folder: string): string {
    try {
        return realpathSync(folder);
    } catch {
        return path.resolve(folder);
    }
}

function isInside(folder: string, parents: readonly string[]): boolean {
    const real = realPath(folder);
    return parents.some((parent) => real === parent || real.startsWith(parent + path.sep));
}

/** PATH without relative entries and without folders the agent can write to. A `git` or `ssh` planted in such a
 *  folder would otherwise run the next time git starts one. */
function safePath(value: string | undefined, writable: readonly string[]): string {
    return (value ?? "")
        .split(path.delimiter)
        .filter((entry) => path.isAbsolute(entry) && !isInside(entry, writable))
        .join(path.delimiter);
}

function childEnv(options: RunOptions, extraNames: readonly string[], fixed: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of [...BASE_ENV, ...extraNames]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    env.PATH = safePath(env.PATH, writableFolders(options.cwd));
    // The caller's own variables come last: a Jig tool passing credentials is trusted code, and the agent's shell
    // cannot reach this process's environment.
    return { ...env, ...fixed, ...options.env };
}

// ---- which program runs ---------------------------------------------------------------------------------------------

function isExecutableFile(file: string): boolean {
    try {
        if (!statSync(file).isFile()) return false;
        accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** An absolute path to run for `file`: a name is looked up in the safe part of PATH, an absolute path is kept. Throws
 *  `ExecError` when the program is missing or only in a folder the agent can write to. */
export function resolveProgram(file: string, cwd: string | undefined): string {
    if (path.isAbsolute(file)) return file;
    if (file.includes("/") || file.includes("\\")) throw new ExecError(`give a program name or an absolute path, not ${file}`);
    const writable = writableFolders(cwd);
    const wanted = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry));
    let rejected: string | undefined;
    for (const entry of wanted) {
        const candidate = path.join(entry, file);
        if (!isExecutableFile(candidate)) continue;
        if (!isInside(entry, writable)) return candidate;
        rejected ??= entry;
    }
    if (rejected !== undefined) {
        throw new ExecError(`${file} is on PATH only in ${rejected}, a folder the agent can write to: install it in a system folder`);
    }
    throw new ExecError(`${file} is not installed or not on PATH`);
}

// ---- running ------------------------------------------------------------------------------------------------------------

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

// Children still running. Each leads a session of its own (see below), so a Pi that quits no longer reaches them by
// itself: at exit their whole process groups are killed.
const running = new Set<Child>();
let exitHookInstalled = false;

function killGroup(child: Child): void {
    try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            // Already gone.
        }
    }
}

function track(child: Child): void {
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on("exit", () => {
            for (const live of running) killGroup(live);
        });
    }
    running.add(child);
}

/** A name for messages: the program and, for git, its subcommand. Never the arguments, which can hold secrets. */
function label(file: string, args: readonly string[]): string {
    const name = path.basename(file);
    if (name !== "git") return name;
    const subcommand = gitSubcommand(args);
    return subcommand === undefined ? name : `git ${subcommand}`;
}

/** The git subcommand of an argument list: the first word that is neither a flag nor the value of `-c` or `-C`. */
function gitSubcommand(args: readonly string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index] as string;
        if (arg === "-c" || arg === "-C") index++;
        else if (!arg.startsWith("-")) return arg;
    }
    return undefined;
}

/** Collects output up to a byte limit and drops the rest, so a program that prints without end cannot fill memory. */
function collector(limit: number): { add(chunk: Buffer): void; text(): string } {
    const chunks: Buffer[] = [];
    let kept = 0;
    let cut = false;
    return {
        add(chunk) {
            const room = limit - kept;
            if (room <= 0) {
                cut = true;
                return;
            }
            const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
            if (piece.length < chunk.length) cut = true;
            chunks.push(piece);
            kept += piece.length;
        },
        // The marker tells the caller the output is incomplete, which a plain cut would hide.
        text: () => Buffer.concat(chunks).toString("utf8") + (cut ? `\n[output cut at ${limit} bytes]\n` : ""),
    };
}

async function spawnProgram(
    file: string,
    args: readonly string[],
    options: RunOptions,
    env: NodeJS.ProcessEnv,
): Promise<RunResult> {
    const what = label(file, args);
    const program = resolveProgram(file, options.cwd);
    if (options.signal?.aborted) throw new ExecError(`${what} was aborted`);
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let child: Child;
        try {
            // `detached` gives the child a session of its own: it has no controlling terminal, so ssh or gpg cannot
            // prompt on Pi's screen, and its whole group (git's helpers, ssh) can be killed on a timeout.
            child = spawn(program, [...args], {
                cwd: options.cwd, env, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            reject(new ExecError(`${what} could not start: ${(error as Error).message}`));
            return;
        }
        track(child);

        const stdout = collector(limit);
        const stderr = collector(limit);
        let stop: "timeout" | "aborted" | undefined;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;

        const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
            running.delete(child);
            settle();
        };
        const kill = (why: "timeout" | "aborted"): void => {
            stop ??= why;
            killGroup(child);
            // A grandchild may hold the pipes open after the kill; stop waiting for them.
            child.stdout.destroy();
            child.stderr.destroy();
        };

        child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
        child.once("error", (error: NodeJS.ErrnoException) => finish(() => {
            if (error.code === "ENOENT") reject(new ExecError(existsSync(options.cwd ?? ".") ? `${what} is not installed or not on PATH` : `the working folder ${options.cwd} does not exist`));
            else reject(new ExecError(`${what} could not start: ${error.message}`));
        }));
        child.once("close", (code, signal) => finish(() => {
            if (stop === "aborted") return reject(new ExecError(`${what} was aborted`));
            if (stop === "timeout") return resolve({ code: TIMEOUT_CODE, stdout: stdout.text(), stderr: stderr.text(), timedOut: true });
            if (typeof code === "number") return resolve({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut: false });
            resolve({ code: 1, stdout: stdout.text(), stderr: stderr.text() || `${what} was stopped by ${signal ?? "a signal"}`, timedOut: false });
        }));

        timer = setTimeout(() => kill("timeout"), timeoutMs);
        if (options.signal !== undefined) {
            onAbort = () => kill("aborted");
            options.signal.addEventListener("abort", onAbort, { once: true });
        }
        // A program that exits without reading its input must not turn the closed pipe into an unhandled error.
        child.stdin.on("error", () => {});
        child.stdin.end(options.input);
    });
}

/**
 * Runs a program from an argument list, never a shell. The environment is a short allow-list plus `options.env`.
 * `git` and `gh` go through the same checks as `git()`, because both start git.
 */
export async function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const name = path.basename(file);
    if (name === "git") return runGit(file, options.cwd ?? process.cwd(), args, options);
    if (name === "gh") {
        refuseUnsafeRepository(options.cwd ?? process.cwd(), args);
        return spawnProgram(file, args, options, childEnv(options, GIT_ENV, { ...GIT_FIXED_ENV, ...GH_FIXED_ENV }));
    }
    return spawnProgram(file, args, options, childEnv(options, [], {}));
}

/** Runs git in `repo` with hooks, `core.fsmonitor` and prompts off. Refuses when the repository's own configuration
 *  would make git run a command. */
export function git(repo: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return runGit("git", repo, args, options);
}

/** `program` is "git", or the absolute path of a git the caller chose. */
async function runGit(program: string, repo: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    const withRepo: RunOptions = { ...options, cwd: repo };
    refuseUnsafeRepository(repo, args);
    return spawnProgram(program, [...GIT_FIXED_FLAGS, ...args], withRepo, childEnv(withRepo, GIT_ENV, GIT_FIXED_ENV));
}

// ---- the repository's own configuration ----------------------------------------------------------------------------------

/**
 * `.git/config` is writable from the agent's shell, but git runs here with the user's credentials. A command or a
 * redirect planted in that file would run on the next fetch or push, so before git (or `gh`, which starts git) runs
 * in a repository, its local configuration is read and a key that runs a program or redirects a remote refuses the
 * call. `git clone` makes a new repository and reads no configuration of the folder around it, so it is not checked.
 */
function refuseUnsafeRepository(repo: string, args: readonly string[]): void {
    if (gitSubcommand(args) === "clone") return;
    const refusal = gitConfigRefusal(repo, listLocalConfig);
    if (refusal !== undefined) throw new ExecError(refusal);
}

const CONFIG_LIST_MS = 10_000;
const CONFIG_LIST_BYTES = 4 * 1024 * 1024;

/** The output of `git config --list` for the repository at `cwd`, or undefined when that cannot be read (not a
 *  repository, or git is missing): the real call then fails for the same reason. */
function listLocalConfig(cwd: string): string | undefined {
    try {
        return execFileSync(resolveProgram("git", cwd), [...GIT_FIXED_FLAGS, "config", "--list", "--null", "--show-origin", "--show-scope"], {
            cwd,
            env: childEnv({ cwd }, GIT_ENV, GIT_FIXED_ENV),
            encoding: "utf8",
            timeout: CONFIG_LIST_MS,
            killSignal: "SIGKILL",
            maxBuffer: CONFIG_LIST_BYTES,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
    } catch {
        return undefined;
    }
}
