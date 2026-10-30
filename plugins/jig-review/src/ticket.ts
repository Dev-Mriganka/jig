// Which repositories belong to a ticket: the ones jig-memory bound to it, in `<ticket folder>/<KEY>/ticket.json`. This
// plugin only reads that file. Where the ticket folders are comes from the `memory` section of jig.json, as in jig-memory.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { jig } from "../../jig-core/src/client.ts";
import type { Repository } from "./workspace.ts";

/** What a ticket key looks like when the `memory` section sets no `ticketPattern`: letters, a dash, digits. */
const DEFAULT_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The session entry jig-memory writes for the active ticket: `{ key }`, or `{ key: null }` when switched off. */
export const TICKET_ENTRY = "jig-memory-ticket";

type MemorySection = { ticketPattern?: unknown; folder?: unknown };

function memorySection(): MemorySection {
    try {
        const section = jig().config.section("memory");
        return typeof section === "object" && section !== null ? (section as MemorySection) : {};
    } catch {
        return {};
    }
}

/** Whether `text` is a ticket key: the `memory` section's `ticketPattern` when set, else a generic `ABC-123`. */
export function isTicketKey(text: string): boolean {
    const pattern = memorySection().ticketPattern;
    if (typeof pattern === "string" && pattern !== "") {
        try {
            return new RegExp(`^(?:${pattern})$`).test(text);
        } catch {
            // jig-core reports a bad pattern; fall back to the generic key
        }
    }
    return DEFAULT_KEY.test(text);
}

/** The folder ticket folders live in, by the same rule as jig-memory: the section's `folder`, or the XDG data folder. */
export function ticketFolder(env: NodeJS.ProcessEnv = process.env): string {
    const folder = memorySection().folder;
    if (typeof folder === "string" && folder !== "")
        return folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
    const home = env.XDG_DATA_HOME;
    const dataHome = home !== undefined && path.isAbsolute(home) ? home : path.join(os.homedir(), ".local", "share");
    return path.join(dataHome, "jig", "tickets");
}

/** `<ticket folder>/<KEY>/ticket.json`. A key is a folder name, so one with a separator is refused. */
export function bindingPath(ticket: string, env: NodeJS.ProcessEnv = process.env): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ticket)) throw new Error(`${ticket} is not a ticket key.`);
    return path.join(ticketFolder(env), ticket, "ticket.json");
}

const NEEDS_MEMORY = (ticket: string): string =>
    `Ticket scope needs jig-memory with bound repositories: ${ticket} has none (jig-memory keeps them in its ticket.json).`;

/**
 * The repositories bound to a ticket. Paths are absolute, or relative to Pi's folder, and each must be a git
 * repository. A repository inside Pi's folder shows in the review under its path from there; one outside it shows under
 * its own folder name, so the diff's paths never leave the review. Throws a one-line reason when nothing is bound.
 */
export function readBinding(ticket: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Repository[] {
    const file = bindingPath(ticket, env);
    if (!existsSync(file)) throw new Error(NEEDS_MEMORY(ticket));
    let entries: unknown;
    try {
        entries = (JSON.parse(readFileSync(file, "utf8")) as { repositories?: unknown }).repositories;
    } catch {
        throw new Error(`The binding for ${ticket} (${file}) is not valid JSON.`);
    }
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new Error(`The binding for ${ticket} (${file}) needs "repositories": a list of repository paths.`);
    }
    if (entries.length === 0) throw new Error(NEEDS_MEMORY(ticket));
    const used = new Set<string>();
    return (entries as string[]).map((entry) => {
        const root = path.resolve(cwd, entry);
        if (!existsSync(path.join(root, ".git")))
            throw new Error(`The binding for ${ticket} names ${entry}, which is not a git repository.`);
        const relative = path.relative(cwd, root);
        const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
        // "" is Pi's own folder, which is then the repository: its paths need no prefix.
        let prefix = inside ? relative.split(path.sep).join("/") : path.basename(root);
        // Two repositories outside Pi's folder can share a name; the second then shows under its whole path.
        if (used.has(prefix)) prefix = root.split(path.sep).join("/").replace(/^\/+/, "");
        used.add(prefix);
        return { root, prefix };
    });
}
