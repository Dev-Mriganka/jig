// Configuration: the personal file `<Pi agent folder>/jig.json`, and what company plugins add at start-up.
//
// Three rules shape this module:
// - An error in the file never makes the plugin guess. An unknown field, a wrong type or a bad value is an error
//   that names the file and the key, and the plugin then starts with the defaults.
// - Nothing in configuration can lower the floor. A rule that would is refused with the file and key named, and
//   the rest of the file still loads. (`decide.ts` applies the floor again for every call, so a refused rule could
//   not have worked anyway; refusing it tells the user why it does nothing.)
// - The file is shared. Each other plugin keeps its settings in a section of its own (`git`, `lens`, ...) that it
//   registers, together with a check. A top-level key that is neither jig-core's nor registered is an unknown field.
//   A section that fails its check is lost on its own: the plugin uses its defaults, and jig-core's settings stay.
// - A company plugin may give defaults for a plugin's section. The user's section is then checked laid over them, so a
//   user writes only what they change; with no section of their own, the defaults must pass the check alone, and when
//   they do not (a field only the user can give) the plugin is simply not configured and `/jig` says why.
import { readFileSync } from "node:fs";
import { matchesName } from "./classify.ts";
import { namesOutsideCommand } from "./decide.ts";
import { errorMessage } from "./errors.ts";
import { isObject } from "./kit/values.ts";
import { buildEnvironments } from "./environments.ts";
import type { Environments } from "./environments.ts";
import type { ApprovalKind, ClassifyRule, Decision, Effect, EnvironmentConfig, Rule } from "./contract.ts";
import { expandProtected, isListablePath, mergeProtected } from "./protected-paths.ts";
import type { ProtectedPath, ProtectedSource } from "./protected-paths.ts";
import { layered } from "./section-defaults.ts";

/** The secret backends jig-core can resolve. `secrets.backends` chooses which of them are allowed. */
export const SECRET_BACKENDS = ["pass", "env", "keychain", "op", "cmd", "file"] as const;
export type SecretBackend = (typeof SECRET_BACKENDS)[number];

/** Something wrong in configuration: where it is, which key, and what is wrong. */
export interface Problem {
    /** The file, or `company` for what a company plugin added. */
    source: string;
    /** The key, such as `rules[2].decision`. */
    key: string;
    message: string;
}

export function describeProblem(problem: Problem): string {
    return `${problem.source}: ${problem.key}: ${problem.message}`;
}

/** Paths to add to the protected ones, as written: absolute, or starting with `~/`. */
export interface ProtectedPathLists {
    secret: string[];
    guarded: string[];
}

export interface JigConfig {
    environments: Record<string, EnvironmentConfig>;
    rules: Rule[];
    classify: ClassifyRule[];
    protectedPaths: ProtectedPathLists;
    secrets: { backends: SecretBackend[]; disabledBackends: SecretBackend[]; commands: Record<string, string[]> };
    records: { retentionDays: number };
    spill: { retentionDays: number };
}

export function defaultConfig(): JigConfig {
    return {
        environments: {},
        rules: [],
        classify: [],
        protectedPaths: { secret: [], guarded: [] },
        secrets: { backends: ["pass"], disabledBackends: [], commands: {} },
        records: { retentionDays: 90 },
        spill: { retentionDays: 7 },
    };
}

/** The top-level keys of the file that jig-core owns. A plugin cannot register a section under one of these names. */
export const OWN_SECTIONS: readonly string[] = [
    "environments",
    "rules",
    "classify",
    "protectedPaths",
    "secrets",
    "records",
    "spill",
];

/** A plugin's check of its own section: error messages that name the key, or an empty list when it is fine. */
export type SectionCheck = (raw: unknown) => readonly string[];

