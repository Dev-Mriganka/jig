// The `watch` and `artifacts` parts of the `ops` section: how often a CI watch polls and when it gives up, whether one
// starts by itself after a push, and the rules that say when "the artifact is ready". They were `git.watch` and
// `git.artifacts` while jig-git ran the watch; the watch moved here with CI, and so did the settings.
import { isObject } from "../values.ts";

/** One rule for "the artifact is ready". Exactly one of `check`, `comment` and `tag` says where to look. */
export interface ArtifactRule {
    /** What the event announces. */
    kind: "image" | "tag" | "release";
    /** The name of a job that must have succeeded for the head commit. */
    check?: string;
    /** With `check`: a regular expression for the job's log. Its first group, else the whole match, is the version. */
    log?: string;
    /** With `comment`: only comments by this login. Without it, comments by any bot. */
    bot?: string;
    /** A regular expression for the pull request's comments. Its first group, else the whole match, is the version. */
    comment?: string;
    /** A regular expression for the names of new tags (kind `tag`) or releases (kind `release`). */
    tag?: string;
}

export interface WatchSettings {
    /** Start a watch by itself after a push and after a pull request is opened. */
    auto: boolean;
    pollSeconds: number;
    stallMinutes: number;
    timeoutMinutes: number;
}

export const DEFAULT_WATCH: WatchSettings = { auto: true, pollSeconds: 30, stallMinutes: 30, timeoutMinutes: 60 };

const WATCH_FIELDS = new Set(["auto", "pollSeconds", "stallMinutes", "timeoutMinutes"]);
const RULE_FIELDS = new Set(["kind", "check", "log", "bot", "comment", "tag"]);
const KINDS = ["image", "tag", "release"];

function checkRegExp(value: unknown, key: string, errors: string[]): void {
    if (typeof value !== "string" || value === "") {
        errors.push(`${key}: must be a non-empty regular expression`);
        return;
    }
    try {
        new RegExp(value);
    } catch (error) {
        errors.push(`${key}: not a valid regular expression: ${(error as Error).message}`);
    }
}

function checkNumber(value: unknown, key: string, min: number, max: number, errors: string[]): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        errors.push(`${key}: must be a number from ${min} to ${max}`);
    }
}

/** Checks `ops.watch` and returns it with the defaults filled in. With errors the defaults come back. */
export function checkWatch(raw: unknown, errors: string[]): WatchSettings {
    if (raw === undefined) return DEFAULT_WATCH;
    if (!isObject(raw)) {
        errors.push("ops.watch: must be an object");
        return DEFAULT_WATCH;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!WATCH_FIELDS.has(key)) errors.push(`ops.watch.${key}: unknown field`);
    if (raw.auto !== undefined && typeof raw.auto !== "boolean") errors.push("ops.watch.auto: must be true or false");
    if (raw.pollSeconds !== undefined) checkNumber(raw.pollSeconds, "ops.watch.pollSeconds", 5, 3600, errors);
    if (raw.stallMinutes !== undefined) checkNumber(raw.stallMinutes, "ops.watch.stallMinutes", 1, 1440, errors);
    if (raw.timeoutMinutes !== undefined) checkNumber(raw.timeoutMinutes, "ops.watch.timeoutMinutes", 1, 1440, errors);
    return errors.length > before ? DEFAULT_WATCH : { ...DEFAULT_WATCH, ...(raw as Partial<WatchSettings>) };
}

function checkRule(rule: unknown, key: string, errors: string[]): void {
    if (!isObject(rule)) {
        errors.push(`${key}: must be an object`);
        return;
    }
    for (const field of Object.keys(rule)) if (!RULE_FIELDS.has(field)) errors.push(`${key}.${field}: unknown field`);
    if (typeof rule.kind !== "string" || !KINDS.includes(rule.kind)) {
        errors.push(`${key}.kind: must be one of ${KINDS.join(", ")}`);
    }
    const sources = ["check", "comment", "tag"].filter((name) => rule[name] !== undefined);
    if (sources.length !== 1) {
        const found = sources.length === 0 ? "none" : sources.join(", ");
        errors.push(`${key}: needs exactly one of check, comment and tag (found ${found})`);
    }
    if (rule.check !== undefined && (typeof rule.check !== "string" || rule.check === "")) {
        errors.push(`${key}.check: must be a job name`);
    }
    if (rule.log !== undefined) {
        checkRegExp(rule.log, `${key}.log`, errors);
        if (rule.check === undefined) errors.push(`${key}.log: needs check, it is read from that job's log`);
    }
    if (rule.comment !== undefined) checkRegExp(rule.comment, `${key}.comment`, errors);
    if (rule.bot !== undefined) {
        if (typeof rule.bot !== "string" || rule.bot === "") errors.push(`${key}.bot: must be a login`);
        if (rule.comment === undefined) errors.push(`${key}.bot: needs comment, it limits whose comments are read`);
    }
    if (rule.tag !== undefined) {
        checkRegExp(rule.tag, `${key}.tag`, errors);
        if (rule.kind === "image") errors.push(`${key}.tag: names tags or releases, so kind must be tag or release`);
    }
}

/** Checks `ops.artifacts`, a list of rules, and returns it. With errors the list is empty. */
export function checkArtifacts(raw: unknown, errors: string[]): ArtifactRule[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        errors.push("ops.artifacts: must be a list of rules");
        return [];
    }
    const before = errors.length;
    raw.forEach((rule, index) => checkRule(rule, `ops.artifacts[${index}]`, errors));
    return errors.length > before ? [] : (raw as ArtifactRule[]);
}
