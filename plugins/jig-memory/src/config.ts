// The `memory` section of jig.json: where ticket folders live, and what a ticket key looks like. jig-core checks the
// section with validateMemory when it loads, so the rest of the plugin reads a section that is valid, or absent.
import os from "node:os";
import path from "node:path";

export interface MemorySettings {
    /** A regular expression for ticket keys, such as `[A-Z][A-Z0-9]+-\d+`. Unset: only `/ticket KEY` makes a ticket
     *  active, because the plugin cannot know a company's keys. */
    ticketPattern?: string;
    /** Where ticket folders live: an absolute path, or one that starts with `~/`. Unset: the XDG data folder. */
    folder?: string;
}

const FIELDS: ReadonlySet<string> = new Set(["ticketPattern", "folder"]);

/**
 * The errors in a raw `memory` section, each naming its key. An empty list means the section is valid. A misspelt
 * field is an error and not a silent default: `ticketPatern` would otherwise leave every ticket unnamed.
 */
export function validateMemory(raw: unknown): string[] {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["memory: must be an object"];
    const fields = raw as Record<string, unknown>;
    const errors = Object.keys(fields)
        .filter((name) => !FIELDS.has(name))
        .map((name) => `memory.${name}: unknown field`);
    const { ticketPattern, folder } = fields;
    if (ticketPattern !== undefined) {
        if (typeof ticketPattern !== "string" || ticketPattern === "") {
            errors.push("memory.ticketPattern: must be a regular expression, as text");
        } else {
            try {
                new RegExp(ticketPattern);
            } catch (error) {
                errors.push(
                    `memory.ticketPattern: not a regular expression (${error instanceof Error ? error.message : String(error)})`,
                );
            }
        }
    }
    if (folder !== undefined) {
        if (typeof folder !== "string" || folder === "") errors.push("memory.folder: must be a path");
        else if (!path.isAbsolute(folder) && !folder.startsWith("~/"))
            errors.push("memory.folder: use an absolute path, or one that starts with ~/");
    }
    return errors;
}

/** The folder ticket folders live in: the section's `folder` with `~/` expanded, or `$XDG_DATA_HOME/jig/tickets`. */
export function folderOf(settings: MemorySettings | undefined): string {
    const folder = settings?.folder;
    if (folder === undefined) {
        // The XDG rule: an empty or relative XDG_DATA_HOME is not valid, so the default is used instead.
        const home = process.env.XDG_DATA_HOME;
        const dataHome =
            home !== undefined && path.isAbsolute(home) ? home : path.join(os.homedir(), ".local", "share");
        return path.join(dataHome, "jig", "tickets");
    }
    return folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}

/** The regular expression that finds ticket keys in a message, or undefined when no pattern is set. A key must not
 *  touch a letter or digit on either side, so `aACME-1` does not mention `ACME-1`. */
export function ticketRegex(settings: MemorySettings | undefined): RegExp | undefined {
    const pattern = settings?.ticketPattern;
    if (pattern === undefined) return undefined;
    return new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![A-Za-z0-9])`, "g");
}
