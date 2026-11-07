// The active ticket, and what the agent is told about it. A ticket becomes active for the session when a user message
// names its key (with a ticketPattern set), or when /ticket KEY sets it. jig-core hears about every change, so its
// records carry the ticket.
//
// The active ticket is saved with appendEntry and read back from the branch on session_start. The notes reach the
// agent as messages, when a ticket becomes active and after each compaction, which may have folded the earlier
// message away. They never go into the system prompt: a changed prompt rewrites the provider's cached prefix.
//
// More is wired here and done elsewhere. /ticket close drafts a card and asks the agent to fill it (close.ts), and when the
// agent has settled the file is read back. A ticket that becomes active with no notes yet gets recall, the cards of related
// tickets (recall.ts), as one more message. A ticket that becomes active or is restored is searched for empty files that a
// crash may have left (empty-files.ts). The `ticket` tool (tool.ts) keeps pasted evidence and open checks (checks.ts), and
// every prompt while a check is open carries the list.
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import { registerJigTool } from "../../jig-core/src/kit/tools.ts";
import {
    CARD_FIX,
    CARD_REQUEST,
    type Closing,
    correctionText,
    draftClose,
    NothingToClose,
    requestText,
    verifyCard,
} from "./close.ts";
import { loadCards } from "./cards.ts";
import { loadNoteIndex } from "./notes-index.ts";
import { CheckError, openChecks, openChecksText } from "./checks.ts";
import { folderOf, recallOf, ticketRegex } from "./config.ts";
import type { MemorySettings, RecallSettings } from "./config.ts";
import { emptyFilesText, findEmptyFiles } from "./empty-files.ts";
import { indexCount, isFileTool, saveEvidence } from "./evidence.ts";
import { hasNoNotes, readMaterial } from "./material.ts";
import { notesMessage, REMIND_AFTER, reminderText } from "./message.ts";
import { localDate, nowBlock } from "./notes.ts";
import { buildQuery, formatRecall, notesText, recall, recallMessage } from "./recall.ts";
import { ensureTicket, isSafeKey, mentionedTickets, settleNotes, ticketPaths } from "./store.ts";
import { finishPasted, TOOL_NAME, ticketTool } from "./tool.ts";

/** The session entry that records the active ticket: `{ key }`, or `{ key: null }` after `/ticket off`. */
export const TICKET_ENTRY = "jig-memory-ticket";
/** The custom message that carries the notes into the conversation. */
export const NOTES_MESSAGE = "jig-memory-notes";
/** The custom message that carries the cards of related tickets. */
export const RECALL_MESSAGE = "jig-memory-recall";
/** The custom message that names empty files in the ticket folder. */
export const EMPTY_FILES_MESSAGE = "jig-memory-empty-files";
/** The custom message that lists the open checks, with every prompt while one is open. */
export const CHECKS_MESSAGE = "jig-memory-checks";

const ACTIVE = "Active.";
const COMPACTED = "Still active after compaction; current notes follow.";
const NO_TICKET = "No active ticket. Run /ticket KEY, or name a ticket in your message.";
const USAGE = "Use /ticket KEY, /ticket off, or /ticket alone to show the active ticket.";
// The words after /ticket that are commands. A ticket key with one of these names cannot be set with /ticket.
const COMMANDS: ReadonlySet<string> = new Set(["off", "close", "recall"]);

interface Memory {
    folder: string;
    pattern: RegExp | undefined;
    recall: Required<RecallSettings>;
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
    // The ## Now block of notes.md as this session last saw it. A difference at the next look is an edit by the agent or by
    // the user. An edit elsewhere in notes.md does not count: the reminder is about ## Now.
    let nowSeen = "";
    // Tool results since ## Now last changed.
    let sinceNotes = 0;
    // Hints already shown while another ticket is active, so naming it in every message says so once.
    const reported = new Set<string>();
    // A close that has asked the agent to fill the card and waits for it to settle.
    let closing: Closing | undefined;
    // Tickets that recall has run for in this session, so a ticket switched away from and back is not recalled twice, and
    // the message that made each active, which a recall by hand on the active ticket reads again.
    const recalled = new Set<string>();
    const activatedBy = new Map<string, string>();

