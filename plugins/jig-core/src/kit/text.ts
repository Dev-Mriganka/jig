// Putting values and names into messages without surprises. Stateless: see values.ts.

/** A name or header from another package, safe to put in a message: control characters become `?`, and it is cut at 60
 *  characters. */
export function printable(text: string): string {
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, "?");
    return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean;
}

/** `String(value)`, or a stand-in for a value whose own `toString` throws (a null-prototype object, a hostile proxy). */
export function stringOf(value: unknown): string {
    try {
        return String(value);
    } catch {
        return "(cannot be shown)";
    }
}
