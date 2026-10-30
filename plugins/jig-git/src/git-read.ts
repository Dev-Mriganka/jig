// The git actions that only read: status, diff, log, show, blame and branches. Each returns bounded plain text; a long
// result says how much was left out and how to ask for less. Paths reach git after `--` with literal pathspecs.
import { checkBranch, checkLine, checkPath, checkPaths, checkRange, checkRev } from "./names.ts";
import type { Call, Planned, Reply } from "./previews.ts";
import { readOnly } from "./previews.ts";
import { baseBranch, baseRef, discoverRepos, isProtected, repoHere, resolveRepo, shortRef } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { gitOut } from "./run.ts";
import { clip, firstLines, mapPool, plural } from "./text.ts";

const MAX_BYTES = 4 * 1024 * 1024;

// ---- status -------------------------------------------------------------------------------------------------------

interface RepoState {
    name: string;
    branch: string;
    detached: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
    changed: number;
    error?: string;
}

/** Reads `git status --porcelain=v2 --branch`. */
export function parseStatus(out: string): Omit<RepoState, "name"> {
    let branch = "(unknown)";
    let oid = "";
    let upstream: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    let changed = 0;
    for (const line of out.split("\n")) {
        if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
        else if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length);
        else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length);
        else if (line.startsWith("# branch.ab ")) {
            const match = /\+(\d+) -(\d+)/.exec(line);
            if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
        } else if (/^[12u?] /.test(line)) changed++;
    }
    const detached = branch === "(detached)";
    if (detached) branch = `(detached at ${oid.slice(0, 7)})`;
    return { branch, detached, upstream, ahead, behind, changed };
}

function track(state: Omit<RepoState, "name">): string {
    if (state.detached) return "detached";
    if (!state.upstream) return "no upstream";
    if (state.ahead === undefined) return "upstream gone";
    if (state.ahead === 0 && state.behind === 0) return "up to date";
    return [state.ahead ? `ahead ${state.ahead}` : "", state.behind ? `behind ${state.behind}` : ""]
        .filter(Boolean)
        .join(" ");
}

async function stateOf(repo: Repo, signal?: AbortSignal): Promise<RepoState> {
    try {
        const out = await gitOut(repo.root, ["status", "--porcelain=v2", "--branch"], { signal });
        return { name: repo.name, ...parseStatus(out) };
    } catch (error) {
        return { name: repo.name, branch: "?", detached: false, changed: 0, error: (error as Error).message };
    }
}

/** How far HEAD is from the base branch: commits only HEAD has (ahead) and commits only the base has (behind). */
async function againstBase(repo: Repo, call: Call): Promise<string | undefined> {
    try {
        const base = await baseBranch(repo, call.settings, call.signal);
        const ref = await baseRef(repo, base, call.signal);
        const counts = (
            await gitOut(repo.root, ["rev-list", "--left-right", "--count", `${ref}...HEAD`], { signal: call.signal })
        )
            .trim()
            .split(/\s+/);
        const [behind, ahead] = [Number(counts[0]), Number(counts[1])];
        return `${shortRef(ref)}: ${ahead === 0 && behind === 0 ? "same commit" : `ahead ${ahead}, behind ${behind}`}`;
    } catch {
        return undefined;
    }
}

const STATUS_FILES = 200;