    const note = (ctx: ExtensionContext, text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
    };
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

    /** The open checks, worded for the agent, or undefined when none is open or checks.json cannot be read (said once). */
    const checksText = (mem: Memory, ctx: ExtensionContext, key: string): string | undefined => {
        try {
            return openChecksText(key, openChecks(mem.folder, key));
        } catch (error) {
            const text = `Open checks of ${key} cannot be read: ${reason(error)}`;
            if (!reported.has(text)) {
                reported.add(text);
                note(ctx, text, "warning");
            }
            return error instanceof CheckError ? `[ticket ${key}] ${text}` : undefined;
        }
    };

    /** The notes as a message: appended at once when idle, or after the current turn while the agent streams. */
    const sendNotes = (mem: Memory, ctx: ExtensionContext, key: string, lead: string, notes: string) => {
        const content = notesMessage({
            key,
            folder: ticketPaths(mem.folder, key).dir,
            notes,
            lead,
            today: localDate(new Date()),
            checks: checksText(mem, ctx, key),
        });
        pi.sendMessage({ customType: NOTES_MESSAGE, content, display: true, details: { key } }, { triggerTurn: false });
    };

    /** Empty files in the ticket folder, which a crash or an unfinished write may have left: the agent and the user are told.
     *  Nothing is repaired. */
    const warnEmptyFiles = (mem: Memory, ctx: ExtensionContext, key: string) => {
        try {
            const now = new Date();
            const found = findEmptyFiles(ticketPaths(mem.folder, key).dir, now);
            const text = emptyFilesText(key, found, now);
            if (text === undefined) return;
            pi.sendMessage(
                {
                    customType: EMPTY_FILES_MESSAGE,
                    content: text,
                    display: false,
                    details: { key, files: found.shown.map((entry) => entry.file), total: found.total },
                },
                { triggerTurn: false },
            );
            note(ctx, text, "warning");
        } catch (error) {
            note(ctx, `Could not look for empty files in ${key}: ${reason(error)}`, "warning");
        }
    };

    /** Recall for a ticket that just became active: the cards of related tickets, as one message when any pass. */
    const sendRecall = (mem: Memory, ctx: ExtensionContext, key: string, text: string) => {
        try {
            const matches = recall(
                loadCards(mem.folder),
                buildQuery({ ticket: key, text, pattern: mem.pattern }),
                {
                    ...mem.recall,
                    // The automatic path is deliberately capped at one derived entry even when a person set a larger
                    // maxNotes; that setting is for the manual search.
                    maxNotes: Math.min(mem.recall.maxNotes, 1),
                    allowRareWords: false,
                },
                mem.recall.maxNotes === 0 ? undefined : loadNoteIndex(mem.folder, mem.pattern),
            );
            if (matches.length === 0) return;
            pi.sendMessage(
                {
                    customType: RECALL_MESSAGE,
                    content: recallMessage(key, mem.folder, matches),
                    display: true,
                    details: { key, tickets: matches.map((match) => match.ticket) },
                },
                { triggerTurn: false },
            );
            // Countable by jig-lens without any text: tool memory, action recall, facts.entries.
            jig().records?.recall({
                tool: "memory",
                action: "recall",
                plugin: "jig-memory",
                ticket: key,
                entries: matches.length,
                queries: 1,
            });
        } catch (error) {
            note(ctx, `Recall for ${key} failed: ${reason(error)}`, "warning");
        }
    };

    /**
     * Makes `key` the active ticket. A failure is reported, not thrown: the prompt goes on without a ticket. `text` is the
     * message that named it, which recall reads when the ticket has no notes yet.
     */
    const activate = (mem: Memory, ctx: ExtensionContext, key: string, why: string, text = "") => {
        try {
            const isNew = hasNoNotes(mem.folder, key);
            ensureTicket(mem.folder, key);
            const notes = settleNotes(mem.folder, key, new Date());
            jig().setTicket(key);
            active = key;
            nowSeen = nowBlock(notes);
            sinceNotes = 0;
            reported.clear();
            pi.appendEntry(TICKET_ENTRY, { key });
            activatedBy.set(key, text);
            sendNotes(mem, ctx, key, ACTIVE, notes);
            warnEmptyFiles(mem, ctx, key);
            if (isNew && mem.recall.enabled && !recalled.has(key)) {
                recalled.add(key);
                sendRecall(mem, ctx, key, text);
            }
            note(ctx, `Ticket ${key} active (${why}). Folder: ${ticketPaths(mem.folder, key).dir}/`);
        } catch (error) {
            note(ctx, `Could not make ${key} active: ${reason(error)}`, "warning");
        }
    };

