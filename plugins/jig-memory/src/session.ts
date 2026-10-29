// The active ticket, and what the agent is told about it. A ticket becomes active for the session when a user message
// names its key (with a ticketPattern set), or when /ticket KEY sets it. jig-core hears about every change, so its
// records carry the ticket.
//
// The active ticket is saved with appendEntry and read back from the branch on session_start. The notes reach the
// agent as messages, when a ticket becomes active and after each compaction, which may have folded the earlier
// message away. They never go into the system prompt: a changed prompt rewrites the provider's cached prefix.
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import { folderOf, ticketRegex } from "./config.ts";
import type { MemorySettings } from "./config.ts";
import { indexCount, isFileTool, saveEvidence } from "./evidence.ts";
import { notesMessage, REMIND_AFTER, reminderText } from "./message.ts";
import { ensureTicket, isSafeKey, mentionedTickets, settleNotes, ticketPaths } from "./store.ts";

/** The session entry that records the active ticket: `{ key }`, or `{ key: null }` after `/ticket off`. */
export const TICKET_ENTRY = "jig-memory-ticket";
/** The custom message that carries the notes into the conversation. */
export const NOTES_MESSAGE = "jig-memory-notes";

const ACTIVE = "Active.";
const COMPACTED = "Still active after compaction; current notes follow.";
const NO_TICKET = "No active ticket. Run /ticket KEY, or name a ticket in your message.";

interface Memory {
    folder: string;
    pattern: RegExp | undefined;
}

/** The ticket the branch recorded last. Undefined when none was, or when the last record is `/ticket off`. */
export function restoredTicket(branch: readonly SessionEntry[]): string | undefined {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry?.type !== "custom" || entry.customType !== TICKET_ENTRY) continue;
        const key = (entry.data as { key?: unknown } | undefined)?.key;
        return typeof key === "string" && isSafeKey(key) ? key : undefined;
    }
    return undefined;
}

