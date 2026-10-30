// `.git/config` is writable from the agent's shell (remotes, tracking and `git config` have to work there), but Jig's
// tools run git outside the sandbox with the user's credentials, in repositories the agent can write to. A command or
// a redirect planted in a repository's own configuration would then run on an approved fetch or push. So before git
// runs, the repository's local configuration is checked, and a key that makes git run a program or redirect a
// remote refuses the call in one line. Normal configuration (remote.*, branch.*, user.*, core.bare, ...) passes.
//
// The check is read-only and cached by the configuration files' stat, so after the first call it costs a few stats.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

/** Keys without a subsection (`core.sshcommand`), in lower case. The value is not looked at. */
const PLAIN = new Set([
    "core.sshcommand",
    "core.pager",
    "core.editor",
    "core.askpass",
    "core.hookspath",
    "core.gitproxy",
    "credential.helper",
    "diff.external",
    "protocol.allow",
    "uploadpack.packobjectshook",
    "gpg.program",
    "sequence.editor",
    "include.path",
]);

/** Variables that are dangerous under any subsection (`filter.<name>.clean`), by section. */
const SUBSECTION: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["credential", new Set(["helper"])],
    ["filter", new Set(["clean", "smudge", "process"])],
    ["diff", new Set(["textconv", "command"])],
    ["merge", new Set(["driver"])],
    ["url", new Set(["insteadof", "pushinsteadof"])],
    ["protocol", new Set(["allow"])],
    ["gpg", new Set(["program"])],
    ["includeif", new Set(["path"])],
]);

/** Git's boolean false: `false`, `no`, `off`, `0` or an empty value. A bare key (no `=`) is true. */
function isFalse(value: string | undefined): boolean {
    if (value === undefined) return false;
    const text = value.trim().toLowerCase();
    return text === "" || text === "false" || text === "no" || text === "off" || /^[+-]?0+$/.test(text);
}

/** Whether git would run a program or redirect a remote because of this key. Case does not matter, as in git. */
export function isDangerousKey(key: string, value?: string): boolean {
    const lower = key.toLowerCase();
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    if (first < 0) return false;
    if (first === last) {
        // `core.fsmonitor=false` is the safe setting, and Jig's own fixed flags set exactly that.
        if (lower === "core.fsmonitor") return !isFalse(value);
        return PLAIN.has(lower);
    }
    return SUBSECTION.get(lower.slice(0, first))?.has(lower.slice(last + 1)) === true;
}

/** The key as `git config --unset` takes it, quoted for a shell when it has odd characters. */
function unsetHint(key: string): string {
    return /^[\w.-]+$/.test(key) ? key : `'${key.replaceAll("'", "'\\''")}'`;
}

/**
 * The refusal for the first dangerous key that the local or per-worktree configuration sets, read from the output of
 * `git config --list --null --show-origin --show-scope`. Each entry there is: scope NUL origin NUL key [LF value] NUL.
 * Entries from the global and system configuration and from the command line are not the repository's, and are
 * ignored.
 */
export function refusalFromList(listing: string, cwd: string): string | undefined {
    const parts = listing.split("\0");
    for (let index = 0; index + 2 < parts.length; index += 3) {
        const scope = parts[index] as string;
        if (scope !== "local" && scope !== "worktree") continue;
        const entry = parts[index + 2] as string;
        const newline = entry.indexOf("\n");
        const key = newline < 0 ? entry : entry.slice(0, newline);
        const value = newline < 0 ? undefined : entry.slice(newline + 1);
        if (!isDangerousKey(key, value)) continue;
        const origin = parts[index + 1] as string;
        const file = origin.startsWith("file:") ? path.resolve(cwd, origin.slice(5)) : origin;
        return (
            `${file} sets ${key}, which would run with your credentials: ` +
            `remove it (git config --unset ${unsetHint(key)}) or ask the user`
        );
    }
    return undefined;
}

// ---- finding and caching ----------------------------------------------------------------------------------------------

