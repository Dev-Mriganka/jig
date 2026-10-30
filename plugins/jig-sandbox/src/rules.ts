// The rules as data: for a given home folder, working folder, environment and file system, which paths are hidden,
// locked or ask-first, and what the sandbox runtime is told. Pure: the only way it looks at the machine is the
// `FileView` it is given, so every layout (WSL, a Mac, links, paths that are missing) can be tested without one.
//
//   hidden     never readable: credentials, a project's secret files, the doors to other systems
//   locked     readable, never written: whatever runs later outside the sandbox
//   ask-first  writable once the user says yes: toolchain managers
//   writable   everything else under the home folder, the working folder, /tmp and the folders the user shares
//
// Paths are matched where they really are (links followed), and only paths that exist are given to the runtime: it
// cannot mount a rule for a path that is not there, and in an earlier sandbox one missing PATH folder stopped every
// command. What a command creates at a path that is locked but absent is the audit's job (audit.ts).
import path from "node:path";
import type { FileView } from "./files.ts";
import {
    ASK_FIRST,
    ASK_FIRST_BY_ENV,
    GROUPS,
    HIDDEN_IN_AGENT_DIR,
    HIDDEN_IN_HOME,
    HIDDEN_ON_MAC,
    HIDDEN_ON_WSL,
    HIDDEN_SOCKETS,
    LOCKED_IN_HOME,
    LOCKED_IN_PROJECT,
    LOCKED_ON_MAC,
    LOCKED_PI_IN_PROJECT,
    PROJECT_SECRET_NAMES,
    PROJECT_SECRET_TEMPLATES,
} from "./lists.ts";
import type { GroupName } from "./lists.ts";
import { ancestors, expand, inside, resolveLoose, shown } from "./pathing.ts";
import { findRepos, hooksPathOf } from "./repos.ts";
import type { Repo } from "./repos.ts";

export type RuleKind = "hidden" | "locked" | "ask-first";

export interface Rule {
    kind: RuleKind;
    /** Where it really is, links followed. This is what the sandbox is given. */
    path: string;
    /** The path as the rule named it, when that is a link to `path`. */
    named: string;
    /** For messages: the path with the home folder written as `~`. */
    shown: string;
    /** `cannot read X: <reason>`. */
    reason: string;
    /** What to do instead; may be empty. */
    way: string;
    /** Where the rule came from, as `/sandbox` says it. */
    source: string;
    /** Whether `share` can never open it (credentials, and everything locked). */
    floor: boolean;
}

/** An entry of jig-core's protected paths, as `jig().protectedPaths.list()` gives it. */
export interface ProtectedEntry {
    path: string;
    shown: string;
    kind: "secret" | "guarded";
    source: "default" | "personal" | "company";
}

export interface RulesInput {
    platform: "linux" | "darwin";
    /** Linux running inside Windows: `/mnt` and `/run/WSL` are doors to Windows. */
    wsl: boolean;
    /** The home folder from the password database, not `$HOME`: ssh and Java use that one. */
    home: string;
    uid: number;
    /** The working folder of the bash commands. */
    cwd: string;
    /** Pi's agent folder. */
    agentDir: string;
    /** Temporary folders the commands may write: `/tmp` and the system's. */
    tmp: readonly string[];
    /** The session's private folders: the broker's (never writable) and the commands' temporary one. */
    sessionDir: string;
    sessionTmp: string;
    /** Pi's environment: `PATH`, and the variables that move a toolchain manager. */
    env: Readonly<Record<string, string | undefined>>;
    /** The folders of the Node.js and Pi that run Pi. */
    runtimePaths: readonly string[];
    protectedPaths: readonly ProtectedEntry[];
    /** The user's additions and sharing, from the `sandbox` section. */
    settings: { share: readonly string[]; hide: readonly string[]; lock: readonly string[] };
    /** Ask-first folders the user allowed, absolute. */
    approved: readonly string[];
    /** Secret files the agent made in this session: they are its own, not hidden. */
    createdByAgent: ReadonlySet<string>;
    files: FileView;
}

export interface Writable {
    path: string;
    shown: string;
    source: string;
}

export interface PathEntry {
    path: string;
    literal: true;
}

/** What the sandbox runtime is given for the file system. */
export interface RuntimeFilesystem {
    denyRead: PathEntry[];
    allowRead: PathEntry[];
    allowWrite: PathEntry[];
    denyWrite: PathEntry[];
    allowGitConfig: true;
}