    const deactivate = (ctx: ExtensionContext, message = "No active ticket.") => {
        if (active === undefined) {
            note(ctx, NO_TICKET);
            return;
        }
        jig().setTicket(undefined);
        active = undefined;
        reported.clear();
        pi.appendEntry(TICKET_ENTRY, { key: null });
        note(ctx, message);
    };

    /** `/ticket recall [text]`: the related tickets for the text, or for the active ticket, shown to the user only. */
    const recallByHand = (mem: Memory, ctx: ExtensionContext, text: string) => {
        if (!mem.recall.enabled) {
            note(ctx, "Recall is off (memory.recall.enabled false).");
            return;
        }
        try {
            let query = buildQuery({
                ...(active === undefined ? {} : { ticket: active }),
                text,
                pattern: mem.pattern,
            });
            if (text === "") {
                if (active === undefined) {
                    note(ctx, "No active ticket. Use /ticket recall <text>, or make a ticket active first.");
                    return;
                }
                const material = readMaterial(mem.folder, active);
                query = buildQuery({
                    ticket: active,
                    text: `${activatedBy.get(active) ?? ""}\n${notesText(material.notes)}`,
                    evidence: material.evidence,
                    pattern: mem.pattern,
                });
            }
            const cards = loadCards(mem.folder);
            const notes = loadNoteIndex(mem.folder, mem.pattern);
            const cardCount = Object.values(cards).filter((card) => card.valid).length;
            const noteCount =
                notes === undefined ? 0 : Object.keys(notes).filter((ticket) => cards[ticket]?.valid !== true).length;
            const searched = cardCount + noteCount;
            if (searched === 0) {
                note(ctx, "No earlier tickets yet: a ticket is searchable once its notes.md or card.md exists.");
                return;
            }
            const matches = recall(
                cards,
                query,
                {
                    ...mem.recall,
                    maxNotes: Math.max(mem.recall.maxNotes, 1),
                    allowRareWords: true,
                    cardsFirst: true,
                },
                notes,
            );
            note(
                ctx,
                matches.length === 0
                    ? `No earlier ticket scores ${mem.recall.minScore} or more among ${searched} entr${searched === 1 ? "y" : "ies"}.`
                    : formatRecall(
                          `Related earlier tickets (${searched} entr${searched === 1 ? "y" : "ies"} searched):`,
                          matches,
                      ),
            );
        } catch (error) {
            note(ctx, `Recall failed: ${reason(error)}`, "warning");
        }
    };

    /** Drafts the card of `key` and asks the agent to fill it. The check comes when the agent has settled. */
    const startClose = (mem: Memory, ctx: ExtensionContext, key: string) => {
        if (!existsSync(ticketPaths(mem.folder, key).dir)) {
            note(ctx, `No folder for ${key} in ${mem.folder}: run /ticket ${key} first.`, "warning");
            return;
        }
        try {
            closing = draftClose(mem.folder, key, mem.pattern, new Date());
        } catch (error) {
            note(
                ctx,
                error instanceof NothingToClose
                    ? error.message
                    : `Could not draft the card for ${key}: ${reason(error)}`,
                "warning",
            );
            return;
        }
        // A follow-up waits for a run that is going, and an idle agent starts at once.
        pi.sendMessage(
            { customType: CARD_REQUEST, content: requestText(mem.folder, key), display: true, details: { key } },
            { triggerTurn: true, deliverAs: "followUp" },
        );
        note(ctx, `Card for ${key} drafted in ${ticketPaths(mem.folder, key).card}; the agent is asked to fill it.`);
    };

