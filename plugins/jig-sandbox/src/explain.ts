// Explaining a block. The runtime records no file refusals, so they are read back from the command's own error lines:
// `Read-only file system`, `Permission denied`, `Device or resource busy`, and `No such file or directory` for a hidden
// path (a hidden folder looks empty). Each path a line names is matched against the rules; a path that matches gets its
// rule and the way through, and anything else gets one general line that points at `/sandbox`.
//
// Network refusals are the runtime's own records and come from the broker (see `explainViolations`).
import path from "node:path";
import { inside } from "./pathing.ts";
import { ROLE_SOURCE, ruleFor, showPath, writableRootFor } from "./rules.ts";
import type { Rule, RuleSet } from "./rules.ts";
import type { NetworkMode } from "./config.ts";

export interface Explained {
    /** One line each, ready to follow the command's output. */
    lines: string[];
    /** The ask-first rules a refused write was under, once each, with the first path that was refused under it. */
    askFirst: Array<{ rule: Rule; path: string }>;
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

/** Quotes tools put round a name: plain ones, a backquote, and the curly ones GNU tools use in a UTF-8 locale. */
const OPEN_QUOTES = "'\"`\u2018\u201c";
const CLOSE_QUOTES = "'\"`\u2019\u201d";
const QUOTED = new RegExp(`[${OPEN_QUOTES}]((?:(?![${CLOSE_QUOTES}]).)+?)[${CLOSE_QUOTES}]`, "g");
const ABSOLUTE = new RegExp(
    `(?:^|[\\s${OPEN_QUOTES}([=,:])(\\/[^\\s${OPEN_QUOTES}${CLOSE_QUOTES}()[\\]:;,]*[^\\s${OPEN_QUOTES}${CLOSE_QUOTES}()[\\]:;,.])`,
    "g",
);
/** `bash: .bashrc: Read-only file system`, `cp: /a/b: Permission denied`: the path sits between two colons. */
const BETWEEN_COLONS = /^[^:]+: (.+?): [A-Z]/;

/** A path that begins the line, with a slash or a dot in it so that `Error` is not taken for a file: `./a.txt: Read-only file system`. */
const LEADING_PATH = /^(\.{0,2}\/\S*|[\w@+-]+\.[\w.@+-]+): [A-Z]/;

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
    for (const match of line.matchAll(QUOTED)) add(match[1] as string);
    for (const match of line.matchAll(ABSOLUTE)) add(match[1] as string);
    const colons = BETWEEN_COLONS.exec(line);
    if (colons !== null) add(colons[1] as string);
    // A shell redirect to a relative path leaves the path first, once the shell's own prefix is gone: `./a.txt: Read-only file system`.
    const leading = LEADING_PATH.exec(line);
    if (leading !== null) add(leading[1] as string);
    return found;
}

export interface ExplainOptions {
    cwd: string;
    mode: NetworkMode;
}

/** Network refusals for a command run with the network off: connection and name errors in its output. */
const NO_NETWORK =
    /could not resolve host|network is unreachable|temporary failure in name resolution|name or service not known|no route to host|cannot assign requested address/i;
/** In `filtered` and `ask` a name resolves only in the proxy, so a program that ignores the proxy settings finds none. */
const NO_NAME =
    /could not resolve host|temporary failure in name resolution|name or service not known|nodename nor servname|no address associated with hostname/i;
/** A direct connection to anything but the command's own `localhost` has no route there. */
const UNREACHABLE = /network is unreachable|no route to host/i;

/**
 * The lines to put after a command's output, from its last output lines. `output` is the tail of what the command printed.
 */
export function explainBlocks(output: string, set: RuleSet, options: ExplainOptions): Explained {
    const said = new Map<string, string>();
    const askFirst = new Map<string, { rule: Rule; path: string }>();
    let generalWrite = false;
    let noNetwork = false;
    let noName = false;
    let unreachable = false;
    const proxied = options.mode === "filtered" || options.mode === "ask";

    for (const raw of output.split("\n")) {
        const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
        if (options.mode === "off" && NO_NETWORK.test(line)) noNetwork = true;
        if (proxied && NO_NAME.test(line)) noName = true;
        if (proxied && UNREACHABLE.test(line)) unreachable = true;
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
                if (rule.kind === "ask-first" && !askFirst.has(rule.path))
                    askFirst.set(rule.path, { rule, path: place });
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
    if (noName) {
        lines.push(
            `[sandbox] a name does not resolve here for a program that ignores the proxy settings (dig, getent, ping, most clients that are not HTTP): in network mode ${options.mode} names resolve in the proxy. Use an HTTP client, or a tool of Jig's.`,
        );
    }
    if (unreachable) {
        lines.push(
            `[sandbox] a direct connection has no route: in network mode ${options.mode} a command reaches only the proxy, which refuses private and local addresses. A port on this machine is carried in when sandbox.network.localhost lists it.`,
        );
    }
    if (lines.length === 0 && generalWrite) {
        // For an agent whose role may not write, the usual line would be untrue: it says the working folder is writable.
        const readOnly = set.rules.some((rule) => rule.source === ROLE_SOURCE);
        lines.push(
            readOnly
                ? "[sandbox] a write was refused (read-only file system): this agent's role may not write. Only /tmp is writable, for scratch files."
                : "[sandbox] a write was refused (read-only file system). Bash may write your home folder, the working folder and /tmp; /sandbox shows every rule.",
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

/**
 * Network refusals the runtime recorded for a command (`filtered` and `ask` modes), one line each. The runtime writes a refusal as
 * `deny network-outbound host:port (reason)`, and the reason is the one this plugin gave.
 */
export function explainViolations(violations: ReadonlyArray<{ line: string }>): string[] {
    const seen = new Set<string>();
    for (const violation of violations) {
        const text = violation.line.replace(/\s+/g, " ").trim().slice(0, 400);
        if (text === "") continue;
        const parsed = /^deny network-outbound (\S+) \((.*)\)$/.exec(text);
        if (parsed === null) {
            seen.add(`[sandbox] network refused: ${text}`);
            continue;
        }
        const target = parsed[1] as string;
        // The reason often starts with the target, which the line has already said.
        const given = (parsed[2] as string).replace(/\.$/, "");
        const reason = given.startsWith(`${target} `) ? `it ${given.slice(target.length + 1)}` : given;
        // The runtime refuses a name that resolves to this machine, whatever Pi said about it; a carried port is at 127.0.0.1.
        const hint = /^resolved to /.test(reason)
            ? " A port of this machine that is carried into the command is at 127.0.0.1, not at a name."
            : "";
        seen.add(
            reason === "user denied"
                ? `[sandbox] cannot reach ${target}: refused.`
                : `[sandbox] cannot reach ${target}: ${reason}.${hint}`,
        );
    }
    return [...seen].slice(0, MAX_LINES);
}
