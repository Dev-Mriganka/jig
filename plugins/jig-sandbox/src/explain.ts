// Explaining a block. The runtime records no file refusals, so they are read back from the command's own error lines:
// `Read-only file system`, `Permission denied`, `Device or resource busy`, and `No such file or directory` for a hidden
// path (a hidden folder looks empty). Each path a line names is matched against the rules; a path that matches gets its
// rule and the way through, and anything else gets one general line that points at `/sandbox`.
//
// Network refusals are the runtime's own records and come from the broker (see `explainViolations`).
import path from "node:path";
import { inside } from "./pathing.ts";
import { ruleFor, showPath, writableRootFor } from "./rules.ts";
import type { Rule, RuleSet } from "./rules.ts";
import type { NetworkMode } from "./config.ts";

export interface Explained {
    /** One line each, ready to follow the command's output. */
    lines: string[];
    /** The ask-first rules a refused write was under, once each. */
    askFirst: Rule[];
}

/** How many explanations follow one command's output; the rest are counted. */
const MAX_LINES = 5;
const MAX_LINE_CHARS = 2_000;

type Refusal = "write" | "denied" | "missing";

function refusalOf(line: string): Refusal | undefined {
    if (/read-only file system|\bEROFS\b|device or resource busy|\bEBUSY\b/i.test(line)) return "write";
    if (/permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i.test(line)) return "denied";
    if (/no such file or directory|\bENOENT\b/i.test(line)) return "missing";
    return undefined;
}

const QUOTED = /(['"`])((?:(?!\1).)+?)\1/g;
const ABSOLUTE = /(?:^|[\s'"`([=,:])(\/[^\s'"`()[\]:;,]*[^\s'"`()[\]:;,.])/g;
/** `bash: .bashrc: Read-only file system`, `cp: /a/b: Permission denied`: the path sits between two colons. */
const BETWEEN_COLONS = /^[^:]+: (.+?): [A-Z]/;

/** A shell names itself and the line of the script before the error: `/usr/bin/bash: line 1: /a/b: Read-only file system`. */
const SHELL_PREFIX = /^\S+: line \d+: /;

/** The paths a line names, absolute, in the order they appear. */
function pathsIn(rawLine: string, cwd: string, home: string): string[] {
    const line = rawLine.replace(SHELL_PREFIX, "");
    const found: string[] = [];
    const add = (text: string): void => {
        let candidate = text.trim().replace(/\\ /g, " ");
        if (candidate === "" || candidate.length > 1_000 || candidate.includes("\n")) return;
        if (candidate === "~") candidate = home;
        else if (candidate.startsWith("~/")) candidate = path.posix.join(home, candidate.slice(2));
        else if (!candidate.startsWith("/")) {
            // A relative name is a path only when it looks like one: it has a slash or a dot, or it is a file name.
            if (!/^[\w.@+-][\w./@+-]*$/.test(candidate)) return;
            candidate = path.posix.resolve(cwd, candidate);
        }
        const folded = path.posix.resolve(candidate);
        if (!found.includes(folded)) found.push(folded);
    };
    for (const match of line.matchAll(QUOTED)) add(match[2] as string);
    for (const match of line.matchAll(ABSOLUTE)) add(match[1] as string);
    const colons = BETWEEN_COLONS.exec(line);
    if (colons !== null) add(colons[1] as string);
    return found;
}

export interface ExplainOptions {
    cwd: string;
    mode: NetworkMode;
}

/** Network refusals for a command run with the network off: connection and name errors in its output. */
const NO_NETWORK =
    /could not resolve host|network is unreachable|temporary failure in name resolution|name or service not known|no route to host|cannot assign requested address/i;

/**
 * The lines to put after a command's output, from its last output lines. `output` is the tail of what the command printed.
 */
export function explainBlocks(output: string, set: RuleSet, options: ExplainOptions): Explained {
    const said = new Map<string, string>();
    const askFirst = new Map<string, Rule>();
    let generalWrite = false;
    let noNetwork = false;

    for (const raw of output.split("\n")) {
        const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
        if (options.mode === "off" && NO_NETWORK.test(line)) noNetwork = true;
        const refusal = refusalOf(line);
        if (refusal === undefined) continue;
        let explained = false;
        for (const place of pathsIn(line, options.cwd, set.home)) {
            const rule = ruleFor(set, place);
            if (rule === undefined) {
                // Outside every rule: only a read-only file system says the place is not one the sandbox lets bash write.
                if (
                    refusal === "write" &&
                    /read-only file system|EROFS/i.test(line) &&
                    writableRootFor(set, place) === undefined
                ) {
                    const key = `outside\0${path.posix.dirname(place)}`;
                    if (!said.has(key) && isPlausiblePath(place)) {
                        said.set(
                            key,
                            `[sandbox] cannot write ${showPath(set, place)}: it is outside the folders bash may write (your home folder, the working folder, /tmp and the folders you share). Write in one of those instead.`,
                        );
                    }
                    explained = true;
                }
                continue;
            }
            if (rule.kind === "hidden") {
                // A hidden path reads as absent or empty, so a missing file under it is the sandbox's doing.
                const key = `hidden\0${place}`;
                if (!said.has(key)) said.set(key, wording(refusal === "write" ? "write" : "read", place, rule, set));
                explained = true;
            } else if (refusal !== "missing") {
                const key = `${rule.kind}\0${rule.path}`;
                if (!said.has(key)) said.set(key, wording("write", place, rule, set));
                if (rule.kind === "ask-first") askFirst.set(rule.path, rule);
                explained = true;
            }
        }
        if (!explained && refusal === "write" && /read-only file system|EROFS/i.test(line)) generalWrite = true;
    }

    const lines = [...said.values()];
    if (noNetwork)
        lines.push(
            "[sandbox] no network: the sandbox's network mode is off. Set sandbox.network.mode to open in jig.json to allow it.",
        );
    if (lines.length === 0 && generalWrite) {
        lines.push(
            "[sandbox] a write was refused (read-only file system). Bash may write your home folder, the working folder and /tmp; /sandbox shows every rule.",
        );
    }
    const shown = lines.slice(0, MAX_LINES);
    if (lines.length > MAX_LINES)
        shown.push(`[sandbox] and ${lines.length - MAX_LINES} more refusals; /sandbox shows the rules.`);
    return { lines: shown, askFirst: [...askFirst.values()] };
}

/** A path worth naming: not a kernel pseudo-path or a version number that happens to start with a slash. */
function isPlausiblePath(place: string): boolean {
    return !inside(place, "/proc") && !inside(place, "/sys") && !inside(place, "/dev") && place.split("/").length > 2;
}

function wording(verb: "read" | "write", place: string, rule: Rule, set: RuleSet): string {
    const text = `[sandbox] cannot ${verb} ${showPath(set, place)}: ${rule.reason}.`;
    return rule.way === "" ? text : `${text} ${rule.way}`;
}

/** Network refusals the runtime recorded for a command (`filtered` and `ask` modes, a later build), one line each. */
export function explainViolations(violations: ReadonlyArray<{ line: string }>): string[] {
    const seen = new Set<string>();
    for (const violation of violations) {
        const text = violation.line.replace(/\s+/g, " ").trim().slice(0, 300);
        if (text !== "") seen.add(`[sandbox] network refused: ${text}`);
    }
    return [...seen].slice(0, MAX_LINES);
}