export interface RuleSet {
    /** Every rule whose path exists, hidden first. */
    rules: Rule[];
    /** Locked paths that are not on this machine now. A command can create them: the audit takes them out again. */
    missing: Rule[];
    writable: Writable[];
    /** Hidden paths that are readable again: the real `resolv.conf`, the working folder and shares under `/mnt`. */
    reopened: Writable[];
    repos: Repo[];
    /** Folders where a new `*.pth` file runs Python at start-up. */
    pthFolders: string[];
    /** Why something the user asked for was not done, such as a `share` inside `~/.ssh`. */
    problems: string[];
    /** The folders no command may write whatever else is said: the broker's. */
    protectedFolders: string[];
    home: string;
    /** The working folder, links followed. */
    cwd: string;
    files: FileView;
}

// ---- building the candidates -----------------------------------------------------------------------------------------

const PRECEDENCE: Record<RuleKind, number> = { hidden: 0, locked: 1, "ask-first": 2 };

interface Candidate {
    kind: RuleKind;
    absolute: string;
    group: GroupName;
    source: string;
}

function makeRule(candidate: Candidate, real: string, home: string): Rule {
    const group = GROUPS[candidate.group];
    return {
        kind: candidate.kind,
        path: real,
        named: candidate.absolute,
        shown: shown(real, home),
        reason: group.reason,
        way: group.way,
        source: candidate.source,
        // Everything hidden for a credential is the floor; locked paths are too, since a write there is the escape the
        // second promise is about. Only the doors to Windows can be opened again, by `share`.
        floor: candidate.kind === "locked" ? true : group.floor,
    };
}

const CORE_SOURCE: Record<ProtectedEntry["source"], string> = {
    default: "jig-core protected paths",
    personal: "jig-core protected paths (your jig.json)",
    company: "jig-core protected paths (a company plugin)",
};

/** Names in a folder that start with `prefix`, as absolute paths. */
function withPrefix(files: FileView, folder: string, prefix: string): string[] {
    return files
        .list(folder)
        .filter((name) => name.startsWith(prefix))
        .map((name) => path.posix.join(folder, name));
}

/** A project folder's secret files: `.env` and its variants except the templates, and key and certificate files. */
export function secretFilesIn(files: FileView, folder: string): string[] {
    return files
        .list(folder)
        .filter(
            (name) => !PROJECT_SECRET_TEMPLATES.has(name) && PROJECT_SECRET_NAMES.some((pattern) => pattern.test(name)),
        )
        .map((name) => path.posix.join(folder, name))
        .filter((file) => files.type(file) === "file" || files.type(file) === "link");
}

/** The python user site-packages folders, where a `*.pth` file runs code each time Python starts. */
function pthFolders(files: FileView, home: string, platform: "linux" | "darwin"): string[] {
    const base = platform === "darwin" ? path.posix.join(home, "Library/Python") : path.posix.join(home, ".local/lib");
    const found: string[] = [];
    for (const name of files.list(base)) {
        const candidate =
            platform === "darwin"
                ? path.posix.join(base, name, "lib/python/site-packages")
                : name.startsWith("python")
                  ? path.posix.join(base, name, "site-packages")
                  : undefined;
        if (candidate !== undefined && files.type(candidate) === "directory") found.push(candidate);
    }
    return found;
}

