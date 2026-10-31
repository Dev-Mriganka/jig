// What a ticket folder holds that a card or a recall query is made from: the notes (with the lines that left `## Now`),
// the saved evidence, and the repositories bound to the ticket. Everything here was written by the agent or by a tool
// and masked before it was saved; nothing is read from anywhere else.
import { readdirSync } from "node:fs";
import path from "node:path";
import type { CardFront } from "./card.ts";
import { extractErrors, extractIdentifiers, extractKeys } from "./extract.ts";
import { notesTemplate } from "./notes.ts";
import { readText, ticketPaths } from "./store.ts";

/** Evidence read for one card, in bytes. A result is at most 8 KB, so this is about 500 of them. */
export const EVIDENCE_SCAN_LIMIT = 4 * 1024 * 1024;

export interface TicketMaterial {
    key: string;
    /** notes.md and the files in history/. */
    notes: string;
    /** The saved results, oldest first, up to EVIDENCE_SCAN_LIMIT bytes. */
    evidence: string;
    /** The folder names of the paths in ticket.json. */
    repositories: string[];
}

/** The names in a folder that end in `ending`, sorted, or none when the folder is not there. */
function listFiles(dir: string, ending: string): string[] {
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith(ending))
            .sort();
    } catch {
        return [];
    }
}

/** The repositories of ticket.json by folder name, each once. Anything that is not a list of paths gives none. */
export function boundRepositories(text: string): string[] {
    try {
        const entries = (JSON.parse(text) as { repositories?: unknown }).repositories;
        if (!Array.isArray(entries)) return [];
        const names = entries
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => path.basename(entry.replace(/[\\/]+$/, "")))
            .filter((name) => name !== "" && name !== "." && name !== "..");
        return [...new Set(names)].slice(0, 20);
    } catch {
        return [];
    }
}

export function readMaterial(folder: string, key: string): TicketMaterial {
    const paths = ticketPaths(folder, key);
    const history = listFiles(paths.history, ".md").map((name) => readText(path.join(paths.history, name)));
    let budget = EVIDENCE_SCAN_LIMIT;
    const evidence: string[] = [];
    for (const name of listFiles(paths.evidence, ".txt")) {
        if (budget <= 0) break;
        const text = readText(path.join(paths.evidence, name));
        evidence.push(text);
        budget -= Buffer.byteLength(text);
    }
    return {
        key,
        notes: [readText(paths.notes), ...history].join("\n"),
        evidence: evidence.join("\n"),
        repositories: boundRepositories(readText(paths.ticket)),
    };
}

/** Whether there is anything to put on a card: notes that differ from the template, or saved evidence. */
export function hasContent(material: TicketMaterial): boolean {
    const bare = notesTemplate(material.key).trim();
    return material.notes.replace(/\r\n/g, "\n").trim() !== bare || material.evidence.trim() !== "";
}

/** Whether the ticket has no notes yet: no `notes.md`, or the one the template made. */
export function hasNoNotes(folder: string, key: string): boolean {
    const notes = readText(ticketPaths(folder, key).notes);
    return notes.trim() === "" || notes.replace(/\r\n/g, "\n").trim() === notesTemplate(key).trim();
}

/** The front matter of a card for this ticket, from its material alone. */
export function frontOf(material: TicketMaterial, pattern: RegExp | undefined, now: Date): CardFront {
    return {
        ticket: material.key,
        closedAt: now.toISOString(),
        repositories: material.repositories,
        keys: extractKeys([material.notes, material.evidence], pattern, material.key),
        identifiers: extractIdentifiers(material.notes, material.evidence),
        errors: extractErrors(material.evidence),
    };
}