/** What a plugin's section is laid over, and where yours replaces instead of merging (see section-defaults.ts). */
export interface SectionLayers {
    /** The company's defaults, by section name. */
    defaults: ReadonlyMap<string, unknown>;
    /** The paths whose object of yours replaces the company's whole, by section name. */
    replace: ReadonlyMap<string, readonly string[]>;
    /** Per section, lists of paths that exclude each other; see `layered`. */
    oneOf?: ReadonlyMap<string, readonly (readonly string[])[]>;
    /** Per section, the paths of lists that add up: the company's entries first, then yours. */
    union?: ReadonlyMap<string, readonly string[]>;
}

const NO_LAYERS: SectionLayers = { defaults: new Map(), replace: new Map() };

const MAX_MESSAGE_CHARS = 300;

// ---- reading the file --------------------------------------------------------------------------------------------

export interface LoadedConfig {
    file: string;
    /** False when there is no file; the defaults apply and that is not an error. */
    found: boolean;
    config: JigConfig;
    problems: Problem[];
    /** The plugin sections that passed their checks, by name: yours, laid over the company's defaults when it gave some,
     *  or the company's defaults alone when you have no section and they pass on their own. */
    sections: Map<string, unknown>;
    /** Plugin sections that you have not written and whose company defaults are not valid alone, with the messages of
     *  the check: the plugin is not configured until you add your part. Not a problem, only a fact for `/jig`. */
    incomplete: Map<string, string[]>;
    /** Plugin sections the file has and the plugin does not get, because they failed their check. A section the file
     *  does not have is not here: it is simply not set. */
    invalid: Set<string>;
}

/** Reads and checks the file. Never throws: every failure becomes a problem, and the defaults apply. `checks` holds the
 *  sections plugins registered, by name, and `layers` what a company plugin gave them. */
export function loadConfigFile(
    file: string,
    checks: ReadonlyMap<string, SectionCheck> = new Map(),
    layers: SectionLayers = NO_LAYERS,
): LoadedConfig {
    const failed = (problems: Problem[], found = true): LoadedConfig => ({
        file,
        found,
        config: defaultConfig(),
        problems,
        invalid: new Set(),
        // A file that cannot be read still leaves the company's defaults.
        ...companyOnly(checks, layers, new Set()),
    });
    let text: string;
    try {
        // A byte-order mark, which some editors add, is not part of the JSON.
        text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return failed([], false);
        return failed([{ source: file, key: "(file)", message: `cannot read the file (${code ?? "error"})` }]);
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        // JSON.parse messages can quote the text, so say only that it is not valid.
        return failed([{ source: file, key: "(file)", message: "is not valid JSON" }]);
    }
    return { file, found: true, ...parseConfig(value, file, checks, layers) };
}

/**
 * Checks parsed JSON. A problem in jig-core's own settings means the defaults for all of them, with every problem
 * listed. A plugin's section is checked on its own: if it fails, only that section is lost.
 */
export function parseConfig(
    value: unknown,
    source: string,
    checks: ReadonlyMap<string, SectionCheck> = new Map(),
    layers: SectionLayers = NO_LAYERS,
): {
    config: JigConfig;
    problems: Problem[];
    sections: Map<string, unknown>;
    incomplete: Map<string, string[]>;
    invalid: Set<string>;
} {
    const problems: Problem[] = [];
    const fail: Fail = (key, message) => problems.push({ source, key, message });
    const sectionProblems: Problem[] = [];
    const sections = new Map<string, unknown>();
    const invalid = new Set<string>();
    const config = defaultConfig();

    if (!isObject(value)) {
        fail("(file)", "must hold one JSON object");
        return { config, problems, invalid, ...companyOnly(checks, layers, new Set()) };
    }
    const written = new Set<string>();
    for (const [key, raw] of Object.entries(value)) {
        if (OWN_SECTIONS.includes(key)) continue;
        const check = checks.get(key);
        if (check === undefined) {
            fail(printable(key), "is not a known field");
            continue;
        }
        written.add(key);
        const read = readSection(key, raw, check, layers);
        if (read.use) sections.set(key, read.value);
        else invalid.add(key);
        for (const message of read.messages) sectionProblems.push({ source, key: printable(key), message });
    }
    const company = companyOnly(checks, layers, written);
    for (const [key, section] of company.sections) sections.set(key, section);
    if (value.environments !== undefined)
        config.environments = parseEnvironments(value.environments, "environments", fail);
    if (value.rules !== undefined) config.rules = parseRules(value.rules, "rules", fail);
    if (value.classify !== undefined) config.classify = parseClassifyRules(value.classify, "classify", fail);
    if (value.protectedPaths !== undefined)
        config.protectedPaths = parseProtectedPaths(value.protectedPaths, "protectedPaths", fail);
    if (value.secrets !== undefined) config.secrets = parseSecrets(value.secrets, fail);
    if (value.records !== undefined) config.records = parseRetention(value.records, "records", fail, config.records);
    if (value.spill !== undefined) config.spill = parseRetention(value.spill, "spill", fail, config.spill);

    return {
        config: problems.length === 0 ? config : defaultConfig(),
        problems: [...problems, ...sectionProblems],
        sections,
        incomplete: company.incomplete,
        invalid,
    };
}

