// Small path helpers for the rules. Paths here are POSIX paths: the sandbox runs on Linux and macOS.
import path from "node:path";
import type { FileView } from "./files.ts";

/** True when `child` is `parent` or lies inside it. Both are absolute and already folded. */
export function inside(child: string, parent: string): boolean {
    if (parent === "/") return child.startsWith("/");
    return child === parent || child.startsWith(`${parent}/`);
}

/** `~`, `~/x` or an absolute path made absolute; anything else is not a path a rule can name. */
export function expand(text: string, home: string): string | undefined {
    if (text === "~") return home;
    if (text.startsWith("~/")) return path.posix.join(home, text.slice(2));
    return path.posix.isAbsolute(text) ? path.posix.resolve(text) : undefined;
}

/** The path with the home folder written as `~`, so a message does not spell out where the user lives. */
export function shown(absolute: string, home: string): string {
    if (home === "" || home === "/") return absolute;
    if (absolute === home) return "~";
    return absolute.startsWith(`${home}/`) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

/**
 * The path with links followed as far as it exists; the part that does not exist yet stays as written. This is where
 * a write to it would land, so it is what a rule is matched against.
 */
export function resolveLoose(files: FileView, absolute: string): string {
    const folded = path.posix.resolve(absolute);
    const whole = files.real(folded);
    if (whole !== undefined) return whole;
    const rest: string[] = [];
    let current = folded;
    for (let guard = 0; guard < 4096; guard++) {
        const parent = path.posix.dirname(current);
        rest.unshift(path.posix.basename(current));
        if (parent === current) return folded;
        const real = files.real(parent);
        if (real !== undefined) return path.posix.join(real, ...rest);
        current = parent;
    }
    return folded;
}

/** The folders from `start` up to the root, `start` first. */
export function ancestors(start: string): string[] {
    const out: string[] = [];
    let current = path.posix.resolve(start);
    for (;;) {
        out.push(current);
        const parent = path.posix.dirname(current);
        if (parent === current) return out;
        current = parent;
    }
}
