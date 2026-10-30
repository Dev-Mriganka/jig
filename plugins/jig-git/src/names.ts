// Checks on every name, path and text the model supplies, before it reaches a git or gh argument list.
// A value that is not plainly what it claims to be is refused, so it can never be read as an option.

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REV = /^[A-Za-z0-9_@][A-Za-z0-9._/@^~{}+-]*$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function checkBranch(value: unknown, label = "branch"): string {
    if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
    const parts = value.split("/");
    const bad =
        value.length > 200 ||
        !BRANCH.test(value) ||
        value.includes("..") ||
        value.includes("//") ||
        value.endsWith("/") ||
        value.endsWith(".") ||
        parts.some((part) => part.startsWith(".") || part.endsWith(".lock"));
    if (bad) throw new Error(`${label} "${value.slice(0, 80)}" is not a valid branch name`);
    return value;
}

/** A tag name follows the same rules as a branch name. */
export function checkTag(value: unknown, label = "tag"): string {
    return checkBranch(value, label);
}

export function checkRemote(value: unknown): string {
    if (typeof value !== "string" || !REMOTE.test(value) || value.length > 100) {
        throw new Error(`remote "${String(value).slice(0, 80)}" is not a valid remote name`);
    }
    return value;
}

/** A revision such as `HEAD~2`, `origin/main` or `abc1234`. It never starts with `-`, so it cannot be an option. */
export function checkRev(value: unknown, label = "rev"): string {
    if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
    if (value.length > 200 || !REV.test(value) || value.includes("..")) {
        throw new Error(`${label} "${value.slice(0, 80)}" is not a valid revision`);
    }
    return value;
}

/** `a..b`, `a...b`, or one revision. Either side of a range may be empty, as git allows. */
export function checkRange(value: unknown): string {
    if (typeof value !== "string" || value === "") throw new Error("range is required");
    const sides = value.split(/\.{2,3}/);
    const dots = value.match(/\.{2,3}/g) ?? [];
    if (sides.length > 2 || dots.length > 1 || value.length > 200)
        throw new Error(`range "${value.slice(0, 80)}" is not a valid range`);
    for (const side of sides) {
        if (side !== "" && !REV.test(side)) throw new Error(`range "${value.slice(0, 80)}" is not a valid range`);
    }
    return value;
}

/**
 * Explicit repo-relative paths. Callers pass them to git after `--` with literal pathspecs, so a `*` is a file name and
 * `:(magic)` is not magic. What is refused here is everything that is not a path inside the repository.
 */
export function checkPaths(value: unknown, what = "paths"): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${what} is required: list the files`);
    if (value.length > 100) throw new Error(`${what}: at most 100 files at a time`);
    const out = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string" || item === "") throw new Error(`${what}: every entry must be a non-empty string`);
        if (item.length > 500 || /[\0\r\n]/.test(item))
            throw new Error(`${what}: entry is too long or contains control characters`);
        if (item.startsWith("/") || item.startsWith(":") || item.startsWith("-")) {
            throw new Error(`${what}: "${item}" must be a plain repo-relative path`);
        }
        if (item.split("/").includes("..")) throw new Error(`${what}: "${item}" must stay inside the repository`);
        const normalized = item
            .split("/")
            .filter((part) => part !== "." && part !== "")
            .join("/");
        if (normalized === "") throw new Error(`${what}: name the files, not the whole repository`);
        if (normalized === ".git" || normalized.startsWith(".git/"))
            throw new Error(`${what}: .git is not a path you can name`);
        out.add(normalized);
    }
    return [...out];
}

/** A single path, for `show` and `blame`. */
export function checkPath(value: unknown, what = "path"): string {
    if (typeof value !== "string") throw new Error(`${what} is required`);
    return checkPaths([value], what)[0] as string;
}

export function checkCommitMessage(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error("message is required");
    if (value.length > 10_000) throw new Error("message is too long (10000 characters at most)");
    if (value.includes("\0")) throw new Error("message contains a NUL character");
    return value.trim();
}

export function checkTitle(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error("title is required");
    const title = value.trim();
    if (title.length > 256 || /[\r\n\0]/.test(title))
        throw new Error("title must be one line of at most 256 characters");
    return title;
}

export function checkBody(value: unknown, label = "body"): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
    if (value.length > 60_000 || value.includes("\0"))
        throw new Error(`${label} is too long or contains a NUL character`);
    return value;
}

export function checkNumber(value: unknown, label = "number"): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000_000) {
        throw new Error(`${label} is required: a positive whole number`);
    }
    return value;
}

/** Free text that becomes the value of an option such as `--author=`: one line, nothing odd. */
export function checkLine(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
    if (value.length > 300 || /[\0\r\n]/.test(value))
        throw new Error(`${label} must be one line of at most 300 characters`);
    return value;
}

/** A list of short words such as labels or logins. */
export function checkWords(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must list at least one name`);
    if (value.length > 30) throw new Error(`${label}: at most 30 names`);
    return value.map((item) => {
        if (typeof item !== "string" || item.trim() === "" || item.length > 100 || /[\0\r\n,]/.test(item)) {
            throw new Error(`${label}: "${String(item).slice(0, 40)}" is not a valid name`);
        }
        return item.trim();
    });
}