/** What a section of the file comes to: its value, whether the plugin gets it, and what is wrong with it. */
interface SectionRead {
    value: unknown;
    use: boolean;
    messages: string[];
}

/**
 * Checks a section the user wrote. With company defaults it is checked laid over them, so the user writes only what
 * they change; a section nobody gave defaults for is checked as it is. When the two do not fit and the section is
 * complete without the defaults, it is used as written (the mismatch is still said); otherwise the plugin gets nothing.
 */
function readSection(name: string, raw: unknown, check: SectionCheck, layers: SectionLayers): SectionRead {
    if (!layers.defaults.has(name)) {
        const messages = runSectionCheck(check, raw);
        return { value: raw, use: messages.length === 0, messages };
    }
    const merged = layered(
        layers.defaults.get(name),
        raw,
        layers.replace.get(name),
        layers.oneOf?.get(name),
        layers.union?.get(name),
    );
    const messages = runSectionCheck(check, merged);
    if (messages.length === 0) return { value: merged, use: true, messages };
    const said = `the company defaults for "${printable(name)}", with your settings laid over them, are not valid: `;
    const alone = runSectionCheck(check, raw).length === 0;
    const why = `${said}${messages.join("; ")}${alone ? " (your own section is used as you wrote it)" : ""}`;
    return { value: raw, use: alone, messages: [why.slice(0, 2 * MAX_MESSAGE_CHARS)] };
}

/**
 * The sections for which the user wrote nothing, and a company plugin gave defaults: the defaults alone, when they pass
 * the plugin's check. When they do not (a field only the user can give), the plugin is not configured, and that is not
 * an error: `incomplete` says so, for `/jig`. `written` names the sections the file has.
 */
function companyOnly(
    checks: ReadonlyMap<string, SectionCheck>,
    layers: SectionLayers,
    written: ReadonlySet<string>,
): { sections: Map<string, unknown>; incomplete: Map<string, string[]> } {
    const sections = new Map<string, unknown>();
    const incomplete = new Map<string, string[]>();
    for (const [name, defaults] of layers.defaults) {
        if (written.has(name)) continue;
        const check = checks.get(name);
        // Nobody registered the section, so there is nothing to check it by.
        const messages = check === undefined ? [] : runSectionCheck(check, defaults);
        if (messages.length === 0) sections.set(name, defaults);
        else incomplete.set(name, messages);
    }
    return { sections, incomplete };
}

/** Runs a plugin's check. The check is code from another package: whatever it does, the result is a list of messages. */
function runSectionCheck(check: SectionCheck, raw: unknown): string[] {
    try {
        const messages: unknown = check(raw);
        if (!Array.isArray(messages)) return ["the plugin's check did not return a list of messages"];
        return messages.map((message) =>
            String(message)
                .replace(/[\u0000-\u001f\u007f]/g, "?")
                .slice(0, MAX_MESSAGE_CHARS),
        );
    } catch (error) {
        return [`the plugin's check failed: ${errorMessage(error)}`];
    }
}

// ---- checking one section ----------------------------------------------------------------------------------------

type Fail = (key: string, message: string) => void;

