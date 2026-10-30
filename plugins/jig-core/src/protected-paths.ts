// Protected paths: files that Pi's own file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) must not touch.
//
// Two kinds, and both are part of the floor, so configuration can add paths and never remove one:
//   secret    no reading and no writing: credential files, such as `~/.ssh` or `gh`'s token file;
//   guarded   reading is allowed, writing is not: Pi's agent folder, where `jig.json`, Pi's settings, extensions and
//             Jig's own state live. An agent that could write there could load code or loosen a rule.
//
// A path is matched after `~` is expanded, a relative path is resolved against Pi's folder, `..` is folded away and
// every symlink on the way is followed, so a link in a project that points into `~/.ssh` is caught. A path is
// protected when it equals a protected path or is inside one.
//
// This checks the file tools only. `bash` is the sandbox's job: until the sandbox runs, a shell command can still reach
// these paths.
import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProtectedKind = "secret" | "guarded";

/** Where an entry came from, as `/jig rules` says it. */
export type ProtectedSource = "default" | "personal" | "company";

export interface ProtectedPath {
    /** Absolute, as it is matched. */
    path: string;
    /** For messages: the path with the home folder written as `~`. */
    shown: string;
    kind: ProtectedKind;
    source: ProtectedSource;
}

/** What differs between systems, so a test can simulate Windows or macOS on Linux. */
export interface PathContext {
    /** Default: this process's platform. `win32` and `darwin` compare paths without regard to case. */
    platform?: NodeJS.Platform;
}

export interface DefaultsInput extends PathContext {
    /** Pi's agent folder (`getAgentDir()`). Empty when not known: the entries inside it are left out. */
    agentDir: string;
    home: string;
    env?: { XDG_CONFIG_HOME?: string | undefined; APPDATA?: string | undefined };
}

/** What a tool's input is checked against. */
export interface CheckContext extends PathContext {
    entries: readonly ProtectedPath[];
    /** Pi's working folder: where a relative path starts. */
    cwd: string;
    home: string;
}

export interface Refusal {
    /** One line for the model, naming the protected path and never any file content. */
    reason: string;
    /** The protected path that stopped the call. Absent when the path was not text. */
    entry?: ProtectedPath;
}

/** The tools this checks, which are the file tools Pi ships. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// ---- the defaults -------------------------------------------------------------------------------------------------

/** Inside the agent folder: Pi's login and MCP sign-in tokens. */
const AGENT_SECRETS = ["auth.json", "mcp-auth.json"];

/** Inside the home folder. */
const HOME_SECRETS = [
    ".ssh",
    ".gnupg",
    ".password-store",
    ".aws",
    ".kube",
    ".azure",
    ".config/gcloud",
    ".config/gh",
    ".config/glab-cli",
    ".postman",
    ".docker/config.json",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
];

/** Where `gh`, `glab` and `gcloud` keep their files when `XDG_CONFIG_HOME` points elsewhere, and on Windows. */
const XDG_SECRETS = ["gh", "glab-cli", "gcloud"];
const APPDATA_SECRETS = ["GitHub CLI", "glab-cli", "gcloud"];

function flavour(platform: NodeJS.Platform | undefined): typeof path.posix {
    return (platform ?? process.platform) === "win32" ? path.win32 : path.posix;
}

/** `~` for the home folder, so a message does not spell out where the user lives. */
function abbreviate(absolute: string, home: string, pathApi: typeof path.posix): string {
    if (home === "") return absolute;
    const relative = pathApi.relative(home, absolute);
    if (relative === "") return "~";
    if (relative.startsWith("..") || pathApi.isAbsolute(relative)) return absolute;
    return `~/${relative.split(pathApi.sep).join("/")}`;
}

function entry(
    absolute: string,
    kind: ProtectedKind,
    source: ProtectedSource,
    home: string,
    pathApi: typeof path.posix,
): ProtectedPath {
    return { path: absolute, shown: abbreviate(absolute, home, pathApi), kind, source };
}

/** What is protected without any configuration. */
export function defaultProtectedPaths(input: DefaultsInput): ProtectedPath[] {
    const pathApi = flavour(input.platform);
    const { home, agentDir } = input;
    const make = (absolute: string, kind: ProtectedKind) => entry(absolute, kind, "default", home, pathApi);
    const out: ProtectedPath[] = [];

    if (agentDir !== "") {
        for (const name of AGENT_SECRETS) out.push(make(pathApi.join(agentDir, name), "secret"));
    }
    if (home !== "") for (const name of HOME_SECRETS) out.push(make(pathApi.join(home, ...name.split("/")), "secret"));

    const xdg = input.env?.XDG_CONFIG_HOME;
    if (xdg !== undefined && pathApi.isAbsolute(xdg)) {
        for (const name of XDG_SECRETS) out.push(make(pathApi.join(xdg, name), "secret"));
    }
    const appData = input.env?.APPDATA;
    if (pathApi === path.win32 && appData !== undefined && pathApi.isAbsolute(appData)) {
        for (const name of APPDATA_SECRETS) out.push(make(pathApi.join(appData, name), "secret"));
    }
    // Last, so a message about a file inside it names the more specific secret entry first.
    if (agentDir !== "") out.push(make(agentDir, "guarded"));
    return dedupe(out, input.platform);
}

