// Text that comes from a child (a question, a transcript line, a report) is data. Before it reaches the screen or a file it loses
// every terminal control sequence, so it cannot move the cursor, change the title or redraw a line to pass as the plugin's own.

/** Escape sequences: the string introducers (DCS, SOS, PM, APC) and OSC up to their terminator, then CSI, then any other `ESC x`. */
const STRINGS = /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]?/g;
/** Controls other than tab and line feed, DEL, the C1 range, bidirectional overrides, zero-width marks and the byte order mark. */
const CONTROLS =
    /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}]/gu;
const LINE_BREAKS = /\r\n?|\u{2028}|\u{2029}/gu;

/** The text without escape sequences or control characters. Line breaks stay (a carriage return counts as one), tabs become spaces. */
export function stripControl(text: string): string {
    return text
        .replace(STRINGS, "")
        .replace(OSC, "")
        .replace(CSI, "")
        .replace(OTHER_ESCAPE, "")
        .replace(LINE_BREAKS, "\n")
        .replace(/\t/g, " ")
        .replace(CONTROLS, "");
}

/** One line of text for a status row or a notice: cleaned, folded to one line and cut. */
export function oneLine(text: string, max = 200): string {
    const line = stripControl(text).replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line;
}

export interface Shape {
    /** Put before every line. Default none. */
    indent?: string;
    /** At most this many lines; the rest is replaced by a note. Default 30. */
    maxLines?: number;
    /** Each line is cut here. Default 200. */
    maxLineChars?: number;
}

/** The text cleaned, indented and cut: at most `maxLines` lines of `maxLineChars` characters, with a note where it was cut. */
export function shaped(text: string, shape: Shape = {}): string {
    const indent = shape.indent ?? "";
    const maxLines = shape.maxLines ?? 30;
    const maxChars = shape.maxLineChars ?? 200;
    const lines = stripControl(text).split("\n");
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    const out: string[] = [];
    let cutLines = 0;
    for (const line of lines) {
        if (out.length >= maxLines) {
            cutLines++;
            continue;
        }
        const trimmed = line.replace(/\s+$/, "");
        out.push(`${indent}${trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 3)}...` : trimmed}`);
    }
    if (cutLines > 0) out.push(`${indent}(${cutLines} more line${cutLines === 1 ? "" : "s"} not shown)`);
    return out.join("\n");
}

/** The last `count` lines of a text, each cut, for the tail of a stream. */
export function tailLines(text: string, count: number, maxLineChars = 300): string[] {
    return stripControl(text)
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line !== "")
        .slice(-count)
        .map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars - 3)}...` : line));
}
