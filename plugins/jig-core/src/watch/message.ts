// What the agent is told when watches end, in plain words.
//
// One message can carry several results (see `outbox.ts`), so the text is a block per watch, with a blank line between
// blocks. The text is built from a watch's title and its cleaned result; nothing in here has seen a secret.
import type { WatchResult } from "../contract.ts";

/** Pi's custom message type for these messages, so a UI or another plugin can pick them out. */
export const WATCH_MESSAGE_TYPE = "jig-watch";

/** One thing to tell the agent about one watch. Every text in it is already cleaned. */
export interface Notice {
    event: "finished" | "paused";
    id: string;
    kind: string;
    plugin: string;
    title: string;
    /** For a finished watch. */
    result?: WatchResult;
    /** The watch was finished by the first poll after Pi was closed and opened again. */
    afterRestart?: boolean;
    /** For a paused watch: how many polls in a row failed, and the last failure on one line. */
    failures?: number;
    error?: string;
}

/** What the message carries besides its text, for a screen or another plugin. */
export interface WatchMessageDetails {
    watches: Array<{
        id: string;
        kind: string;
        plugin: string;
        title: string;
        event: Notice["event"];
        outcome?: WatchResult["outcome"];
        afterRestart?: true;
    }>;
}

export interface WatchMessage {
    customType: typeof WATCH_MESSAGE_TYPE;
    content: string;
    display: true;
    details: WatchMessageDetails;
}

/** How many detail lines and links the text shows. The rest stay in the saved result and in the done event. */
export const SHOWN_DETAIL_LINES = 10;
export const SHOWN_LINKS = 5;

/** How the first sentence ends, by outcome. */
const OUTCOME_PHRASE: Readonly<Record<WatchResult["outcome"], string>> = {
    passed: "passed",
    failed: "failed",
    "timed-out": "timed out",
    stopped: "was stopped",
    error: "ended with an error",
};

/** The notice that pauses and what pausing means, so the agent does not wait for a result that is not coming. */
function pausedBlock(notice: Notice): string {
    const why = notice.error === undefined || notice.error === "" ? "" : ` The last error was: ${notice.error}`;
    return [
        `The watch "${notice.title}" is paused: its last ${notice.failures ?? 3} polls in a row failed.${why}`,
        "It starts again when this session next starts. " +
            `To give it up now, stop it with the watch tool (id ${notice.id}).`,
    ].join("\n");
}

function finishedBlock(notice: Notice, result: WatchResult): string {
    const first = `The watch "${notice.title}" ${OUTCOME_PHRASE[result.outcome]}.`;
    // After a colon the sentence starts with a lower case letter.
    const after = `While Pi was closed: ${first.charAt(0).toLowerCase()}${first.slice(1)}`;
    const lines = [notice.afterRestart === true ? after : first];
    if (result.summary !== "") lines.push(result.summary);

    const details = result.details === undefined ? [] : result.details.split("\n");
    if (details.length > 0) {
        lines.push("Details:", ...details.slice(0, SHOWN_DETAIL_LINES).map((line) => `  ${line}`));
        const hidden = details.length - SHOWN_DETAIL_LINES;
        if (hidden > 0) lines.push(`  [${hidden} more lines not shown]`);
    }
    const links = result.links ?? [];
    if (links.length > 0) {
        lines.push("Links:", ...links.slice(0, SHOWN_LINKS).map((link) => `  ${link}`));
        if (links.length > SHOWN_LINKS) lines.push(`  [${links.length - SHOWN_LINKS} more links not shown]`);
    }
    return lines.join("\n");
}

/** One message for these notices, in the order they came. */
export function composeMessage(notices: readonly Notice[]): WatchMessage {
    const blocks = notices.map((notice) => {
        const { result } = notice;
        if (notice.event === "finished" && result !== undefined) return finishedBlock(notice, result);
        return pausedBlock(notice);
    });
    return {
        customType: WATCH_MESSAGE_TYPE,
        content: blocks.join("\n\n"),
        display: true,
        details: {
            watches: notices.map((notice) => ({
                id: notice.id,
                kind: notice.kind,
                plugin: notice.plugin,
                title: notice.title,
                event: notice.event,
                ...(notice.result === undefined ? {} : { outcome: notice.result.outcome }),
                ...(notice.afterRestart === true ? { afterRestart: true as const } : {}),
            })),
        },
    };
}
