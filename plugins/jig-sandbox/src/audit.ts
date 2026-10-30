// The audit after each command: what the runtime cannot prevent, undone and reported.
//
// The runtime mounts a rule only for a path that exists, so a command can still create what a rule would have protected, in
// places that were not there when it started. The audit compares the machine with a snapshot taken just before:
//   - a locked path that was absent and now exists is taken away (a missing ~/.zshrc, a Gradle init.d folder, a PATH folder);
//   - a locked path that was a link and is another thing now is put back (the runtime mounts what a link points at, so
//     the link itself can be removed and made again; a file or folder it mounts cannot be moved, even through its parent);
//   - a new hook in any watched repository's .git/hooks, other than the *.sample files, is taken away. A repository made by
//     `git init` in the command had no rule at all, and is covered here;
//   - a new setting in a watched repository's git configuration that runs a program is taken out, and the rest of the
//     change stays;
//   - a new *.pth file where Python reads them at start-up is taken away.
// Nothing is deleted: what is taken away is moved to a folder in the agent folder, which the sandbox cannot write, so
// that a file the user did create at the same moment is not lost.
import {
    cpSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { newDangerous, parseGitConfig, removeEntries, fullName } from "./gitconfig.ts";
import type { ConfigEntry } from "./gitconfig.ts";
import { nodeFiles } from "./files.ts";
import { shown } from "./pathing.ts";
import { findRepos } from "./repos.ts";
import { secretFilesIn } from "./rules.ts";
import type { Rule, RuleSet } from "./rules.ts";

export interface AuditSnapshot {
    /** Locked paths that were absent: if one exists after, the command made it. */
    absent: Rule[];
    /** Locked paths that were links, with where they pointed. */
    links: Array<{ rule: Rule; at: string; target: string }>;
    /** Hook files by hooks folder, without the samples. */
    hooks: Map<string, Set<string>>;
    /** Git configuration files by path: their text, or undefined when there was none. */
    configs: Map<string, string | undefined>;
    /** `.pth` files by folder. */
    pth: Map<string, Set<string>>;
    /** The secret-named files of the watched folders. */
    secrets: Set<string>;
    cwd: string;
}

export interface AuditResult {
    /** One line each for the agent. */
    lines: string[];
    /** What the user is told, with where the removed thing was kept. */
    notices: string[];
    /** Secret files the command made: they are its own, not hidden. */
    createdSecrets: string[];
}

export interface AuditContext {
    /** Where removed things are kept. */
    quarantine: string;
    /** The home folder and every folder between it and the root are never removed. */
    home: string;
    now: () => number;
}

const linkTarget = (place: string): string | undefined => {
    try {
        return lstatSync(place).isSymbolicLink() ? readlinkSync(place) : undefined;
    } catch {
        return undefined;
    }
};

const isHookFile = (name: string): boolean => !name.endsWith(".sample");

function listNames(folder: string, keep: (name: string) => boolean): Set<string> {
    try {
        return new Set(readdirSync(folder).filter(keep));
    } catch {
        return new Set();
    }
}

function readText(file: string): string | undefined {
    try {
        if (statSync(file).size > 1024 * 1024) return undefined;
        return readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

/** The state of the watched places, just before a command. */
export function takeSnapshot(set: RuleSet): AuditSnapshot {
    const links: AuditSnapshot["links"] = [];
    for (const rule of set.rules) {
        if (rule.kind !== "locked") continue;
        // The place as the rule named it: a link there is mounted by what it points at, so the link itself is not protected.
        const target = linkTarget(rule.named);
        if (target !== undefined) links.push({ rule, at: rule.named, target });
    }
    const hooks = new Map<string, Set<string>>();
    const configs = new Map<string, string | undefined>();
    for (const repo of set.repos) {
        const folder = path.posix.join(repo.commonDir, "hooks");
        hooks.set(folder, listNames(folder, isHookFile));
        for (const config of repo.configs) configs.set(config, readText(config));
    }
    const pth = new Map<string, Set<string>>();
    for (const folder of set.pthFolders)
        pth.set(
            folder,
            listNames(folder, (name) => name.endsWith(".pth")),
        );
    const secrets = new Set<string>();
    for (const folder of new Set([set.cwd, ...set.repos.map((repo) => repo.root)])) {
        for (const file of secretFilesIn(nodeFiles, folder)) secrets.add(file);
    }
    return { absent: set.missing, links, hooks, configs, pth, secrets, cwd: set.cwd };
}

/** Moves something out of the way into the quarantine folder. Returns where it went, or undefined when it was removed. */
function takeAway(place: string, context: AuditContext): string | undefined {
    const stamp = new Date(context.now()).toISOString().replace(/[:.]/g, "-");
    const target = path.join(context.quarantine, `${stamp}-${path.basename(place)}`);
    try {
        mkdirSync(context.quarantine, { recursive: true, mode: 0o700 });
        try {
            renameSync(place, target);
        } catch {
            // Another file system: copy what is there, then remove it.
            cpSync(place, target, { recursive: true, verbatimSymlinks: true });
            rmSync(place, { recursive: true, force: true });
        }
        return target;
    } catch {
        // If it cannot be kept it is still taken away: what was planted must not stay.
        try {
            rmSync(place, { recursive: true, force: true });
        } catch {
            // The report says what is left.
        }
        return undefined;
    }
}

/** A path that must never be removed whatever a rule says. */
function isProtectedPlace(place: string, context: AuditContext): boolean {
    const home = context.home;
    return place === "/" || place === home || home.startsWith(`${place}/`) || path.posix.dirname(place) === "/";
}

/** Compares the machine with the snapshot, undoes what a command planted, and says what it did. */
export function audit(snapshot: AuditSnapshot, set: RuleSet, context: AuditContext): AuditResult {
    const lines: string[] = [];
    const notices: string[] = [];
    const say = (agent: string, user: string, kept: string | undefined): void => {
        lines.push(`[sandbox] ${agent}`);
        notices.push(`jig-sandbox: ${user}${kept === undefined ? "" : ` A copy is in ${shown(kept, context.home)}.`}`);
    };
    const there = (place: string): boolean => {
        try {
            lstatSync(place);
            return true;
        } catch {
            return false;
        }
    };

    // A locked path that did not exist and does now.
    for (const rule of snapshot.absent) {
        if (!there(rule.path) || isProtectedPlace(rule.path, context)) continue;
        const kept = takeAway(rule.path, context);
        say(
            `removed ${rule.shown}: the command created it, and ${rule.reason}.`,
            `removed ${rule.shown}, which a command created and ${rule.reason}.`,
            kept,
        );
    }

    // A locked link that is another thing than before is put back as it was: the original is known.
    for (const item of snapshot.links) {
        if (linkTarget(item.at) === item.target || isProtectedPlace(item.at, context)) continue;
        const name = shown(item.at, context.home);
        const kept = there(item.at) ? takeAway(item.at, context) : undefined;
        try {
            symlinkSync(item.target, item.at);
            say(
                `put ${name} back as the link it was: the command replaced it, and ${item.rule.reason}.`,
                `put ${name} back as the link it was, after a command replaced it.`,
                kept,
            );
        } catch {
            say(
                `${name} was replaced by the command and could not be put back.`,
                `${name} was replaced by a command and could not be put back. Check it.`,
                kept,
            );
        }
    }

    // The watched repositories now, which include one the command made.
    const repos = findRepos(set.files, set.cwd, context.home);
    for (const repo of repos) {
        const hooks = path.posix.join(repo.commonDir, "hooks");
        const before = snapshot.hooks.get(hooks) ?? new Set<string>();
        for (const name of listNames(hooks, isHookFile)) {
            if (before.has(name)) continue;
            const place = path.posix.join(hooks, name);
            const kept = takeAway(place, context);
            say(
                `removed ${shown(place, context.home)}: the command created a git hook, and git runs hooks outside the sandbox.`,
                `removed the git hook ${shown(place, context.home)}, which a command created.`,
                kept,
            );
        }
        for (const config of repo.configs) {
            const text = readText(config);
            if (text === undefined) continue;
            const was = snapshot.configs.get(config);
            const added = newDangerous(was === undefined ? [] : parseGitConfig(was), parseGitConfig(text));
            if (added.length === 0) continue;
            try {
                writeFileSync(config, removeEntries(text, added));
            } catch {
                say(
                    `${shown(config, context.home)} has a setting that runs a program (${names(added)}) and could not be cleaned. Check it.`,
                    `${shown(config, context.home)} has a setting that runs a program (${names(added)}) and could not be cleaned. Check it.`,
                    undefined,
                );
                continue;
            }
            say(
                `removed ${names(added)} from ${shown(config, context.home)}: git would run it outside the sandbox. The rest of your change stays.`,
                `removed ${names(added)} from ${shown(config, context.home)}, which a command added and git would run outside the sandbox.`,
                undefined,
            );
        }
    }

    // A new .pth file, which Python runs at every start.
    for (const [folder, before] of snapshot.pth) {
        for (const name of listNames(folder, (item) => item.endsWith(".pth"))) {
            if (before.has(name)) continue;
            const place = path.posix.join(folder, name);
            const kept = takeAway(place, context);
            say(
                `removed ${shown(place, context.home)}: the command created it, and Python runs .pth files at every start.`,
                `removed ${shown(place, context.home)}, which a command created and Python runs at every start.`,
                kept,
            );
        }
    }

    // Secret files the command made are its own.
    const createdSecrets: string[] = [];
    for (const folder of new Set([set.cwd, ...repos.map((repo) => repo.root)])) {
        for (const file of secretFilesIn(nodeFiles, folder)) if (!snapshot.secrets.has(file)) createdSecrets.push(file);
    }
    return { lines, notices, createdSecrets };
}

function names(entries: readonly ConfigEntry[]): string {
    return [...new Set(entries.map((entry) => fullName(entry)))].join(", ");
}