/** `~`, `~/x` or an absolute path, made absolute. Anything else is a relative path, which has no meaning in a list of
 *  protected paths and is refused when the file is read. */
export function expandProtected(text: string, home: string, platform?: NodeJS.Platform): string | undefined {
    const pathApi = flavour(platform);
    if (text === "~") return home === "" ? undefined : home;
    if (text.startsWith("~/") || (pathApi === path.win32 && text.startsWith("~\\"))) {
        return home === "" ? undefined : pathApi.join(home, text.slice(2));
    }
    return pathApi.isAbsolute(text) ? pathApi.resolve(text) : undefined;
}

/** True when `text` is a path a configuration may list: `~`, `~/...` or absolute. */
export function isListablePath(text: string): boolean {
    const home = text === "~" || text.startsWith("~/") || (path.sep === "\\" && text.startsWith("~\\"));
    return home || path.isAbsolute(text);
}

/** Adds entries from configuration after the defaults. A path that is already listed keeps its first (default or
 *  earlier) entry, except that `secret` beats `guarded` for the same path. */
export function mergeProtected(
    base: readonly ProtectedPath[],
    additions: readonly ProtectedPath[],
    platform?: NodeJS.Platform,
): ProtectedPath[] {
    return dedupe([...base, ...additions], platform);
}

function dedupe(list: readonly ProtectedPath[], platform: NodeJS.Platform | undefined): ProtectedPath[] {
    const seen = new Map<string, ProtectedPath>();
    for (const item of list) {
        const key = comparable(item.path, platform);
        const kept = seen.get(key);
        if (kept === undefined || (kept.kind === "guarded" && item.kind === "secret")) seen.set(key, item);
    }
    return [...seen.values()];
}

// ---- resolving a path ---------------------------------------------------------------------------------------------

const UNICODE_SPACES = /[  -   　]/g;