/** A key name is shown, never its value: strip control characters and cap the length. */
function printable(name: string): string {
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, "?");
    return clean.length > 64 ? `${clean.slice(0, 64)}...` : clean;
}

const at = (path: string, key: string): string => `${path}.${printable(key)}`;

function knownFields(object: Record<string, unknown>, allowed: readonly string[], path: string, fail: Fail): void {
    for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(at(path, key), "is not a known field");
}

function text(
    object: Record<string, unknown>,
    key: string,
    path: string,
    fail: Fail,
    required: boolean,
): string | undefined {
    const value = object[key];
    if (value === undefined) {
        if (required) fail(at(path, key), "is required");
        return undefined;
    }
    if (typeof value !== "string" || value === "") {
        fail(at(path, key), "must be a non-empty string");
        return undefined;
    }
    return value;
}

function choice<T extends string>(
    object: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
    path: string,
    fail: Fail,
    required: boolean,
): T | undefined {
    const value = object[key];
    if (value === undefined) {
        if (required) fail(at(path, key), `is required: ${allowed.join(", ")}`);
        return undefined;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        fail(at(path, key), `must be one of ${allowed.join(", ")}`);
        return undefined;
    }
    return value as T;
}

const DECISIONS: readonly Decision[] = ["allow", "ask", "deny"];
const EFFECTS: readonly Effect[] = ["read", "write"];
const APPROVALS: readonly ApprovalKind[] = ["dialog", "review", "form"];

export function parseEnvironments(raw: unknown, path: string, fail: Fail): Record<string, EnvironmentConfig> {
    const out: Record<string, EnvironmentConfig> = {};
    if (!isObject(raw)) {
        fail(path, "must be an object of environment names");
        return out;
    }
    for (const [name, entry] of Object.entries(raw)) {
        const here = at(path, name);
        if (name === "") {
            fail(path, "an environment needs a name");
            continue;
        }
        if (!isObject(entry)) {
            fail(here, "must be an object with a kind");
            continue;
        }
        knownFields(entry, ["kind", "mask"], here, fail);
        const kind = choice(entry, "kind", ["test", "production"] as const, here, fail, true);
        const mask = entry.mask;
        if (mask !== undefined && typeof mask !== "boolean") fail(at(here, "mask"), "must be true or false");
        else if (kind === "production" && mask === false)
            fail(at(here, "mask"), "production masking cannot be turned off");
        if (kind !== undefined) out[name] = mask === undefined || typeof mask !== "boolean" ? { kind } : { kind, mask };
    }
    return out;
}

export function parseRules(raw: unknown, path: string, fail: Fail): Rule[] {
    if (!Array.isArray(raw)) {
        fail(path, "must be a list of rules");
        return [];
    }
    const rules: Rule[] = [];
    raw.forEach((item, index) => {
        const here = `${path}[${index}]`;
        let valid = true;
        const bad: Fail = (key, message) => {
            valid = false;
            fail(key, message);
        };
        if (!isObject(item)) {
            bad(here, "must be an object");
            return;
        }
        knownFields(item, ["tool", "action", "environment", "effect", "command", "decision", "approval"], here, bad);
        const tool = text(item, "tool", here, bad, true);
        const action = text(item, "action", here, bad, false);
        const environment = text(item, "environment", here, bad, false);
        const effect = choice(item, "effect", EFFECTS, here, bad, false);
        const command = text(item, "command", here, bad, false);
        const decision = choice(item, "decision", DECISIONS, here, bad, true);
        const approval = choice(item, "approval", APPROVALS, here, bad, false);
        if (valid && tool !== undefined && decision !== undefined) {
            rules.push({
                tool,
                decision,
                ...(action === undefined ? {} : { action }),
                ...(environment === undefined ? {} : { environment }),
                ...(effect === undefined ? {} : { effect }),
                ...(command === undefined ? {} : { command }),
                ...(approval === undefined ? {} : { approval }),
            });
        }
    });
    return rules;
}

