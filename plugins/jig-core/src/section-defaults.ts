// Company defaults for plugin sections of jig.json. A company plugin cannot write your file, so it gives defaults, and
// your own section is laid over them: objects merge key by key, and any other value of yours (a list, a string, a
// number) replaces the company's. The result is checked by the plugin's own validation, like a section you wrote.
//
// A plugin may name keys that replace instead of merge, because an object there is one choice among several (an `auth`
// of `{ transport }` or of `{ token }`): merging yours into the company's would give a mix that is neither. A key is a
// path from the section's root, with `*` for any one name (a map of services, say): `auth`, `backend.auth`,
// `services.*.ci.auth`.

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own property, even one called `__proto__`, which a plain assignment would read as the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Whether the path at which two objects meet is one the plugin said replaces. */
function replaces(patterns: readonly (readonly string[])[], path: readonly string[]): boolean {
    return patterns.some(
        (pattern) =>
            pattern.length === path.length && pattern.every((part, index) => part === "*" || part === path[index]),
    );
}

function lay(
    theirs: unknown,
    mine: unknown,
    path: readonly string[],
    patterns: readonly (readonly string[])[],
): unknown {
    if (mine === undefined) return theirs;
    if (!isPlainObject(theirs) || !isPlainObject(mine)) return mine;
    // Yours takes the place of theirs whole: nothing of the company's stays beside it.
    if (replaces(patterns, path)) return mine;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(theirs)) put(out, key, value);
    for (const [key, value] of Object.entries(mine)) {
        put(out, key, lay(Object.hasOwn(theirs, key) ? theirs[key] : undefined, value, [...path, key], patterns));
    }
    return out;
}

/** `mine` laid over `theirs`. Neither is changed. `replace` lists the paths whose object of yours replaces theirs whole. */
export function layered(theirs: unknown, mine: unknown, replace: readonly string[] = []): unknown {
    return lay(
        theirs,
        mine,
        [],
        replace.map((path) => path.split(".")),
    );
}