    pi.on("session_start", (_event, ctx) => {
        const settings = jig().config.section("memory") as MemorySettings | undefined;
        const mem: Memory = { folder: folderOf(settings), pattern: ticketRegex(settings), recall: recallOf(settings) };
        memory = mem;
        active = restoredTicket(ctx.sessionManager.getBranch());
        nowSeen = "";
        sinceNotes = 0;
        reported.clear();
        closing = undefined;
        recalled.clear();
        activatedBy.clear();
        if (active !== undefined) {
            // Only a restored ticket is told: jig-core starts without one, and another extension may have set its own.
            jig().setTicket(active);
            ensureTicket(mem.folder, active);
            nowSeen = nowBlock(settleNotes(mem.folder, active, new Date()));
            note(ctx, `Ticket ${active} restored from this session.`);
            warnEmptyFiles(mem, ctx, active);
        }
    });

    pi.on("session_compact", (_event, ctx) => {
        const key = active;
        if (memory === undefined || key === undefined) return;
        // The compaction may have folded the activation message away, and the notes may have changed since it.
        const notes = settleNotes(memory.folder, key, new Date());
        nowSeen = nowBlock(notes);
        sendNotes(memory, ctx, key, COMPACTED, notes);
    });

    // A prompt from the user while checks are open carries their list, so a promise made earlier is in front of the agent
    // when it answers. The system prompt is never changed: the list is a message.
    pi.on("before_agent_start", (event, ctx) => {
        const mem = memory;
        const key = active;
        if (mem === undefined || key === undefined || event.messageType !== "user") return;
        const text = checksText(mem, ctx, key);
        if (text === undefined) return;
        return { message: { customType: CHECKS_MESSAGE, content: text, display: true, details: { key } } };
    });

    // The agent has finished, follow-ups included: read the card it was asked for. A card that does not pass gets one
    // correction message, then a warning, so a model that cannot count characters never makes a loop.
    pi.on("agent_settled", (event, ctx) => {
        const pending = closing;
        const mem = memory;
        if (pending === undefined || mem === undefined) return;
        const key = pending.key;
        let verdict: { ok: boolean; problems: string[] };
        try {
            verdict = verifyCard(mem.folder, pending);
        } catch (error) {
            closing = undefined;
            note(ctx, `Could not check the card for ${key}: ${reason(error)}`, "warning");
            return;
        }
        if (verdict.ok) {
            closing = undefined;
            const file = ticketPaths(mem.folder, key).card;
            try {
                // The card joins the index now, so the next recall finds it without reading every card.
                loadCards(mem.folder);
            } catch (error) {
                note(ctx, `Card for ${key} written, but the index could not be updated: ${reason(error)}`, "warning");
            }
            if (active === key) deactivate(ctx, `Ticket ${key} closed. Card: ${file}`);
            else note(ctx, `Card for ${key} written: ${file}`);
            return;
        }
        const list = verdict.problems.join(" ");
        if (event.aborted || pending.corrected) {
            closing = undefined;
            note(
                ctx,
                `The card for ${key} is not complete: ${list} Fix ${ticketPaths(mem.folder, key).card} by hand, or run /ticket close ${key} again.`,
                "warning",
            );
            return;
        }
        pending.corrected = true;
        pi.sendMessage(
            {
                customType: CARD_FIX,
                content: correctionText(mem.folder, key, verdict.problems),
                display: true,
                details: { key },
            },
            { triggerTurn: true, deliverAs: "followUp" },
        );
        note(ctx, `The card for ${key} needs changes; the agent is asked once more. ${list}`);
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
        if (first !== undefined) activate(mem, ctx, first, "named in your message", event.text);
    });

