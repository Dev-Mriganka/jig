// Company defaults for plugin sections of jig.json. A company plugin cannot write your file, so it gives defaults, and
// your own section is laid over them: objects merge key by key, and any other value of yours (a list, a string, a
// number) replaces the company's. The result is checked by the plugin's own validation, like a section you wrote.
//
// A plugin may name keys that replace instead of merge, because an object there is one choice among several (an `auth`
// of `{ transport }` or of `{ token }`): merging yours into the company's would give a mix that is neither. A key is a
// path from the section's root, with `*` for any one name (a map of services, say): `auth`, `backend.auth`,
// `services.*.ci.auth`.
//
// A plugin may also name keys that exclude each other (`oneOf`), such as `backend.auth` and `backend.transport`: when your
// section sets one of them, the company's value for the others is dropped, so the two do not end up side by side.

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own property, even one called `__proto__`, which a plain assignment would read as the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
    return pattern.length === path.length && pattern.every((part, index) => part === "*" || part === path[index]);
}

/** Whether the path at which two objects meet is one the plugin said replaces. */
function replaces(patterns: readonly (readonly string[])[], path: readonly string[]): boolean {
    return patterns.some((pattern) => matches(pattern, path));
}

/** Keys that exclude each other, all in one object: the object's path and the keys' names. */
interface Rivals {
    parent: readonly string[];
    keys: readonly string[];
}

/** The company's keys to leave out at `path`: the rivals of any key your section sets there. */
function displaced(groups: readonly Rivals[], path: readonly string[], mine: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    for (const group of groups) {
        if (!matches(group.parent, path)) continue;
        const chosen = group.keys.filter((key) => Object.hasOwn(mine, key));
        if (chosen.length === 0) continue;
        for (const key of group.keys) if (!chosen.includes(key)) out.add(key);
    }
    return out;
}

function lay(
    theirs: unknown,
    mine: unknown,
    path: readonly string[],
    patterns: readonly (readonly string[])[],
    groups: readonly Rivals[],
): unknown {
    if (mine === undefined) return theirs;
    if (!isPlainObject(theirs) || !isPlainObject(mine)) return mine;
    // Yours takes the place of theirs whole: nothing of the company's stays beside it.
    if (replaces(patterns, path)) return mine;
    const out: Record<string, unknown> = {};
    const dropped = displaced(groups, path, mine);
    for (const [key, value] of Object.entries(theirs)) if (!dropped.has(key)) put(out, key, value);
    for (const [key, value] of Object.entries(mine)) {
        put(
            out,
            key,
            lay(Object.hasOwn(theirs, key) ? theirs[key] : undefined, value, [...path, key], patterns, groups),
        );
    }
    return out;
}

/** `mine` laid over `theirs`. Neither is changed. `replace` lists the paths whose object of yours replaces theirs whole;
 *  each list in `oneOf` holds paths in one object that exclude each other (see `oneOfProblem`). */
export function layered(
    theirs: unknown,
    mine: unknown,
    replace: readonly string[] = [],
    oneOf: readonly (readonly string[])[] = [],
): unknown {
    const groups = oneOf.map((paths) => {
        const split = paths.map((path) => path.split("."));
        return { parent: split[0]?.slice(0, -1) ?? [], keys: split.map((parts) => parts.at(-1) ?? "") };
    });
    return lay(
        theirs,
        mine,
        [],
        replace.map((path) => path.split(".")),
        groups,
    );
}

/** Why a `oneOf` list is not usable, or undefined: at least two paths, all in the same object. */
export function oneOfProblem(paths: unknown): string | undefined {
    if (!Array.isArray(paths) || paths.length < 2 || paths.some((path) => typeof path !== "string" || path === "")) {
        return 'each oneOf entry is a list of two or more paths, such as ["backend.auth", "backend.transport"]';
    }
    const parents = new Set(paths.map((path: string) => path.split(".").slice(0, -1).join(".")));
    return parents.size === 1 ? undefined : `the paths of a oneOf entry must be in one object: ${paths.join(", ")}`;
}