export function parseClassifyRules(raw: unknown, path: string, fail: Fail): ClassifyRule[] {
    if (!Array.isArray(raw)) {
        fail(path, "must be a list of classification rules");
        return [];
    }
    const rules: ClassifyRule[] = [];
    raw.forEach((item, index) => {
        const here = `${path}[${index}]`;
        let valid = true;
        const bad: Fail = (key, message) => {
            valid = false;
            fail(key, message);
        };
        if (!isObject(item)) {
            bad(here, "must be an object");
            return;
        }
        knownFields(item, ["tool", "action", "param", "value", "pattern", "environment", "effect"], here, bad);
        const tool = text(item, "tool", here, bad, true);
        const action = text(item, "action", here, bad, false);
        const param = text(item, "param", here, bad, true);
        const value = text(item, "value", here, bad, false);
        const pattern = text(item, "pattern", here, bad, false);
        const environment = text(item, "environment", here, bad, true);
        const effect = choice(item, "effect", EFFECTS, here, bad, true);
        if (item.value === undefined && item.pattern === undefined)
            bad(here, "needs a value or a pattern for the parameter");
        else if (item.value !== undefined && item.pattern !== undefined)
            bad(here, "takes a value or a pattern, not both");
        if (pattern !== undefined) {
            try {
                new RegExp(pattern);
            } catch {
                bad(at(here, "pattern"), "is not a valid regular expression");
            }
        }
        if (valid && tool !== undefined && param !== undefined && environment !== undefined && effect !== undefined) {
            rules.push({
                tool,
                param,
                environment,
                effect,
                ...(action === undefined ? {} : { action }),
                ...(value === undefined ? {} : { value }),
                ...(pattern === undefined ? {} : { pattern }),
            });
        }
    });
    return rules;
}

/** The longest list and the longest path accepted: more is a mistake, not a configuration. */
const MAX_PROTECTED_ENTRIES = 200;
const MAX_PROTECTED_PATH_CHARS = 1024;

/** `{ secret: [...], guarded: [...] }`. Each path is absolute or starts with `~/`; a relative one has no meaning here. */
export function parseProtectedPaths(raw: unknown, path: string, fail: Fail): ProtectedPathLists {
    const out: ProtectedPathLists = { secret: [], guarded: [] };
    if (!isObject(raw)) {
        fail(path, "must be an object with lists of paths: secret and guarded");
        return out;
    }
    knownFields(raw, ["secret", "guarded"], path, fail);
    for (const kind of ["secret", "guarded"] as const) {
        const list = raw[kind];
        if (list === undefined) continue;
        const here = at(path, kind);
        if (!Array.isArray(list)) {
            fail(here, "must be a list of paths");
            continue;
        }
        if (list.length > MAX_PROTECTED_ENTRIES) {
            fail(here, `lists more than ${MAX_PROTECTED_ENTRIES} paths`);
            continue;
        }
        list.forEach((item, index) => {
            const key = `${here}[${index}]`;
            if (typeof item !== "string" || item === "" || item.length > MAX_PROTECTED_PATH_CHARS) {
                fail(key, `must be a path of up to ${MAX_PROTECTED_PATH_CHARS} characters`);
            } else if (/[\u0000-\u001f\u007f]/.test(item)) {
                fail(key, "must not hold control characters");
            } else if (!isListablePath(item)) {
                fail(key, "must be an absolute path, or start with ~/");
            } else out[kind].push(item);
        });
    }
    return out;
}

