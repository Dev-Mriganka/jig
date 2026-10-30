// Cutting text by size. The limits are in bytes, because a file or a message has a byte budget. A cut never falls
// inside a character, and the note that says the text was cut counts toward the limit, so the result never exceeds it.

/** `text` unchanged when it fits in `max` bytes; otherwise its start, ending with `note`, in at most `max` bytes. */
export function clipBytes(text: string, max: number, note: string): string {
    if (Buffer.byteLength(text) <= max) return text;
    const bytes = Buffer.from(text, "utf8");
    let end = Math.max(0, max - Buffer.byteLength(note));
    // A byte of the form 10xxxxxx continues a character, so the cut moves back to the byte that starts it.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8") + note;
}