    // While a ticket is active, every result is checked against the ## Now block of notes.md, and the results of tools other
    // than Pi's file tools and this plugin's own are kept as evidence. The fifteenth result without a change to ## Now
    // carries the reminder. Pasted text that the `ticket` tool returns is saved here, after jig-core has removed secrets.
    pi.on("tool_result", (event, ctx) => {
        const mem = memory;
        if (mem === undefined) return;
        const pasted = finishPasted(event, mem.folder, new Date());
        if (pasted !== undefined) return pasted;
        const key = active;
        if (key === undefined) return;
        try {
            const notes = settleNotes(mem.folder, key, new Date());
            // A change to ## Now restarts the count, and the result that made the change does not count itself.
            const now = nowBlock(notes);
            sinceNotes = now === nowSeen ? sinceNotes + 1 : 0;
            nowSeen = now;
            if (!isFileTool(event.toolName) && event.toolName !== TOOL_NAME) {
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
        let open = 0;
        try {
            open = openChecks(mem.folder, key).length;
        } catch {
            // Said when the checks are listed; the reminder goes out without the count.
        }
        const reminder = reminderText(key, ticketPaths(mem.folder, key).notes, localDate(new Date()), open);
        return {
            content: [...event.content, { type: "text" as const, text: reminder }],
            // Replacing content drops structuredContent unless it is returned too, so it goes back as it came.
            ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        };
    });

    /** One pull search for the `ticket recall` action: cards and notes, cards first, rare words allowed. */
    const searchEarlier = (mem: Memory, query: string): { text: string; entries: number } => {
        if (!mem.recall.enabled) return { text: "Recall is off (memory.recall.enabled false).", entries: 0 };
        const cards = loadCards(mem.folder);
        const notes = loadNoteIndex(mem.folder, mem.pattern);
        const matches = recall(
            cards,
            buildQuery({ ...(active === undefined ? {} : { ticket: active }), text: query, pattern: mem.pattern }),
            {
                ...mem.recall,
                maxNotes: Math.max(mem.recall.maxNotes, 1),
                allowRareWords: true,
                cardsFirst: true,
            },
            notes,
        );
        const cardCount = Object.values(cards).filter((card) => card.valid).length;
        const noteCount = Object.keys(notes).filter((ticket) => cards[ticket]?.valid !== true).length;
        const searched = cardCount + noteCount;
        if (matches.length === 0) {
            return {
                text:
                    searched === 0
                        ? "No earlier tickets yet: a ticket is searchable once its notes.md or card.md exists."
                        : `No earlier ticket scores ${mem.recall.minScore} or more among ${searched} entr${searched === 1 ? "y" : "ies"}. Try an error, class name or behaviour.`,
                entries: 0,
            };
        }
        return {
            text: formatRecall(`Earlier tickets that match (${matches.length}):`, matches),
            entries: matches.length,
        };
    };

    registerJigTool(
        pi,
        ticketTool({
            active: () =>
                memory === undefined || active === undefined ? undefined : { folder: memory.folder, key: active },
            now: () => new Date(),
            search: (query) => {
                if (memory === undefined) throw new Error("Ticket memory is not ready: no session has started.");
                return searchEarlier(memory, query);
            },
        }),
    );

    pi.registerCommand("ticket", {
        description:
            "Ticket memory: /ticket KEY makes a ticket active, /ticket off clears it, /ticket close writes its card, /ticket recall finds related tickets, /ticket alone shows it",
        handler: async (args, ctx) => {
            const mem = memory;
            if (mem === undefined) {
                note(ctx, "Ticket memory is not ready: no session has started.", "warning");
                return;
            }
            const arg = args.trim();
            const [word = "", ...rest] = arg.split(/\s+/);
            if (word === "close") {
                const key = rest[0] ?? active;
                if (key === undefined) {
                    note(ctx, "No active ticket. Run /ticket close KEY.");
                } else if (rest.length > 1 || !isSafeKey(key)) {
                    note(ctx, "Use /ticket close, or /ticket close KEY.", "warning");
                } else {
                    startClose(mem, ctx, key);
                }
                return;
            }
            if (word === "recall") {
                recallByHand(mem, ctx, arg.slice(word.length).trim());
                return;
            }
            if (arg === "") {
                if (active === undefined) {
                    note(ctx, NO_TICKET);
                    return;
                }
                const saved = indexCount(mem.folder, active);
                let checks = "";
                try {
                    const open = openChecks(mem.folder, active).length;
                    checks = `, ${open} open check${open === 1 ? "" : "s"}`;
                } catch (error) {
                    checks = `, open checks unreadable (${reason(error)})`;
                }
                note(
                    ctx,
                    `Ticket ${active}: notes ${ticketPaths(mem.folder, active).notes}, ${saved} saved result${saved === 1 ? "" : "s"}${checks}.`,
                );
                return;
            }
            if (arg === "off") {
                deactivate(ctx);
                return;
            }
            if (!isSafeKey(arg) || COMMANDS.has(arg)) {
                note(ctx, USAGE, "warning");
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
