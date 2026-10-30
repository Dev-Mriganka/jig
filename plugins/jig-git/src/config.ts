// The `git` section of jig.json: what it may hold, how it is checked, and the defaults that fill the gaps.
//
// jig-core loads the file and calls `validateGitSection` when it loads it. With errors it hands us nothing, and we run on
// the defaults, so a typo never leaves a tool half configured.
import { jig } from "../../jig-core/src/client.ts";
import { checkBranch } from "./names.ts";

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

interface WatchSettings {
    auto: boolean;
    pollSeconds: number;
    stallMinutes: number;
    timeoutMinutes: number;
}

export interface GitSettings {
    base?: string;
    protected?: string[];
    commitMessage?: string;
    branchName?: string;
    prTemplate?: string;
    cloneHost: string;
    watch: WatchSettings;
    artifacts: ArtifactRule[];
}

export const DEFAULT_WATCH: WatchSettings = { auto: true, pollSeconds: 30, stallMinutes: 30, timeoutMinutes: 60 };
const DEFAULT_CLONE_HOST = "github.com";

const TOP = new Set([
    "base",
    "protected",
    "commitMessage",
    "branchName",
    "prTemplate",
    "cloneHost",
    "watch",
    "artifacts",
]);
const WATCH = new Set(["auto", "pollSeconds", "stallMinutes", "timeoutMinutes"]);
const RULE = new Set(["kind", "check", "log", "bot", "comment", "tag"]);
const KINDS = ["image", "tag", "release"];
const BRANCH_PATTERN = /^[A-Za-z0-9._/*-]+$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRegExp(value: unknown, key: string, errors: string[]): void {
    if (typeof value !== "string" || value === "") {
        errors.push(`${key} must be a non-empty regular expression`);
        return;
    }
    try {
        new RegExp(value);
    } catch (error) {
        errors.push(`${key} is not a valid regular expression: ${(error as Error).message}`);
    }
}

function checkNumber(value: unknown, key: string, min: number, max: number, errors: string[]): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        errors.push(`${key} must be a number from ${min} to ${max}`);
    }
}

function checkRule(rule: unknown, key: string, errors: string[]): void {
    if (!isObject(rule)) {
        errors.push(`${key} must be an object`);
        return;
    }
    for (const field of Object.keys(rule)) if (!RULE.has(field)) errors.push(`${key}.${field} is not a known field`);
    if (typeof rule.kind !== "string" || !KINDS.includes(rule.kind))
        errors.push(`${key}.kind must be one of ${KINDS.join(", ")}`);
    const sources = ["check", "comment", "tag"].filter((name) => rule[name] !== undefined);
    if (sources.length !== 1)
        errors.push(
            `${key} needs exactly one of check, comment and tag (found ${sources.length === 0 ? "none" : sources.join(", ")})`,
        );
    if (rule.check !== undefined && (typeof rule.check !== "string" || rule.check === ""))
        errors.push(`${key}.check must be a job name`);
    if (rule.log !== undefined) {
        checkRegExp(rule.log, `${key}.log`, errors);
        if (rule.check === undefined) errors.push(`${key}.log needs check: it is read from that job's log`);
    }
    if (rule.comment !== undefined) checkRegExp(rule.comment, `${key}.comment`, errors);
    if (rule.bot !== undefined) {
        if (typeof rule.bot !== "string" || rule.bot === "") errors.push(`${key}.bot must be a login`);
        if (rule.comment === undefined) errors.push(`${key}.bot needs comment: it limits whose comments are read`);
    }
    if (rule.tag !== undefined) {
        checkRegExp(rule.tag, `${key}.tag`, errors);
        if (rule.kind === "image") errors.push(`${key}.tag names tags or releases, so kind must be tag or release`);
    }
}

/** The error messages for a `git` section, each naming the key. Empty when the section is fine. */
export function validateGitSection(raw: unknown): string[] {
    if (!isObject(raw)) return ["git must be an object"];
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!TOP.has(key)) errors.push(`git.${key} is not a known field`);
    if (raw.base !== undefined) {
        try {
            checkBranch(raw.base);
        } catch {
            errors.push("git.base must be a branch name");
        }
    }
    if (raw.protected !== undefined) {
        const list = raw.protected;
        if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !BRANCH_PATTERN.test(item))) {
            errors.push("git.protected must be a list of branch names, where * matches any characters");
        }
    }
    if (raw.commitMessage !== undefined) checkRegExp(raw.commitMessage, "git.commitMessage", errors);
    if (raw.branchName !== undefined) checkRegExp(raw.branchName, "git.branchName", errors);
    if (raw.prTemplate !== undefined && (typeof raw.prTemplate !== "string" || raw.prTemplate === "")) {
        errors.push("git.prTemplate must be the path of a Markdown file");
    }
    if (
        raw.cloneHost !== undefined &&
        (typeof raw.cloneHost !== "string" || !HOST.test(raw.cloneHost) || raw.cloneHost.length > 100)
    ) {
        errors.push("git.cloneHost must be a host name or an ssh alias such as github.com");
    }
    if (raw.watch !== undefined) {
        if (!isObject(raw.watch)) {
            errors.push("git.watch must be an object");
        } else {
            for (const key of Object.keys(raw.watch))
                if (!WATCH.has(key)) errors.push(`git.watch.${key} is not a known field`);
            if (raw.watch.auto !== undefined && typeof raw.watch.auto !== "boolean")
                errors.push("git.watch.auto must be true or false");
            if (raw.watch.pollSeconds !== undefined)
                checkNumber(raw.watch.pollSeconds, "git.watch.pollSeconds", 5, 3600, errors);
            if (raw.watch.stallMinutes !== undefined)
                checkNumber(raw.watch.stallMinutes, "git.watch.stallMinutes", 1, 1440, errors);
            if (raw.watch.timeoutMinutes !== undefined)
                checkNumber(raw.watch.timeoutMinutes, "git.watch.timeoutMinutes", 1, 1440, errors);
        }
    }
    if (raw.artifacts !== undefined) {
        if (!Array.isArray(raw.artifacts)) errors.push("git.artifacts must be a list of rules");
        else raw.artifacts.forEach((rule, index) => checkRule(rule, `git.artifacts[${index}]`, errors));
    }
    return errors;
}

/** The settings with every default filled in. Pure, so tests can feed it any section. */
export function settingsFrom(raw: unknown): GitSettings {
    const section = isObject(raw) && validateGitSection(raw).length === 0 ? raw : {};
    const watch = isObject(section.watch) ? section.watch : {};
    return {
        base: section.base as string | undefined,
        protected: section.protected as string[] | undefined,
        commitMessage: section.commitMessage as string | undefined,
        branchName: section.branchName as string | undefined,
        prTemplate: section.prTemplate as string | undefined,
        cloneHost: (section.cloneHost as string | undefined) ?? DEFAULT_CLONE_HOST,
        watch: { ...DEFAULT_WATCH, ...(watch as Partial<WatchSettings>) },
        artifacts: (section.artifacts as ArtifactRule[] | undefined) ?? [],
    };
}

/** The settings as jig-core loaded them at the last session start. Read per call, never kept. */
export function gitSettings(): GitSettings {
    return settingsFrom(jig().config.section("git"));
}

/** A branch pattern such as `release/*` as a regular expression. `*` matches any characters, everything else is literal. */
export function branchPattern(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

/** Whether `name` matches one of the patterns. */
export function matchesAny(patterns: readonly string[], name: string): boolean {
    return patterns.some((pattern) => branchPattern(pattern).test(name));
}
