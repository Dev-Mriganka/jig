// Company defaults for plugin sections of jig.json. A company plugin cannot write your file, so it gives defaults, and
// your own section is laid over them: objects merge key by key, and any other value of yours (a list, a string, a
// number) replaces the company's. The result is checked by the plugin's own validation, like a section you wrote.

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `mine` laid over `theirs`. Neither is changed. */
export function layered(theirs: unknown, mine: unknown): unknown {
    if (mine === undefined) return theirs;
    if (!isPlainObject(theirs) || !isPlainObject(mine)) return mine;
    const out: Record<string, unknown> = { ...theirs };
    for (const [key, value] of Object.entries(mine)) out[key] = layered(theirs[key], value);
    return out;
}
