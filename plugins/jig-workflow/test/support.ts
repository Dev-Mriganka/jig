// Test support: real git repositories in temporary folders, and a `Host` that runs the real git but fakes `gh` and the sandbox.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type {
    Preview,
    RunOptions,
    RunResult,
    SandboxRunOptions,
    SandboxRunResult,
} from "../../jig-core/src/contract.ts";
import type { Host } from "../src/host.ts";

/** A temporary folder, removed when the test ends. Its real path, so comparisons do not trip over a link in /tmp. */
export function tempFolder(t: TestContext, prefix = "jig-workflow-"): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A repository with one commit. `remote` sets origin's address. Returns its real path. */
export function makeRepo(parent: string, name: string, remote?: string): string {
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "first\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
    if (remote !== undefined) git(dir, "remote", "add", "origin", remote);
    return realpathSync(dir);
}

/** Adds a commit and returns its full id. */
export function commit(repo: string, file = "change.txt", content = `${Math.random()}\n`): string {
    writeFileSync(path.join(repo, file), content);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `change ${file}`);
    return git(repo, "rev-parse", "HEAD");
}

export const headOf = (repo: string): string => git(repo, "rev-parse", "HEAD");

export const NOW = new Date("2026-10-31T12:00:00.000Z");

export type RunScript = (file: string, args: readonly string[], options: RunOptions) => RunResult | Promise<RunResult>;

export interface FakeHost extends Host {
    /** Every program the plugin ran through `run`, in order. */
    ran: Array<{ file: string; args: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }>;
    /** Every command sent to the sandbox. */
    sandboxed: Array<{ command: string; cwd: string; timeoutMs?: number }>;
    /** Whether the sandbox can run commands now; a test flips it. */
    sandboxOn: boolean;
    /** The previews the user approved, by tool call id: a test puts one in as jig-core would after a yes. */
    approved: Map<string, Preview>;
    clock: { now: Date };
}

export function ok(stdout = "", code = 0, stderr = ""): RunResult {
    return { code, stdout, stderr, timedOut: false };
}

/** A host with the real git, the given script standing in for every other program, and a sandbox that answers as told. */
export function fakeHost(
    over: {
        run?: RunScript;
        sandbox?: (command: string, options: SandboxRunOptions) => SandboxRunResult | Promise<SandboxRunResult>;
        /** The `git` section of `jig.json`, as jig-core would give it. */
        gitSection?: unknown;
    } = {},
): FakeHost {
    const host: FakeHost = {
        ran: [],
        sandboxed: [],
        sandboxOn: true,
        approved: new Map(),
        clock: { now: NOW },
        git: (root, args) =>
            new Promise((resolve) => {
                execFile(
                    "git",
                    ["-c", "core.hooksPath=/dev/null", ...args],
                    { cwd: root, env: GIT_ENV, encoding: "utf8" },
                    (error, stdout, stderr) => {
                        const code =
                            error === null
                                ? 0
                                : typeof (error as { code?: unknown }).code === "number"
                                  ? (error as { code: number }).code
                                  : 1;
                        resolve({ code, stdout, stderr, timedOut: false });
                    },
                );
            }),
        async run(file, args, options) {
            host.ran.push({
                file,
                args,
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.env === undefined ? {} : { env: options.env }),
            });
            if (over.run === undefined) throw new Error(`no program ${file} in this test`);
            return over.run(file, args, options);
        },
        sandbox: {
            canRun: () => host.sandboxOn,
            async run(command, options) {
                host.sandboxed.push({
                    command,
                    cwd: options.cwd,
                    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                });
                if (!host.sandboxOn) throw new Error("no sandbox can run this command");
                return over.sandbox?.(command, options) ?? { code: 0, output: "", timedOut: false, truncated: false };
            },
        },
        approvedPreview: (toolCallId) => host.approved.get(toolCallId),
        gitSection: () => over.gitSection,
        now: () => host.clock.now,
    };
    return host;
}

/** What `gh pr view --json ...` prints for a pull request. */
export function prJson(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
        number: 7,
        state: "OPEN",
        isDraft: false,
        headRefOid: "0".repeat(40),
        url: "https://github.example.com/acme/orders-api/pull/7",
        statusCheckRollup: [],
        ...over,
    });
}

/** A passed check run and a passed commit status, as GitHub's roll-up has them. */
export const PASSED = [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "lint", state: "SUCCESS" },
];

// ---- GitLab's answers, written down ------------------------------------------------------------------------------------
// The fields are the ones a real merge request and pipeline job carry in GitLab's REST API (v4), trimmed to what the plugin
// reads. Every name is made up: `platform/payments/orders-api`, `gitlab.example.com`.

/** A merge request, as `GET projects/:id/merge_requests` gives it for a branch. */
export function mrJson(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 90042,
        iid: 42,
        project_id: 7,
        source_project_id: 7,
        target_project_id: 7,
        title: "PROJ-1: cache the price list",
        state: "opened",
        draft: false,
        source_branch: "main",
        target_branch: "develop",
        sha: "0".repeat(40),
        web_url: "https://gitlab.example.com/platform/payments/orders-api/-/merge_requests/42",
        head_pipeline: {
            id: 301,
            iid: 12,
            project_id: 7,
            sha: "0".repeat(40),
            ref: "main",
            status: "success",
            web_url: "https://gitlab.example.com/platform/payments/orders-api/-/pipelines/301",
        },
        ...over,
    };
}

/** A job of a pipeline, as `GET projects/:id/pipelines/:id/jobs` gives it. */
export function jobJson(name: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 5000 + name.length, name, stage: "test", status, allow_failure: false, ...over };
}

export const GREEN_JOBS = [jobJson("build", "success"), jobJson("test", "success"), jobJson("lint", "success")];

/** What `glab api` prints for the endpoints a merge request is read through, by what the endpoint contains. */
export function glabAnswers(answers: Array<[match: string | RegExp, reply: unknown | RunResult]>): RunScript {
    return (file, args) => {
        if (file !== "glab") return ok("", 127, `no program ${file} in this test`);
        const endpoint = args.at(-1) ?? "";
        for (const [match, reply] of answers) {
            if (typeof match === "string" ? endpoint.includes(match) : match.test(endpoint)) {
                const result = reply as Partial<RunResult> & { code?: number };
                if (typeof result === "object" && result !== null && "code" in result && "stderr" in result)
                    return reply as RunResult;
                return ok(JSON.stringify(reply));
            }
        }
        return ok("[]");
    };
}