/** The rules for one machine and one working folder. */
export function computeRules(input: RulesInput): RuleSet {
    const { files, home } = input;
    const candidates: Candidate[] = [];
    const add = (kind: RuleKind, absolute: string, group: GroupName, source: string): void => {
        candidates.push({ kind, absolute: path.posix.resolve(absolute), group, source });
    };
    const inHome = (relative: string): string => path.posix.join(home, relative.replace(/^~\//, ""));
    const BUILT_IN = "built in";

    const cwd = files.real(input.cwd) ?? path.posix.resolve(input.cwd);
    const repos = findRepos(files, cwd, home);

    // Hidden: credentials and logins.
    for (const item of HIDDEN_IN_HOME) add("hidden", inHome(item.path), item.group, BUILT_IN);
    if (input.platform === "darwin")
        for (const item of HIDDEN_ON_MAC) add("hidden", inHome(item.path), item.group, BUILT_IN);
    if (input.agentDir !== "") {
        for (const name of HIDDEN_IN_AGENT_DIR) add("hidden", path.posix.join(input.agentDir, name), "agent", BUILT_IN);
    }
    // Hidden and locked: what jig-core keeps from Pi's file tools, company additions included. One list, so the file
    // tools and bash cannot disagree.
    for (const entry of input.protectedPaths) {
        if (entry.kind === "secret") add("hidden", entry.path, "credentials", CORE_SOURCE[entry.source]);
        else add("locked", entry.path, "pi", CORE_SOURCE[entry.source]);
    }
    // Hidden: the doors to other systems.
    if (input.wsl) for (const item of HIDDEN_ON_WSL) add("hidden", item.path, item.group, BUILT_IN);
    if (input.platform === "linux") {
        add("hidden", `/run/user/${input.uid}`, "sockets", BUILT_IN);
        const runtime = input.env.XDG_RUNTIME_DIR;
        if (runtime !== undefined && path.posix.isAbsolute(runtime)) add("hidden", runtime, "sockets", BUILT_IN);
        for (const prefix of ["ssh-", "gpg-"]) {
            for (const found of withPrefix(files, "/tmp", prefix)) add("hidden", found, "sockets", BUILT_IN);
        }
    }
    for (const item of HIDDEN_SOCKETS) add("hidden", item.path, item.group, BUILT_IN);
    // Hidden: the project's own secret files, at the top of the working folder and of each repository.
    const projectFolders = [...new Set([cwd, ...repos.map((repo) => repo.root)])];
    for (const folder of projectFolders) {
        for (const file of secretFilesIn(files, folder)) {
            if (!input.createdByAgent.has(file)) add("hidden", file, "project", "project");
        }
    }
    // Hidden by the user.
    for (const text of input.settings.hide) {
        const absolute = expand(text, home);
        if (absolute !== undefined) add("hidden", absolute, "yours", "your sandbox section (hide)");
    }

    // Locked: what runs later outside the sandbox.
    for (const item of LOCKED_IN_HOME) add("locked", inHome(item.path), item.group, BUILT_IN);
    if (input.platform === "darwin")
        for (const item of LOCKED_ON_MAC) add("locked", inHome(item.path), item.group, BUILT_IN);
    for (const folder of projectFolders) {
        for (const item of LOCKED_IN_PROJECT) add("locked", path.posix.join(folder, item.path), item.group, "project");
    }
    for (const repo of repos) {
        add("locked", path.posix.join(repo.commonDir, "hooks"), "hooks", "project repositories");
        const named = hooksPathOf(files, repo);
        if (named !== undefined) add("locked", named, "hooks", "project repositories (core.hooksPath)");
    }
    // What Pi loads from a project: in the working folder and every folder above it below the home folder.
    for (const folder of ancestors(cwd)) {
        if (folder === "/" || folder === home) break;
        for (const item of LOCKED_PI_IN_PROJECT) add("locked", path.posix.join(folder, item), "pi", "project");
    }
    for (const folder of input.runtimePaths) add("locked", folder, "runtime", "the Node.js and Pi that run Pi");
    for (const folder of pthFolders(files, home, input.platform)) {
        for (const name of files.list(folder)) {
            if (name.endsWith(".pth")) add("locked", path.posix.join(folder, name), "python", BUILT_IN);
        }
    }
    for (const text of input.settings.lock) {
        const absolute = expand(text, home);
        if (absolute !== undefined) add("locked", absolute, "yours-locked", "your sandbox section (lock)");
    }

    // Ask first: the toolchain managers, where they are by default and where their own variable moved them.
    for (const item of ASK_FIRST) add("ask-first", inHome(item.path), item.group, BUILT_IN);
    for (const { variable, sub } of ASK_FIRST_BY_ENV) {
        const value = input.env[variable];
        if (value !== undefined && path.posix.isAbsolute(value)) {
            add(
                "ask-first",
                sub === "" ? value : path.posix.join(value, sub),
                "toolchain",
                `environment (${variable})`,
            );
        }
    }

    // ---- resolving: links followed, only what exists, one rule per place --------------------------------------------

    const byPath = new Map<string, Rule>();
    const missing = new Map<string, Rule>();
    const prefer = (kept: Rule | undefined, next: Rule): Rule => {
        if (kept === undefined) return next;
        const stronger = PRECEDENCE[next.kind] < PRECEDENCE[kept.kind];
        const winner = stronger ? next : kept;
        const loser = stronger ? kept : next;
        // The same place named twice: keep the stronger kind and both sources.
        if (loser.source !== winner.source && !winner.source.split("; ").includes(loser.source)) {
            return { ...winner, source: `${winner.source}; ${loser.source}` };
        }
        return winner;
    };
    for (const candidate of candidates) {
        const real = files.real(candidate.absolute);
        if (real === undefined) {
            if (candidate.kind === "locked" && files.type(candidate.absolute) === undefined) {
                const rule = makeRule(candidate, candidate.absolute, home);
                missing.set(rule.path, prefer(missing.get(rule.path), rule));
            }
            continue;
        }
        const rule = makeRule(candidate, real, home);
        byPath.set(rule.path, prefer(byPath.get(rule.path), rule));
    }

    // The folders of PATH are locked: a program put there runs when the user types its name. Folders of a toolchain
    // manager ask first instead, and folders in the project are the user's own choice of where to run things from.
    const askFirstPaths = [...byPath.values()].filter((rule) => rule.kind === "ask-first").map((rule) => rule.path);
    const writableBase = [home, cwd, ...input.tmp, input.sessionTmp];
    const pathRules: Rule[] = [];
    for (const entry of (input.env.PATH ?? "").split(":")) {
        if (!path.posix.isAbsolute(entry)) continue;
        const candidate: Candidate = {
            kind: "locked",
            absolute: path.posix.resolve(entry),
            group: "path",
            source: "PATH",
        };
        const real = files.real(candidate.absolute);
        if (real === undefined) {
            // A PATH folder that is not there yet: the audit takes out what a command puts there.
            if (inside(candidate.absolute, home) && files.type(candidate.absolute) === undefined) {
                const rule = makeRule(candidate, candidate.absolute, home);
                missing.set(rule.path, prefer(missing.get(rule.path), rule));
            }
            continue;
        }
        if (askFirstPaths.some((folder) => inside(real, folder))) continue;
        if (inside(real, cwd) || !writableBase.some((root) => inside(real, root))) continue;
        pathRules.push(makeRule(candidate, real, home));
    }
    for (const rule of pathRules) byPath.set(rule.path, prefer(byPath.get(rule.path), rule));

    // What the user allowed no longer asks.
    const approved = input.approved.map((folder) => files.real(folder) ?? folder);
    for (const [place, rule] of byPath) {
        if (rule.kind === "ask-first" && approved.some((folder) => folder === place)) byPath.delete(place);
    }

    const problems: string[] = [];

    // ---- what is writable, and what is readable again -----------------------------------------------------------------

    const hiddenRules = [...byPath.values()].filter((rule) => rule.kind === "hidden");
    const writable: Writable[] = [];
    const reopened: Writable[] = [];
    const addWritable = (place: string, source: string): void => {
        const real = files.real(place);
        if (real !== undefined && !writable.some((item) => item.path === real)) {
            writable.push({ path: real, shown: shown(real, home), source });
        }
    };
    addWritable(home, "your home folder");
    addWritable(cwd, "the working folder");
    for (const folder of input.tmp) addWritable(folder, "temporary files");
    addWritable(input.sessionTmp, "this session's temporary folder");

    const reopen = (place: string, why: string): void => {
        if (!reopened.some((item) => item.path === place))
            reopened.push({ path: place, shown: shown(place, home), source: why });
    };
    // `share`: a folder that is writable although a rule hides it. It cannot open a credential, and it cannot unlock a
    // path: those rules are the floor.
    for (const text of input.settings.share) {
        const absolute = expand(text, home);
        const real = absolute === undefined ? undefined : files.real(absolute);
        if (real === undefined) {
            problems.push(`share ${text}: no such folder, so nothing is shared`);
            continue;
        }
        const blocker = [...byPath.values()].find(
            (rule) => rule.floor && rule.kind !== "ask-first" && inside(real, rule.path),
        );
        if (blocker !== undefined) {
            problems.push(
                `share ${text}: ignored, because ${blocker.shown} is ${blocker.kind === "hidden" ? "hidden" : "locked"} (${blocker.reason})`,
            );
            continue;
        }
        addWritable(real, "your sandbox section (share)");
        if (hiddenRules.some((rule) => inside(real, rule.path)))
            reopen(real, "shared, although a rule hides the folder around it");
        // A shared folder inside an ask-first one is the user's answer in advance.
        for (const [place, rule] of byPath) {
            if (rule.kind === "ask-first" && inside(real, place)) byPath.delete(place);
        }
    }
    // The working folder must stay usable even when it lies under a hidden door, such as a Windows drive.
    if (hiddenRules.some((rule) => !rule.floor && inside(cwd, rule.path))) reopen(cwd, "the working folder");
    // `resolv.conf` is a link into `/mnt/wsl` on WSL: without the real file no name resolves.
    const resolver = files.real("/etc/resolv.conf");
    if (resolver !== undefined && hiddenRules.some((rule) => inside(resolver, rule.path))) {
        reopen(resolver, "the resolver configuration, without which no name resolves");
    }

    const order: Record<RuleKind, number> = PRECEDENCE;
    const rules = [...byPath.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.shown.localeCompare(b.shown));
    return {
        rules,
        missing: [...missing.values()]
            .filter((rule) => !byPath.has(rule.path))
            .sort((a, b) => a.shown.localeCompare(b.shown)),
        writable,
        reopened,
        repos,
        pthFolders: pthFolders(files, home, input.platform),
        problems,
        protectedFolders: [input.sessionDir],
        home,
        cwd,
        files,
    };
}

// ---- what the runtime is given ------------------------------------------------------------------------------------------

const literal = (place: string): PathEntry => ({ path: place, literal: true });

/** The file-system part of the runtime's configuration. Every path is literal and absolute, and exists. */
export function runtimeFilesystem(set: RuleSet): RuntimeFilesystem {
    const allowWrite = set.writable.map((item) => item.path);
    const insideWritable = (place: string): boolean => allowWrite.some((root) => inside(place, root));
    const denyWrite = [
        ...set.rules.filter((rule) => rule.kind !== "hidden").map((rule) => rule.path),
        ...set.protectedFolders.flatMap((folder) => set.files.real(folder) ?? []),
    ]
        // A path outside every writable folder is read-only already, and one more mount is one more thing to go wrong.
        .filter(insideWritable);
    return {
        denyRead: set.rules.filter((rule) => rule.kind === "hidden").map((rule) => literal(rule.path)),
        allowRead: set.reopened.map((item) => literal(item.path)),
        allowWrite: allowWrite.map(literal),
        denyWrite: [...new Set(denyWrite)].map(literal),
        allowGitConfig: true,
    };
}

// ---- asking the rules -----------------------------------------------------------------------------------------------------

/** The rule that covers a path, the most specific first: hidden, then locked, then ask-first. */
export function ruleFor(set: RuleSet, place: string): Rule | undefined {
    const resolved = resolveLoose(set.files, place);
    const forms = new Set([path.posix.resolve(place), resolved]);
    let best: Rule | undefined;
    for (const rule of set.rules) {
        const covers = [...forms].some((form) => inside(form, rule.path) || inside(form, rule.named));
        if (!covers) continue;
        if (best === undefined) {
            best = rule;
            continue;
        }
        const closer = rule.path.length > best.path.length;
        if (
            PRECEDENCE[rule.kind] < PRECEDENCE[best.kind] ||
            (PRECEDENCE[rule.kind] === PRECEDENCE[best.kind] && closer)
        )
            best = rule;
    }
    return best;
}

/** Whether a command in the sandbox can write this path, the way the runtime would decide it. */
export function canWritePath(set: RuleSet, place: string): boolean {
    const resolved = resolveLoose(set.files, place);
    const reopenedHere = set.reopened.some((item) => inside(resolved, item.path));
    for (const rule of set.rules) {
        if (rule.kind === "hidden" && inside(resolved, rule.path) && !reopenedHere) return false;
        if (rule.kind !== "hidden" && inside(resolved, rule.path)) return false;
    }
    for (const folder of set.protectedFolders) if (inside(resolved, folder)) return false;
    return set.writable.some((item) => inside(resolved, item.path));
}

/** The writable folders that hold this path, for a message that says where a write may go. */
export function writableRootFor(set: RuleSet, place: string): Writable | undefined {
    const resolved = resolveLoose(set.files, place);
    return set.writable.find((item) => inside(resolved, item.path));
}

/** `shown` of a path, for messages built outside this module. */
export function showPath(set: RuleSet, absolute: string): string {
    return shown(absolute, set.home);
}
