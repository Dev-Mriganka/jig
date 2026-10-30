// Re-indents JSON text without reading its numbers: an id longer than 15 digits must read exactly as the service sent it,
// and parsing then printing would round it.

const isSpace = (char: string | undefined): boolean => char === " " || char === "\n" || char === "\r" || char === "\t";

/** The text indented by two spaces, or undefined when it is not valid JSON. */
export function prettyJson(text: string): string | undefined {
    try {
        JSON.parse(text);
    } catch {
        return undefined;
    }
    // The text is valid JSON, so outside a string there is only structure, numbers, literals and white space.
    let out = "";
    let depth = 0;
    let inString = false;
    const newline = (): string => `\n${"  ".repeat(depth)}`;
    for (let i = 0; i < text.length; i++) {
        const char = text[i] as string;
        if (inString) {
            out += char;
            if (char === "\\") out += text[++i] ?? "";
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
        } else if (isSpace(char)) {
            // Whitespace outside a string is dropped.
        } else if (char === "{" || char === "[") {
            const close = char === "{" ? "}" : "]";
            let next = i + 1;
            while (isSpace(text[next])) next++;
            if (text[next] === close) {
                // An empty object or list stays on one line.
                out += char + close;
                i = next;
            } else {
                depth++;
                out += char + newline();
            }
        } else if (char === "}" || char === "]") {
            depth--;
            out += newline() + char;
        } else if (char === ",") {
            out += char + newline();
        } else if (char === ":") {
            out += ": ";
        } else {
            out += char;
        }
    }
    return out;
}