/** What a secret command is called: a word that a reference `cmd:<name>` can hold. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_COMMAND_WORDS = 32;
const MAX_COMMAND_WORD_CHARS = 1024;

/** `{ "gh": ["gh", "auth", "token"] }`: each name stands for one program and its arguments, run without a shell. */
export function parseSecretCommands(raw: unknown, path: string, fail: Fail): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!isObject(raw)) {
        fail(path, "must be an object that maps a command name to a list: the program, then its arguments");
        return out;
    }
    for (const [name, words] of Object.entries(raw)) {
        const here = at(path, name);
        if (!COMMAND_NAME.test(name)) {
            fail(here, "is not a command name: use letters, digits and . _ - (up to 64)");
        } else if (!Array.isArray(words) || words.length === 0 || words.length > MAX_COMMAND_WORDS) {
            fail(here, `must be a list of 1 to ${MAX_COMMAND_WORDS} words: the program, then its arguments`);
        } else if (
            words.some((word) => typeof word !== "string" || word === "" || word.length > MAX_COMMAND_WORD_CHARS) ||
            words.some((word) => /[\u0000-\u001f\u007f]/.test(word as string))
        ) {
            fail(here, "must hold only non-empty text words without control characters");
        } else {
            out[name] = words as string[];
        }
    }
    return out;
}

function parseBackendList(raw: unknown, path: string, fail: Fail): SecretBackend[] | undefined {
    if (!Array.isArray(raw)) {
        fail(path, `must be a list of ${SECRET_BACKENDS.join(", ")}`);
        return undefined;
    }
    const backends: SecretBackend[] = [];
    raw.forEach((name, index) => {
        if (typeof name === "string" && (SECRET_BACKENDS as readonly string[]).includes(name))
            backends.push(name as SecretBackend);
        else fail(`${path}[${index}]`, `must be one of ${SECRET_BACKENDS.join(", ")}`);
    });
    return backends;
}

function parseSecrets(raw: unknown, fail: Fail): JigConfig["secrets"] {
    const out: JigConfig["secrets"] = { backends: ["pass"], disabledBackends: [], commands: {} };
    if (!isObject(raw)) {
        fail("secrets", "must be an object");
        return out;
    }
    knownFields(raw, ["backends", "disabledBackends", "commands"], "secrets", fail);
    if (raw.commands !== undefined) out.commands = parseSecretCommands(raw.commands, "secrets.commands", fail);
    if (raw.backends !== undefined)
        out.backends = parseBackendList(raw.backends, "secrets.backends", fail) ?? out.backends;
    if (raw.disabledBackends !== undefined)
        out.disabledBackends = parseBackendList(raw.disabledBackends, "secrets.disabledBackends", fail) ?? [];
    return out;
}

/**
 * The secret backends that may resolve a reference: yours (`pass` alone when you list none), and the ones company plugins
 * enabled, less the ones you turned off. Your `disabledBackends` has the last word, so nothing a plugin does can turn on a
 * backend that you switched off.
 */
export function effectiveBackends(
    secrets: Pick<JigConfig["secrets"], "backends" | "disabledBackends">,
    company: Pick<CompanyAdditions, "secretBackends">,
): { on: SecretBackend[]; byCompany: SecretBackend[]; off: SecretBackend[] } {
    const off = secrets.disabledBackends;
    const on = [...new Set([...secrets.backends, ...company.secretBackends])].filter((name) => !off.includes(name));
    const byCompany = company.secretBackends.filter((name) => on.includes(name) && !secrets.backends.includes(name));
    return { on, byCompany: [...new Set(byCompany)], off: [...off] };
}

function parseRetention(
    raw: unknown,
    path: string,
    fail: Fail,
    fallback: { retentionDays: number },
): { retentionDays: number } {
    if (!isObject(raw)) {
        fail(path, "must be an object");
        return fallback;
    }
    knownFields(raw, ["retentionDays"], path, fail);
    const days = raw.retentionDays;
    if (days === undefined) return fallback;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
        fail(at(path, "retentionDays"), "must be a whole number of days from 1 to 3650");
        return fallback;
    }
    return { retentionDays: days };
}

// ---- what company plugins add ------------------------------------------------------------------------------------

/** What company plugins added through `JigApi.config`, as checked by the same code as the personal file. */
export interface CompanyAdditions {
    environments: Record<string, EnvironmentConfig>;
    rules: Rule[];
    classify: ClassifyRule[];
    protectedPaths: ProtectedPathLists;
    /** Commands for `cmd:<name>` secret references that company plugins declared. */
    secretCommands: Record<string, string[]>;
    /** Secret backends company plugins turned on. Your `secrets.disabledBackends` still turns any of them off. */
    secretBackends: SecretBackend[];
    problems: Problem[];
    /** How many rules came in so far, valid or not, so a problem names a stable position. */
    received: { rules: number; classify: number };
}

