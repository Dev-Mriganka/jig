// What the agent reads about a ticket in messages: the notes after activation and after each compaction, and the
// reminder that rides on a tool result. Messages are appended to the conversation. They never change the system
// prompt, which heads the provider's cache, so a change there would rewrite the whole cached conversation.
import { clipBytes } from "./clip.ts";

/** Notes longer than this many bytes are cut in a message; the agent reads notes.md for the rest. */
export const NOTES_IN_MESSAGE = 16 * 1024;
const CUT = "\n[... cut at 16 KB; read notes.md for the rest]";
/** Tool results without a change to notes.md before the reminder comes with one of them. */
export const REMIND_AFTER = 15;

export interface NotesMessage {
    key: string;
    /** The ticket folder, as the agent should open it. */
    folder: string;
    notes: string;
    /** Why the notes come now, such as "Active." */
    lead: string;
}

/** `[ticket KEY] <lead> Folder: <folder>/ (notes.md, evidence/index.md).`, a blank line, then the notes. */
export function notesMessage(input: NotesMessage): string {
    const head = `[ticket ${input.key}] ${input.lead} Folder: ${input.folder}/ (notes.md, evidence/index.md).`;
    const body = input.notes.trim() === "" ? "(notes.md is empty)" : clipBytes(input.notes, NOTES_IN_MESSAGE, CUT);
    return `${head}\n\n${body}`;
}

export function reminderText(key: string, notesFile: string): string {
    return `[ticket ${key}] ${REMIND_AFTER} tool results since notes.md last changed: update the ## Now block in ${notesFile} (status, next step, open questions).`;
}