/** Git Bash, MSYS, Cygwin and WSL drive paths in a form native Windows accepts, as Pi does for its own tools. */
function windowsShellPath(text: string): string {
    if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return text;
    const match = text.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match === null) return text;
    return `${match[1]?.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** The path as Pi's own tools read it: a leading `@` dropped, unusual spaces made plain, `~` expanded, a `file:` address
 *  turned into a path, and a relative path started from Pi's working folder. `folded` has its `..` folded away the way
 *  Pi does before it opens a file; `unfolded` keeps them, for the system's own reading of a `..` that follows a link. */
function lexical(
    raw: string,
    cwd: string,
    home: string,
    platform: NodeJS.Platform | undefined,
): { folded: string; unfolded: string } {
    const pathApi = flavour(platform);
    let text = raw.replace(UNICODE_SPACES, " ");
    if (text.startsWith("@")) text = text.slice(1);
    if (pathApi === path.win32) text = windowsShellPath(text);
    if (text === "~") text = home;
    else if (text.startsWith("~/") || (pathApi === path.win32 && text.startsWith("~\\"))) {
        text = pathApi.join(home, text.slice(2));
    }
    if (/^file:\/\//.test(text)) text = fileURLToPath(text);
    const absolute = pathApi.isAbsolute(text);
    return {
        folded: absolute ? pathApi.resolve(text) : pathApi.resolve(cwd, text),
        unfolded: absolute ? text : `${cwd}${pathApi.sep}${text}`,
    };
}

/** Most links followed before a path is given up on. Linux stops at 40. */
const MAX_LINKS = 40;

/**
 * The path with every symlink followed, including links whose target does not exist (a write through a dangling link
 * creates the target). Components that do not exist are kept as written: they are what a write would create.
 */
function followLinks(absolute: string, platform: NodeJS.Platform | undefined): string {
    const pathApi = flavour(platform);
    const root = pathApi.parse(absolute).root;
    let pending = absolute.slice(root.length).split(/[\\/]+/);
    let current = root;
    let links = 0;
    while (pending.length > 0) {
        const part = pending.shift() as string;
        if (part === "" || part === ".") continue;
        if (part === "..") {
            current = pathApi.dirname(current);
            continue;
        }
        const next = pathApi.join(current, part);
        let isLink = false;
        try {
            isLink = lstatSync(next).isSymbolicLink();
        } catch {
            // Not there (or cannot be looked at): the rest is what a write would create, so it stays as written.
            return pathApi.resolve(next, ...pending);
        }
        if (!isLink) {
            current = next;
            continue;
        }
        if (++links > MAX_LINKS) return pathApi.resolve(next, ...pending);
        let target: string;
        try {
            target = readlinkSync(next);
        } catch {
            return pathApi.resolve(next, ...pending);
        }
        if (pathApi.isAbsolute(target)) {
            current = pathApi.parse(target).root;
            pending = [...target.slice(current.length).split(/[\\/]+/), ...pending];
        } else {
            pending = [...target.split(/[\\/]+/), ...pending];
        }
    }
    return current;
}

/** The form paths are compared in: lower case on systems that ignore case, with accents in one fixed form. */
function comparable(absolute: string, platform: NodeJS.Platform | undefined): string {
    const system = platform ?? process.platform;
    return system === "win32" || system === "darwin" ? absolute.normalize("NFC").toLowerCase() : absolute;
}

function isInside(child: string, parent: string, sep: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// ---- the check ----------------------------------------------------------------------------------------------------

/** Every form a path can be reached by: as written once folded, and with its links followed. `unfolded` is the same
 *  path with its `..` still in place, which the system reads differently when a link comes before one. */
function formsOf(folded: string, platform: NodeJS.Platform | undefined, unfolded: string = folded): string[] {
    const forms = new Set([comparable(folded, platform)]);
    forms.add(comparable(followLinks(folded, platform), platform));
    if (unfolded !== folded) forms.add(comparable(followLinks(unfolded, platform), platform));
    return [...forms];
}

type Relation = "inside" | "contains";

/** The first entry of the wanted kinds that `target` is inside, or that `target` contains. Secret entries are tried
 *  before guarded ones, so a message names the more precise reason. */
function find(
    targetForms: readonly string[],
    entries: ReadonlyArray<{ item: ProtectedPath; forms: readonly string[] }>,
    kinds: readonly ProtectedKind[],
    relation: Relation,
    sep: string,
): ProtectedPath | undefined {
    for (const kind of kinds) {
        for (const { item, forms } of entries) {
            if (item.kind !== kind) continue;
            for (const wanted of forms) {
                for (const have of targetForms) {
                    if (relation === "inside" ? isInside(have, wanted, sep) : isInside(wanted, have, sep)) return item;
                }
            }
        }
    }
    return undefined;
}

const SECRET: readonly ProtectedKind[] = ["secret"];
const ANY: readonly ProtectedKind[] = ["secret", "guarded"];

/**
 * What stops a call to one of Pi's file tools, or undefined when nothing does.
 *   read       refused inside a secret path;
 *   grep       refused inside a secret path, and when the folder it searches contains one;
 *   find, ls   refused inside a secret path (names only, so an ancestor is fine);
 *   write      refused inside a secret or guarded path;
 *   edit       the same as write.
 * A path parameter that is not text is refused: it cannot be matched, and Pi's validation would have refused it first.
 */
export function checkFileTool(
    tool: string,
    input: Readonly<Record<string, unknown>>,
    context: CheckContext,
): Refusal | undefined {
    if (!FILE_TOOLS.has(tool)) return undefined;
    const given = input.path;
    const searches = tool === "grep" || tool === "find" || tool === "ls";
    if (given === undefined || given === null) {
        // Pi searches or lists the working folder without a path; a call to read, write or edit needs one, and Pi
        // refuses it for lack of one.
        if (!searches) return undefined;
    } else if (typeof given !== "string") {
        return { reason: `${tool} is refused: its path is not text` };
    }
    const target = lexical(typeof given === "string" ? given : ".", context.cwd, context.home, context.platform);
    const targetForms = formsOf(target.folded, context.platform, target.unfolded);
    const entries = context.entries.map((item) => ({ item, forms: formsOf(item.path, context.platform) }));
    const sep = flavour(context.platform).sep;

    const refuse = (item: ProtectedPath, reason: string): Refusal => ({
        reason: `${tool} is refused: ${reason}`,
        entry: item,
    });
    const secret = (item: ProtectedPath) =>
        refuse(item, `${item.shown} holds credentials, so the file tools neither read nor write it`);

    if (tool === "write" || tool === "edit") {
        const hit = find(targetForms, entries, ANY, "inside", sep);
        if (hit === undefined) return undefined;
        return hit.kind === "secret"
            ? secret(hit)
            : refuse(hit, `${hit.shown} is guarded: the file tools can read it but not write it`);
    }
    const inside = find(targetForms, entries, SECRET, "inside", sep);
    if (inside !== undefined) return secret(inside);
    if (tool === "grep") {
        const holds = find(targetForms, entries, SECRET, "contains", sep);
        if (holds !== undefined) {
            return refuse(
                holds,
                `the folder to search contains ${holds.shown}, which holds credentials; search a narrower folder`,
            );
        }
    }
    return undefined;
}
