// What a command printed, made safe to show and to give the model: terminal control sequences removed (a command's output
// must not move the cursor, change the title or write to the clipboard of the user's terminal), and the values of the
// credentials that were taken out of the environment replaced if they show up anyway. Output arrives in chunks, so a
// sequence or a value can be cut between two of them: the cleaner holds back the end of a chunk that might be the start of
// one, and says it at the end.
import { StringDecoder } from "node:string_decoder";

const ESC = "\u001b";
/** A control sequence longer than this is not one; the escape is dropped and the rest is text. */
const MAX_SEQUENCE = 4096;

/** Escape sequences: CSI, OSC (to BEL or ST), the string kinds (DCS, SOS, PM, APC), and the two-character ones. */
const SEQUENCE_SOURCE = [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)`,
    `${ESC}[PX^_][^${ESC}]*${ESC}\\\\`,
    // The rest of the final bytes: those of the kinds above are left out, so an unfinished one is not taken for this.
    `${ESC}[ -/]*[0-OQ-WYZ\\\\\`-~]`,
    "\u009b[0-?]*[ -/]*[@-~]",
].join("|");
const SEQUENCES = new RegExp(SEQUENCE_SOURCE, "g");
/** Control characters that are not text. A tab, a line feed and a carriage return (progress bars) stay. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g;

/** The start of a sequence that has begun and could still end: an escape, then what the kinds above allow before the end. */
const UNFINISHED = new RegExp(
    `^(?:${ESC}(?:|\\[[0-?]*[ -/]*|\\][^\u0007${ESC}]*${ESC}?|[PX^_][^${ESC}]*${ESC}?|[ -/]+)|\u009b[0-?]*[ -/]*)$`,
);

/**
 * Where an unfinished escape sequence starts at the end of `text`, or -1. An escape that has begun but not ended is held
 * back until the next chunk shows how it ends; one that cannot become a sequence is not held.
 */
function openSequenceAt(text: string): number {
    const start = Math.max(text.lastIndexOf(ESC), text.lastIndexOf("\u009b"));
    if (start < 0) return -1;
    const tail = text.slice(start);
    return tail.length <= MAX_SEQUENCE && UNFINISHED.test(tail) ? start : -1;
}

/** How many characters at the end of `text` could be the start of one of the values. */
function heldForValues(text: string, values: readonly string[]): number {
    let hold = 0;
    for (const value of values) {
        const from = Math.max(0, text.length - (value.length - 1));
        for (let at = from; at < text.length; at++) {
            if (text[at] === value[0] && value.startsWith(text.slice(at))) {
                hold = Math.max(hold, text.length - at);
                break;
            }
        }
    }
    return hold;
}

export interface OutputCleaner {
    /** Cleans a chunk and returns what can be shown now; the rest waits for the next chunk. */
    push(chunk: Buffer): Buffer;
    /** The held-back end, cleaned, when the command is over. */
    end(): Buffer;
}

/** A cleaner for one command's output. `values` are the credential values to replace with `[redacted]`. */
export function createOutputCleaner(values: readonly string[] = []): OutputCleaner {
    const decoder = new StringDecoder("utf8");
    let held = "";

    const clean = (text: string): string => {
        let out = text.replace(SEQUENCES, "").replace(CONTROLS, "");
        // A lone escape that begins nothing is dropped as well.
        out = out.replaceAll(ESC, "");
        for (const value of values) out = out.replaceAll(value, "[redacted]");
        return out;
    };

    return {
        push(chunk) {
            const text = held + decoder.write(chunk);
            const open = openSequenceAt(text);
            let keep = open < 0 ? text.length : open;
            // A value cut by the end of the chunk waits for the next one.
            keep -= heldForValues(text.slice(0, keep), values);
            held = text.slice(keep);
            return Buffer.from(clean(text.slice(0, keep)), "utf8");
        },
        end() {
            const text = held + decoder.end();
            held = "";
            // What began as a sequence and never ended is dropped whole.
            const open = openSequenceAt(text);
            return Buffer.from(clean(open < 0 ? text : text.slice(0, open)), "utf8");
        },
    };
}