export function emptyAdditions(): CompanyAdditions {
    return {
        environments: {},
        rules: [],
        classify: [],
        protectedPaths: { secret: [], guarded: [] },
        secretCommands: {},
        secretBackends: [],
        problems: [],
        received: { rules: 0, classify: 0 },
    };
}

const COMPANY = "company";

/** Keeps the valid entries and records a problem for each invalid one. A company plugin's mistake is shown, not
 *  thrown into the plugin that is loading. */
export function addCompanyEnvironments(additions: CompanyAdditions, raw: unknown): void {
    const fail: Fail = (key, message) => additions.problems.push({ source: COMPANY, key, message });
    for (const [name, config] of Object.entries(parseEnvironments(raw, "environments", fail))) {
        const before = additions.environments[name];
        // Two company plugins naming the same environment: production wins and a mask stays on, as everywhere else.
        additions.environments[name] =
            before === undefined
                ? config
                : {
                      kind: before.kind === "production" || config.kind === "production" ? "production" : "test",
                      ...(before.mask === true || config.mask === true ? { mask: true } : {}),
                  };
    }
}

export function addCompanyRules(additions: CompanyAdditions, raw: unknown): void {
    const offset = additions.received.rules;
    const fail: Fail = (key, message) =>
        additions.problems.push({ source: COMPANY, key: shiftIndex(key, "rules", offset), message });
    additions.rules.push(...parseRules(raw, "rules", fail));
    additions.received.rules += Array.isArray(raw) ? raw.length : 0;
}

export function addCompanyClassifyRules(additions: CompanyAdditions, raw: unknown): void {
    const offset = additions.received.classify;
    const fail: Fail = (key, message) =>
        additions.problems.push({ source: COMPANY, key: shiftIndex(key, "classify", offset), message });
    additions.classify.push(...parseClassifyRules(raw, "classify", fail));
    additions.received.classify += Array.isArray(raw) ? raw.length : 0;
}

/** Paths a company plugin adds to the protected ones. Only additions: there is no way to take one away. */
export function addCompanyProtectedPaths(additions: CompanyAdditions, raw: unknown): void {
    const fail: Fail = (key, message) => additions.problems.push({ source: COMPANY, key, message });
    const added = parseProtectedPaths(raw, "protectedPaths", fail);
    additions.protectedPaths.secret.push(...added.secret);
    additions.protectedPaths.guarded.push(...added.guarded);
}

/** Commands a company plugin declares for `cmd:<name>` references. A later declaration of a name replaces an earlier
 *  one; the user's own `secrets.commands` replaces both. */
export function addCompanySecretCommands(additions: CompanyAdditions, raw: unknown): void {
    const fail: Fail = (key, message) => additions.problems.push({ source: COMPANY, key, message });
    Object.assign(additions.secretCommands, parseSecretCommands(raw, "secretCommands", fail));
}

/** Backends a company plugin turns on. Each name is checked like one in `secrets.backends`; a wrong one is a problem and the
 *  good ones still apply. */
export function addCompanySecretBackends(additions: CompanyAdditions, raw: unknown): void {
    const fail: Fail = (key, message) => additions.problems.push({ source: COMPANY, key, message });
    for (const name of parseBackendList(raw, "secretBackends", fail) ?? [])
        if (!additions.secretBackends.includes(name)) additions.secretBackends.push(name);
}

/** `rules[1].tool` becomes `rules[4].tool` when three rules came before this call. */
function shiftIndex(key: string, section: string, offset: number): string {
    return key.replace(
        new RegExp(`^${section}\\[(\\d+)\\]`),
        (_, index: string) => `${section}[${Number(index) + offset}]`,
    );
}

// ---- the policy: everything merged, with the floor applied ------------------------------------------------------------

/** What the manager decides with: the merged environments, rules and classification rules, and every problem found
 *  on the way. */