/** The git directory of a checkout, and the common one it shares with its linked worktrees. */
interface GitDirs {
    gitDir: string;
    commonDir: string;
}

/**
 * The git directories of the checkout in `dir`: `.git` itself, or for a linked worktree the folder its `.git` file
 * points at plus, through `commondir`, the common one. Undefined when `dir` is no checkout.
 */
function gitDirsOf(dir: string): GitDirs | undefined {
    const dotGit = path.join(dir, ".git");
    try {
        const stat = lstatSync(dotGit);
        let gitDir: string;
        let commonDir: string;
        if (stat.isDirectory()) {
            gitDir = commonDir = dotGit;
        } else if (stat.isFile() && stat.size <= 4096) {
            const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
            if (pointer === null) return undefined;
            gitDir = commonDir = path.resolve(dir, pointer[1] as string);
            try {
                const common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
                if (common !== "") commonDir = path.resolve(gitDir, common);
            } catch {
                // A submodule or a plain gitdir file: the folder is its own common directory.
            }
        } else {
            return undefined;
        }
        const realCommon = realpathSync(commonDir);
        if (!statSync(path.join(realCommon, "HEAD")).isFile()) return undefined;
        return { gitDir: realpathSync(gitDir), commonDir: realCommon };
    } catch {
        return undefined;
    }
}

type Location = GitDirs | "unknown" | "none";

/** A git directory itself (a bare repository): git finds it without a `.git`. */
function isGitDirectory(dir: string): boolean {
    try {
        return statSync(path.join(dir, "HEAD")).isFile() && statSync(path.join(dir, "objects")).isDirectory();
    } catch {
        return false;
    }
}

/** Where git would find the repository from `cwd`, the way its discovery walks up. "unknown" is a `.git` we cannot read. */
function locate(cwd: string): Location {
    let dir = path.resolve(cwd);
    for (;;) {
        let hasDotGit = false;
        try {
            lstatSync(path.join(dir, ".git"));
            hasDotGit = true;
        } catch {
            // None here.
        }
        if (hasDotGit) return gitDirsOf(dir) ?? "unknown";
        if (isGitDirectory(dir)) return { gitDir: dir, commonDir: dir };
        const parent = path.dirname(dir);
        if (parent === dir) return "none";
        dir = parent;
    }
}

function stamp(file: string): string {
    try {
        const stat: BigIntStats = statSync(file, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return "-";
    }
}

interface Known {
    stamp: string;
    refusal: string | undefined;
}
const known = new Map<string, Known>();
const MAX_KNOWN = 200;

/** Forgets what was checked. For tests. */
export function forgetCheckedConfigs(): void {
    known.clear();
}

/**
 * The one-line refusal when the repository git would use from `cwd` has a local key that runs a program or redirects a
 * remote, else undefined. That includes outside any repository, and when `list` cannot read the configuration: the
 * real call then fails for the same reason. `list` returns the output of
 * `git config --list --null --show-origin --show-scope`.
 */
export function gitConfigRefusal(cwd: string, list: (cwd: string) => string | undefined): string | undefined {
    const where = locate(cwd);
    if (where === "none") return undefined;
    // The stamp is taken before the configuration is read, so an edit during the read changes it and the next call
    // looks again.
    const key = where === "unknown" ? undefined : `${where.commonDir}\0${where.gitDir}`;
    const now =
        where === "unknown"
            ? undefined
            : `${stamp(path.join(where.commonDir, "config"))}|${stamp(path.join(where.gitDir, "config.worktree"))}`;
    if (key !== undefined && now !== undefined) {
        const cached = known.get(key);
        if (cached?.stamp === now) return cached.refusal;
    }
    const listing = list(cwd);
    if (listing === undefined) return undefined;
    const refusal = refusalFromList(listing, cwd);
    if (key !== undefined && now !== undefined) {
        if (known.size >= MAX_KNOWN) known.clear();
        known.set(key, { stamp: now, refusal });
    }
    return refusal;
}
