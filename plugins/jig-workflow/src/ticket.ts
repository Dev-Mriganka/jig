// The ticket: which one the session works on, where its folder is, and which repositories are bound to it. The folder and the
// `ticket.json` that lists the repositories are `jig-memory`'s (this plugin reads the same `memory` section of jig.json as
// `jig-review` does); the active ticket is the entry `jig-memory` keeps in the session.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { replaceFile } from "./files.ts";

/** The session entry `jig-memory` writes for the active ticket: `{ key }`, or `{ key: null }` when switched off. */
export const TICKET_ENTRY = "jig-memory-ticket";

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A ticket key is a folder name, so one with a separator, a leading dot or a `..` is refused. */
export function isTicketKey(key: unknown): key is string {
    return typeof key === "string" && KEY.test(key);
}

/** The ticket the session recorded last. Undefined when none, or after `/ticket off`. */
export function activeTicket(entries: readonly SessionEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type?: string; customType?: string; data?: { key?: unknown } } | undefined;
        if (entry?.type === "custom" && entry.customType === TICKET_ENTRY) {
            const key = entry.data?.key;
            return isTicketKey(key) ? key : undefined;
        }
    }
    return undefined;
}

/** The folder ticket folders live in: the `memory` section's `folder`, else the XDG data folder. */
export function ticketsFolder(section: unknown, env: NodeJS.ProcessEnv = process.env): string {
    const folder = (section as { folder?: unknown } | undefined)?.folder;
    if (typeof folder === "string" && folder !== "") {
        return folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
    }
    const data = env.XDG_DATA_HOME;
    const dataHome = data !== undefined && path.isAbsolute(data) ? data : path.join(os.homedir(), ".local", "share");
    return path.join(dataHome, "jig", "tickets");
}

export interface TicketPaths {
    dir: string;
    notes: string;
    plan: string;
    ticket: string;
}

export function ticketPaths(folder: string, key: string): TicketPaths {
    const dir = path.join(folder, key);
    return {
        dir,
        notes: path.join(dir, "notes.md"),
        plan: path.join(dir, "plan.md"),
        ticket: path.join(dir, "ticket.json"),
    };
}

export interface Bound {
    /** Real paths of the repositories that exist and are git work trees. */
    roots: string[];
    /** What is wrong with the rest of the file, in words. */
    problems: string[];
}

/**
 * The repositories bound to a ticket: the list in `ticket.json`, each an absolute path or one relative to Pi's folder. A
 * path that is not a git work tree is left out and reported. A file that is missing or empty binds nothing.
 */
export function readBound(paths: TicketPaths, cwd: string): Bound {
    const bound: Bound = { roots: [], problems: [] };
    if (!existsSync(paths.ticket)) return bound;
    let entries: unknown;
    try {
        entries = (JSON.parse(readFileSync(paths.ticket, "utf8")) as { repositories?: unknown }).repositories;
    } catch {
        bound.problems.push(`${paths.ticket} is not valid JSON`);
        return bound;
    }
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string" && entry !== "")) {
        bound.problems.push(`${paths.ticket} needs "repositories": a list of repository paths`);
        return bound;
    }
    for (const entry of entries as string[]) {
        const wanted = path.resolve(cwd, entry);
        try {
            if (!existsSync(path.join(wanted, ".git"))) throw new Error("not a git work tree");
            const real = realpathSync(wanted);
            if (!bound.roots.includes(real)) bound.roots.push(real);
        } catch {
            bound.problems.push(`${entry} is bound to ${path.basename(paths.dir)} and is not a git work tree`);
        }
    }
    return bound;
}

/** Adds a repository to `ticket.json`, keeping the rest of the file. Returns false when it was already there. */
export function addBound(paths: TicketPaths, root: string): boolean {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    let repositories: string[] = [];
    let rest: Record<string, unknown> = {};
    if (existsSync(paths.ticket)) {
        const parsed = JSON.parse(readFileSync(paths.ticket, "utf8")) as Record<string, unknown>;
        rest = parsed;
        if (Array.isArray(parsed.repositories))
            repositories = parsed.repositories.filter((entry): entry is string => typeof entry === "string");
    }
    if (repositories.includes(root)) return false;
    replaceFile(paths.ticket, `${JSON.stringify({ ...rest, repositories: [...repositories, root] }, null, 2)}\n`);
    return true;
}