async function statusOne(repo: Repo, call: Call): Promise<Reply> {
    const state = await stateOf(repo, call.signal);
    if (state.error) throw new Error(state.error);
    const files = await gitOut(repo.root, ["status", "--porcelain=v1", "--untracked-files=normal"], {
        signal: call.signal,
    });
    const shown = firstLines(files, STATUS_FILES);
    const base = await againstBase(repo, call);
    const text = [
        `${repo.name}  ${state.branch}`,
        state.upstream ? `upstream ${state.upstream}: ${track(state)}` : track(state),
        base ? `base ${base}` : undefined,
        state.changed === 0 ? "working tree clean" : `${plural(state.changed, "changed file")}:`,
        shown.text || undefined,
        shown.cut > 0 ? `... ${shown.cut} more; name paths to see them` : undefined,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
    return { text, details: state };
}

async function statusAll(call: Call): Promise<Reply> {
    const repos = await discoverRepos(call.signal);
    if (repos.length === 0) return { text: "No git repositories found in the workspace." };
    const states = await mapPool(repos, 8, (repo) => stateOf(repo, call.signal));
    const width = Math.min(40, Math.max(...states.map((s) => s.name.length)));
    const lines = states.map((s) =>
        s.error
            ? `${s.name.padEnd(width)}  error: ${clip(s.error, 160)}`
            : `${s.name.padEnd(width)}  ${s.branch}  ${track(s)}  ${s.changed === 0 ? "clean" : `${s.changed} changed`}`,
    );
    return { text: lines.join("\n"), details: states };
}

export function planStatus(params: { repo?: string }, call: Call): Planned {
    return readOnly(`git status ${params.repo ?? "here"}`, async () => {
        if (params.repo !== undefined) return statusOne(await resolveRepo(params.repo, call.signal), call);
        const here = await repoHere(call.signal);
        return here ? statusOne(here, call) : statusAll(call);
    });
}

// ---- diff ---------------------------------------------------------------------------------------------------------

const DIFF_LINES = { summary: 300, names: 300, patch: 500 } as const;
type DiffFormat = keyof typeof DIFF_LINES;

const FORMAT_FLAGS: Record<DiffFormat, string> = { summary: "--stat=120", names: "--name-status", patch: "--patch" };

function diffFormat(value: unknown, allowed: readonly string[], action: string): DiffFormat {
    const format = value === undefined ? "summary" : value;
    if (typeof format !== "string" || !allowed.includes(format))
        throw new Error(`git ${action}: format must be one of ${allowed.join(", ")}`);
    return format as DiffFormat;
}

interface DiffParams {
    repo?: string;
    against?: "working" | "staged" | "base";
    base?: string;
    range?: string;
    format?: string;
    paths?: string[];
}

export function planDiff(params: DiffParams, call: Call): Planned {
    const format = diffFormat(params.format, ["summary", "names", "patch"], "diff");
    if (params.range !== undefined && (params.against !== undefined || params.base !== undefined)) {
        throw new Error("git diff takes either range, or against with base: not both");
    }
    if (params.base !== undefined && params.against !== undefined && params.against !== "base")
        throw new Error("git diff: base goes with against: base");
    const range = params.range === undefined ? undefined : checkRange(params.range);
    const paths = params.paths === undefined || params.paths.length === 0 ? [] : checkPaths(params.paths);
    const against = params.against ?? (params.base !== undefined ? "base" : "working");
    return readOnly(`git diff ${range ?? against} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        let target: string[];
        let label: string;
        if (range !== undefined) {
            target = [range];
            label = range;
        } else if (against === "staged") {
            target = ["--cached"];
            label = "staged changes vs HEAD";
        } else if (against === "base") {
            const base =
                params.base === undefined
                    ? await baseBranch(repo, call.settings, call.signal)
                    : checkBranch(params.base, "base");
            const ref = await baseRef(repo, base, call.signal);
            const mergeBase = (await gitOut(repo.root, ["merge-base", ref, "HEAD"], { signal: call.signal })).trim();
            target = [mergeBase];
            label = `working tree vs merge base with ${shortRef(ref)} (${mergeBase.slice(0, 7)})`;
        } else {
            target = ["HEAD"];
            label = "working tree vs HEAD";
        }
        const args = [
            "--literal-pathspecs",
            "diff",
            FORMAT_FLAGS[format],
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            ...target,
            "--",
            ...paths,
        ];
        const out = await gitOut(repo.root, args, { signal: call.signal, maxBytes: MAX_BYTES });
        let note = "";
        if (range === undefined && against !== "staged") {
            const untracked = (
                await gitOut(repo.root, ["ls-files", "--others", "--exclude-standard"], { signal: call.signal })
            )
                .split("\n")
                .filter(Boolean).length;
            if (untracked > 0) note = `\n(${plural(untracked, "untracked file")} not shown)`;
        }
        if (out.trim() === "") return { text: `No changes: ${label}.${note}` };
        const shown = firstLines(out, DIFF_LINES[format]);
        const more = shown.cut > 0 ? `\n... ${shown.cut} more lines; name paths to see less` : "";
        return { text: `${label}\n${shown.text}${more}${note}` };
    });
}

// ---- log ----------------------------------------------------------------------------------------------------------

interface LogParams {
    repo?: string;
    range?: string;
    paths?: string[];
    author?: string;
    since?: string;
    until?: string;
    grep?: string;
    n?: number;
    format?: string;
}

const FIELD = "\u001f";
const RECORD = "\u001e";

export function planLog(params: LogParams, call: Call): Planned {
    const format = params.format ?? "oneline";
    if (format !== "oneline" && format !== "full") throw new Error("git log: format must be one of oneline, full");
    const n = Math.max(1, Math.min(100, Math.trunc(params.n ?? 20)));
    const args = [
        "--literal-pathspecs",
        "log",
        `-n${n}`,
        "--date=short",
        "--no-color",
        `--format=${RECORD}%h${FIELD}%ad${FIELD}%an${FIELD}%s${FIELD}%b`,
    ];
    if (params.author !== undefined) args.push(`--author=${checkLine(params.author, "author")}`);
    if (params.since !== undefined) args.push(`--since=${checkLine(params.since, "since")}`);
    if (params.until !== undefined) args.push(`--until=${checkLine(params.until, "until")}`);
    if (params.grep !== undefined) args.push(`--grep=${checkLine(params.grep, "grep")}`, "--regexp-ignore-case");
    if (params.range !== undefined) args.push(checkRange(params.range));
    const paths = params.paths === undefined || params.paths.length === 0 ? [] : checkPaths(params.paths);
    return readOnly(`git log in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const out = await gitOut(repo.root, [...args, "--", ...paths], { signal: call.signal });
        const commits = out
            .split(RECORD)
            .filter((record) => record.trim() !== "")
            .map((record) => {
                const [hash = "", date = "", author = "", subject = "", body = ""] = record.split(FIELD);
                return { hash, date, author, subject, body: body.trim() };
            });
        if (commits.length === 0) return { text: "No commits match." };
        const text = commits
            .map((c) => {
                const head = `${c.hash} ${c.date} ${c.author}: ${clip(c.subject, 160)}`;
                if (format === "oneline" || c.body === "") return head;
                return `${head}\n${firstLines(c.body, 12).text.replace(/^/gm, "    ")}`;
            })
            .join("\n");
        return { text: `${plural(commits.length, "commit")}\n${text}`, details: { commits } };
    });
}

