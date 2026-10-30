// A git configuration file, read just enough to find the settings that make git run a program or redirect a remote.
// `.git/config` has to stay writable in the sandbox (`git config`, `git remote add` and `git branch --set-upstream-to`
// are normal work), but git runs outside it, with the user's credentials, when the repository is opened in an editor or
// Jig's git tool runs. So after each command the file is compared with what it was, and a new dangerous setting is taken
// out. This is a text comparison: it needs no git, which would itself read the file it is judging.
import { GIT_PLAIN_KEYS, GIT_SUBSECTION_KEYS } from "./lists.ts";

/** One setting, with the lines it occupies. */
export interface ConfigEntry {
    /** Lower case, as git compares it. */
    section: string;
    /** As written: git compares subsections with case. */
    subsection?: string;
    /** Lower case. */
    key: string;
    /** Absent for a bare key, which git reads as true. */
    value?: string;
    /** First and last line of the setting, counting from 0. A value can continue over lines with a trailing `\`. */
    first: number;
    last: number;
    /** True when the setting is written after its section header on the same line: `[core] pager = x`. */
    onHeader: boolean;
}

const HEADER = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/;
const KEY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;

/** The key as git names it: `section.subsection.key`, with section and key in lower case. */
export function fullName(entry: Pick<ConfigEntry, "section" | "subsection" | "key">): string {
    return entry.subsection === undefined
        ? `${entry.section}.${entry.key}`
        : `${entry.section}.${entry.subsection}.${entry.key}`;
}

/** Git's boolean false: `false`, `no`, `off`, `0` or an empty value. A bare key is true. */
function isFalse(value: string | undefined): boolean {
    if (value === undefined) return false;
    const text = value.trim().toLowerCase();
    return text === "" || text === "false" || text === "no" || text === "off" || /^[+-]?0+$/.test(text);
}

/** Whether git would run a program or redirect a remote because of this setting. */
export function isDangerous(entry: ConfigEntry): boolean {
    const name = fullName(entry);
    const lower = name.toLowerCase();
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    if (first < 0) return false;
    // An alias that starts with `!` runs a shell command.
    if (entry.section === "alias") return (entry.value ?? "").trim().startsWith("!");
    if (first === last) {
        // `core.fsmonitor=false` is the safe setting, and the one Jig's own git calls set.
        if (lower === "core.fsmonitor") return !isFalse(entry.value);
        return GIT_PLAIN_KEYS.has(lower);
    }
    return GIT_SUBSECTION_KEYS.get(lower.slice(0, first))?.has(lower.slice(last + 1)) === true;
}

/** The settings of a file, in order. A line that is not a header, a setting or a comment is skipped. */
export function parseGitConfig(text: string): ConfigEntry[] {
    const lines = text.split("\n");
    const entries: ConfigEntry[] = [];
    let section: string | undefined;
    let subsection: string | undefined;
    for (let index = 0; index < lines.length; index++) {
        let line = (lines[index] as string).replace(/\r$/, "");
        let onHeader = false;
        if (/^\s*[#;]/.test(line) || line.trim() === "") continue;
        const header = HEADER.exec(line);
        if (header !== null) {
            const name = header[1] as string;
            const dot = name.indexOf(".");
            // `[section.subsection]` is the old spelling, and its subsection is lower case.
            if (header[2] === undefined && dot > 0) {
                section = name.slice(0, dot).toLowerCase();
                subsection = name.slice(dot + 1);
            } else {
                section = name.toLowerCase();
                subsection = header[2]?.replace(/\\(.)/g, "$1");
            }
            line = (header[3] as string).trim();
            if (line === "" || /^[#;]/.test(line)) continue;
            onHeader = true;
        }
        if (section === undefined) continue;
        const setting = KEY.exec(stripComment(line));
        if (setting === null) continue;
        let value = setting[2] === undefined ? undefined : setting[2].trim();
        let last = index;
        // A value that ends in a backslash goes on in the next line.
        while (value?.endsWith("\\") && !value.endsWith("\\\\") && last + 1 < lines.length) {
            last++;
            value = `${value.slice(0, -1)}${(lines[last] as string).replace(/\r$/, "").trim()}`;
        }
        entries.push({
            section,
            ...(subsection === undefined ? {} : { subsection }),
            key: (setting[1] as string).toLowerCase(),
            ...(value === undefined ? {} : { value: unquote(value) }),
            first: index,
            last,
            onHeader,
        });
        index = last;
    }
    return entries;
}

/** The line without a trailing comment that is outside quotes. */
function stripComment(line: string): string {
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === "\\") index++;
        else if (char === '"') quoted = !quoted;
        else if (!quoted && (char === "#" || char === ";")) return line.slice(0, index);
    }
    return line;
}

function unquote(value: string): string {
    const text = stripComment(value).trim();
    return text.replace(/"((?:[^"\\]|\\.)*)"/g, "$1").replace(/\\(.)/g, "$1");
}

/** What identifies a setting across two reads of a file: its name and value. */
export function signature(entry: ConfigEntry): string {
    return `${fullName(entry)}\0${entry.value ?? "\0true"}`;
}

/**
 * The dangerous settings in `after` that were not in `before`. A setting that is in both is the user's or an earlier
 * command's and is left alone; the count matters, so a second copy of a setting that was there once is new.
 */
export function newDangerous(before: readonly ConfigEntry[], after: readonly ConfigEntry[]): ConfigEntry[] {
    const seen = new Map<string, number>();
    for (const entry of before) seen.set(signature(entry), (seen.get(signature(entry)) ?? 0) + 1);
    const fresh: ConfigEntry[] = [];
    for (const entry of after) {
        const key = signature(entry);
        const left = seen.get(key) ?? 0;
        if (left > 0) seen.set(key, left - 1);
        else if (isDangerous(entry)) fresh.push(entry);
    }
    return fresh;
}

/** The file text without those settings; everything else, comments and blank lines included, is kept as written. */
export function removeEntries(text: string, remove: readonly ConfigEntry[]): string {
    const lines = text.split("\n");
    const drop = new Set<number>();
    const headerOnly = new Set<number>();
    for (const entry of remove) {
        if (entry.onHeader) headerOnly.add(entry.first);
        else for (let index = entry.first; index <= entry.last; index++) drop.add(index);
    }
    const kept: string[] = [];
    lines.forEach((line, index) => {
        if (drop.has(index)) return;
        if (headerOnly.has(index)) {
            const header = /^(\s*\[[^\]]*\])/.exec(line);
            kept.push(header === null ? line : (header[1] as string));
            return;
        }
        kept.push(line);
    });
    return kept.join("\n");
}