export interface Policy {
    environments: Environments;
    /** Personal rules first, then the company's: the first match decides, so the personal file wins. */
    rules: Rule[];
    classify: ClassifyRule[];
    /** What Pi's file tools may not touch: the defaults, then what the personal file and company plugins added. */
    protectedPaths: ProtectedPath[];
    problems: Problem[];
}

/** What the defaults and the system tell `buildPolicy` about protected paths. */
export interface ProtectedDefaults {
    entries: readonly ProtectedPath[];
    home: string;
    platform?: NodeJS.Platform;
}

/**
 * A reason why this rule would lower the floor, or undefined when it does not. The floor fixed here: production
 * writes are always denied. A rule that names a production environment and does not deny writes there would
 * allow or ask where the floor denies. A rule that names no environment is left alone: it covers production too,
 * but `decide.ts` applies the floor last, so it cannot change a production write.
 */
export function floorViolation(rule: Rule, environments: Environments): string | undefined {
    // A rule that tries to allow `bash` outside its sandbox must name the command. (A rule with no action leaves outside
    // alone: `decide.ts` keeps asking for it, so a general `bash` rule is still fine.)
    if (
        rule.decision === "allow" &&
        rule.action === "outside" &&
        matchesName(rule.tool, "bash") &&
        !namesOutsideCommand(rule)
    ) {
        return (
            'a rule can allow bash to run outside its sandbox only if it names the tool "bash", the action "outside" and a ' +
            'command pattern that names something, such as "docker compose *"; "allow" without them is refused'
        );
    }
    if (rule.decision === "deny" || rule.environment === undefined) return undefined;
    if (environments.kindOf(rule.environment) !== "production") return undefined;
    if (rule.effect === "read") return undefined;
    const why = environments.isKnown(rule.environment)
        ? `"${rule.environment}" is production`
        : `"${rule.environment}" is not a defined environment, so it counts as production`;
    return (
        `"${rule.decision}" would let this rule decide production writes, which are always denied (${why}); ` +
        `give the rule effect "read", or decision "deny"`
    );
}

/** The configured paths as entries. Added paths only ever extend the defaults. */
function addedProtected(
    lists: ProtectedPathLists,
    source: ProtectedSource,
    defaults: ProtectedDefaults,
): ProtectedPath[] {
    const out: ProtectedPath[] = [];
    for (const kind of ["secret", "guarded"] as const) {
        for (const text of lists[kind]) {
            const absolute = expandProtected(text, defaults.home, defaults.platform);
            if (absolute !== undefined) out.push({ path: absolute, shown: text, kind, source });
        }
    }
    return out;
}

export function buildPolicy(
    personal: LoadedConfig,
    company: CompanyAdditions,
    protectedDefaults: ProtectedDefaults = { entries: [], home: "" },
): Policy {
    const problems = [...personal.problems, ...company.problems];

    const merged = buildEnvironments([
        { source: COMPANY, origin: "company", environments: company.environments },
        { source: personal.file, origin: "personal", environments: personal.config.environments },
    ]);
    problems.push(...merged.problems);

    const rules: Rule[] = [];
    const keep = (source: string, list: readonly Rule[]) => {
        list.forEach((rule, index) => {
            const reason = floorViolation(rule, merged.environments);
            if (reason === undefined) rules.push(rule);
            else
                problems.push({
                    source,
                    key: `rules[${index}].decision`,
                    message: `${reason} (the rule for tool "${rule.tool}")`,
                });
        });
    };
    keep(personal.file, personal.config.rules);
    keep(COMPANY, company.rules);

    return {
        environments: merged.environments,
        rules,
        classify: [...personal.config.classify, ...company.classify],
        protectedPaths: mergeProtected(
            protectedDefaults.entries,
            [
                ...addedProtected(personal.config.protectedPaths, "personal", protectedDefaults),
                ...addedProtected(company.protectedPaths, "company", protectedDefaults),
            ],
            protectedDefaults.platform,
        ),
        problems,
    };
}