// ---- show ---------------------------------------------------------------------------------------------------------

const SHOW_LINES = 400;

interface ShowParams {
    repo?: string;
    rev?: string;
    path?: string;
    format?: string;
}

export function planShow(params: ShowParams, call: Call): Planned {
    const rev = params.rev === undefined ? "HEAD" : checkRev(params.rev);
    const path = params.path === undefined ? undefined : checkPath(params.path);
    const format = diffFormat(params.format, ["summary", "names", "patch"], "show");
    return readOnly(`git show ${path ? `${rev}:${path}` : rev} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        if (path !== undefined) {
            const content = await gitOut(repo.root, ["show", "--no-color", "--no-textconv", `${rev}:${path}`], {
                signal: call.signal,
                maxBytes: MAX_BYTES,
            });
            const shown = firstLines(content, SHOW_LINES);
            return { text: `${rev}:${path}\n${shown.text}${shown.cut > 0 ? `\n... ${shown.cut} more lines` : ""}` };
        }
        const out = await gitOut(
            repo.root,
            [
                "show",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--date=short",
                FORMAT_FLAGS[format],
                "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B",
                rev,
            ],
            {
                signal: call.signal,
                maxBytes: MAX_BYTES,
            },
        );
        const shown = firstLines(out, DIFF_LINES[format]);
        return {
            text: `${shown.text}${shown.cut > 0 ? `\n... ${shown.cut} more lines; use format summary or names` : ""}`,
        };
    });
}

// ---- blame --------------------------------------------------------------------------------------------------------

const BLAME_LINES = 300;

export function planBlame(params: { repo?: string; path?: string; rev?: string; lines?: string }, call: Call): Planned {
    const path = checkPath(params.path);
    const rev = params.rev === undefined ? undefined : checkRev(params.rev);
    if (params.lines !== undefined && !/^\d+(,\+?\d+)?$/.test(params.lines))
        throw new Error('git blame: lines must look like "10,20" or "10,+5"');
    return readOnly(`git blame ${path} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const args = [
            "blame",
            "--date=short",
            "-w",
            ...(params.lines ? ["-L", params.lines] : []),
            ...(rev ? [rev] : []),
            "--",
            path,
        ];
        const out = await gitOut(repo.root, args, { signal: call.signal, maxBytes: MAX_BYTES });
        const shown = firstLines(out, BLAME_LINES);
        return {
            text: `${shown.text}${shown.cut > 0 ? `\n... ${shown.cut} more lines; pass lines to see a range` : ""}`,
        };
    });
}

// ---- branches -----------------------------------------------------------------------------------------------------

const BRANCH_LINES = 80;

export function planBranches(params: { repo?: string; contains?: string; remotes?: boolean }, call: Call): Planned {
    const contains = params.contains === undefined ? undefined : checkRev(params.contains, "contains");
    return readOnly(`git branches in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const format =
            "%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)\t%(committerdate:short)\t%(subject)";
        const refs = params.remotes ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
        const out = await gitOut(
            repo.root,
            [
                "for-each-ref",
                "--sort=-committerdate",
                `--format=${format}`,
                ...(contains ? ["--contains", contains] : []),
                ...refs,
            ],
            { signal: call.signal },
        );
        const rows: string[] = [];
        for (const line of out.split("\n").filter(Boolean)) {
            const [head = "", ref = "", name = "", upstream = "", trackText = "", date = "", ...subject] =
                line.split("\t");
            if (ref.endsWith("/HEAD")) continue;
            const guarded =
                ref.startsWith("refs/heads/") && (await isProtected(repo, name, call.settings, call.signal));
            const where = upstream ? `-> ${upstream}${trackText ? ` [${trackText}]` : ""}` : "no upstream";
            rows.push(
                `${head === "*" ? "*" : " "} ${name}${guarded ? " (protected)" : ""}  ${where}  ${date}  ${clip(subject.join("\t"), 80)}`,
            );
        }
        if (rows.length === 0) return { text: contains ? `No branches contain ${contains}.` : "No branches." };
        const shown = rows.slice(0, BRANCH_LINES);
        return {
            text: `${repo.name}\n${shown.join("\n")}${rows.length > shown.length ? `\n... ${rows.length - shown.length} more` : ""}`,
        };
    });
}