export function registerTicketMemory(pi: ExtensionAPI): void {
    // Set at session start, from the section jig-core loaded. Until then nothing is written, so no ticket folder can
    // be made in the working directory by mistake.
    let memory: Memory | undefined;
    let active: string | undefined;
    // notes.md as this session last saw it. A difference at the next look is an edit by the agent or by the user.
    let notesSeen = "";
    // Tool results since notes.md last changed.
    let sinceNotes = 0;
    // Hints already shown while another ticket is active, so naming it in every message says so once.
    const reported = new Set<string>();

    const note = (ctx: ExtensionContext, text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
    };
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

    /** The notes as a message: appended at once when idle, or after the current turn while the agent streams. */
    const sendNotes = (mem: Memory, key: string, lead: string, notes: string) => {
        pi.sendMessage(
            {
                customType: NOTES_MESSAGE,
                content: notesMessage({ key, folder: ticketPaths(mem.folder, key).dir, notes, lead }),
                display: true,
                details: { key },
            },
            { triggerTurn: false },
        );
    };

    /** Makes `key` the active ticket. A failure is reported, not thrown: the prompt goes on without a ticket. */
    const activate = (mem: Memory, ctx: ExtensionContext, key: string, why: string) => {
        try {
            ensureTicket(mem.folder, key);
            const notes = settleNotes(mem.folder, key, new Date());
            jig().setTicket(key);
            active = key;
            notesSeen = notes;
            sinceNotes = 0;
            reported.clear();
            pi.appendEntry(TICKET_ENTRY, { key });
            sendNotes(mem, key, ACTIVE, notes);
            note(ctx, `Ticket ${key} active (${why}). Folder: ${ticketPaths(mem.folder, key).dir}/`);
        } catch (error) {
            note(ctx, `Could not make ${key} active: ${reason(error)}`, "warning");
        }
    };

    const deactivate = (ctx: ExtensionContext) => {
        if (active === undefined) {
            note(ctx, NO_TICKET);
            return;
        }
        jig().setTicket(undefined);
        active = undefined;
        reported.clear();
        pi.appendEntry(TICKET_ENTRY, { key: null });
        note(ctx, "No active ticket.");
    };

    pi.on("session_start", (_event, ctx) => {
        const settings = jig().config.section("memory") as MemorySettings | undefined;
        const mem: Memory = { folder: folderOf(settings), pattern: ticketRegex(settings) };
        memory = mem;
        active = restoredTicket(ctx.sessionManager.getBranch());
        notesSeen = "";
        sinceNotes = 0;
        reported.clear();
        if (active !== undefined) {
            // Only a restored ticket is told: jig-core starts without one, and another extension may have set its own.
            jig().setTicket(active);
            ensureTicket(mem.folder, active);
            notesSeen = settleNotes(mem.folder, active, new Date());
            note(ctx, `Ticket ${active} restored from this session.`);
        }
    });

    pi.on("session_compact", () => {
        const key = active;
        if (memory === undefined || key === undefined) return;
        // The compaction may have folded the activation message away, and the notes may have changed since it.
        notesSeen = settleNotes(memory.folder, key, new Date());
        sendNotes(memory, key, COMPACTED, notesSeen);
    });

    pi.on("input", (event, ctx) => {
        const mem = memory;
        // Text an extension sends is not the user's words, so it never makes a ticket active.
        if (mem?.pattern === undefined || event.source === "extension") return;
        const keys = mentionedTickets(event.text, mem.pattern);
        if (keys.length === 0) return;
        if (active !== undefined) {
            // Naming another ticket does not switch: /ticket KEY does. Each hint is shown once.
            if (keys.includes(active)) return;
            const hint = `${keys.join(", ")} mentioned; /ticket ${keys.length === 1 ? keys[0] : "<KEY>"} switches`;
            if (!reported.has(hint)) {
                reported.add(hint);
                note(ctx, hint);
            }
            return;
        }
        const [first] = keys;
        if (keys.length > 1) {
            note(ctx, `Several tickets named (${keys.join(", ")}): run /ticket <KEY> to choose one.`);
            return;
        }
        if (first !== undefined) activate(mem, ctx, first, "named in your message");
    });

    // While a ticket is active, every result is checked against notes.md, and the results of tools other than Pi's file
    // tools are kept as evidence. The fifteenth result without a notes change carries the reminder.
    pi.on("tool_result", (event, ctx) => {
        const mem = memory;
        const key = active;
        if (mem === undefined || key === undefined) return;
        try {
            const notes = settleNotes(mem.folder, key, new Date());
            // A change to notes.md restarts the count, and the result that made the change does not count itself.
            sinceNotes = notes === notesSeen ? sinceNotes + 1 : 0;
            notesSeen = notes;
            if (!isFileTool(event.toolName)) {
                saveEvidence(mem.folder, key, {
                    tool: event.toolName,
                    input: event.input,
                    text: event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
                });
            }
        } catch (error) {
            note(ctx, `Could not save evidence for ${key}: ${reason(error)}`, "warning");
            return;
        }
        if (sinceNotes < REMIND_AFTER) return;
        sinceNotes = 0;
        return {
            content: [...event.content, { type: "text" as const, text: reminderText(key, ticketPaths(mem.folder, key).notes) }],
            // Replacing content drops structuredContent unless it is returned too, so it goes back as it came.
            ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        };
    });

    pi.registerCommand("ticket", {
        description: "Ticket memory: /ticket KEY makes a ticket active, /ticket off clears it, /ticket alone shows it",
        handler: async (args, ctx) => {
            const mem = memory;
            if (mem === undefined) {
                note(ctx, "Ticket memory is not ready: no session has started.", "warning");
                return;
            }
            const arg = args.trim();
            if (arg === "") {
                if (active === undefined) {
                    note(ctx, NO_TICKET);
                    return;
                }
                const saved = indexCount(mem.folder, active);
                note(ctx, `Ticket ${active}: notes ${ticketPaths(mem.folder, active).notes}, ${saved} saved result${saved === 1 ? "" : "s"}.`);
                return;
            }
            if (arg === "off") {
                deactivate(ctx);
                return;
            }
            if (!isSafeKey(arg)) {
                note(ctx, "Use /ticket KEY, /ticket off, or /ticket alone to show the active ticket.", "warning");
                return;
            }
            if (arg === active) {
                note(ctx, `Ticket ${arg} is already active.`);
                return;
            }
            activate(mem, ctx, arg, "chosen with /ticket");
        },
    });
}
