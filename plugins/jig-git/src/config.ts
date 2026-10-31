// The `git` section of jig.json: what it may hold, how it is checked, and the defaults that fill the gaps.
//
// jig-core loads the file and calls `validateGitSection` when it loads it. With errors it hands us nothing, and we run on
// the defaults, so a typo never leaves a tool half configured. `watch` and `artifacts` were here while jig-git ran the CI
// watch; they are `ops.watch` and `ops.artifacts` now, and the error for them says so.
import { jig } from "../../jig-core/src/client.ts";
import { isObject } from "../../jig-core/src/kit/values.ts";
import { checkBranch } from "./names.ts";

/** The kinds of forge jig-git can talk to: GitHub through `gh`, GitLab through `glab`. */
export type Forge = "github" | "gitlab";

export interface GitSettings {
    base?: string;
    protected?: string[];
    commitMessage?: string;
    branchName?: string;
    prTitle?: string;
    prTemplate?: string;
    cloneHost: string;
    /** Whether `pr create` starts a watch on the comments of the new pull request. */
    watchComments: WatchComments;
    /** Whether the watch tells the agent about comments by bots. */
    watchBots: boolean;
    /** Hosts that are not github.com or gitlab.com, and the forge each one is. Left out when none is configured. */
    forges?: Readonly<Record<string, Forge>>;
}

export type WatchComments = "after-create" | "off";

const DEFAULT_CLONE_HOST = "github.com";

const TOP = new Set([
    "base",
    "protected",
    "commitMessage",
    "branchName",
    "prTitle",
    "prTemplate",
    "cloneHost",
    "watchComments",
    "watchBots",
    "forges",
]);
/** Settings that moved with CI to jig-ops, and where they are now. */
const MOVED: Readonly<Record<string, string>> = { watch: "ops.watch", artifacts: "ops.artifacts" };
const BRANCH_PATTERN = /^[A-Za-z0-9._/*-]+$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function validForges(value: unknown): boolean {
    if (!isObject(value)) return false;
    return Object.entries(value).every(
        ([host, forge]) => HOST.test(host) && host.length <= 100 && (forge === "github" || forge === "gitlab"),
    );
}

/** The error messages for a `git` section, each naming the key. Empty when the section is fine. */
export function validateGitSection(raw: unknown): string[] {
    if (!isObject(raw)) return ["git must be an object"];
    const errors: string[] = [];
    for (const key of Object.keys(raw)) {
        if (Object.hasOwn(MOVED, key)) errors.push(`git.${key} moved to ${MOVED[key]}, which jig-ops reads`);
        else if (!TOP.has(key)) errors.push(`git.${key} is not a known field`);
    }
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
    if (raw.prTitle !== undefined) checkRegExp(raw.prTitle, "git.prTitle", errors);
    if (raw.prTemplate !== undefined && (typeof raw.prTemplate !== "string" || raw.prTemplate === "")) {
        errors.push("git.prTemplate must be the path of a Markdown file");
    }
    if (
        raw.cloneHost !== undefined &&
        (typeof raw.cloneHost !== "string" || !HOST.test(raw.cloneHost) || raw.cloneHost.length > 100)
    ) {
        errors.push("git.cloneHost must be a host name or an ssh alias such as github.com");
    }
    if (raw.watchComments !== undefined && raw.watchComments !== "after-create" && raw.watchComments !== "off") {
        errors.push('git.watchComments must be "after-create" or "off"');
    }
    if (raw.watchBots !== undefined && typeof raw.watchBots !== "boolean") {
        errors.push("git.watchBots must be true or false");
    }
    if (raw.forges !== undefined && !validForges(raw.forges)) {
        errors.push(
            'git.forges must map host names to "github" or "gitlab", such as { "gitlab.example.com": "gitlab" }',
        );
    }
    return errors;
}

/** The configured forges with their host names in lower case, as a remote's host is compared. */
function forgesFrom(value: unknown): Record<string, Forge> | undefined {
    if (!isObject(value) || Object.keys(value).length === 0) return undefined;
    return Object.fromEntries(Object.entries(value).map(([host, forge]) => [host.toLowerCase(), forge as Forge]));
}

/** The settings with every default filled in. Pure, so tests can feed it any section. */
export function settingsFrom(raw: unknown): GitSettings {
    const section = isObject(raw) && validateGitSection(raw).length === 0 ? raw : {};
    const forges = forgesFrom(section.forges);
    return {
        base: section.base as string | undefined,
        protected: section.protected as string[] | undefined,
        commitMessage: section.commitMessage as string | undefined,
        branchName: section.branchName as string | undefined,
        prTitle: section.prTitle as string | undefined,
        prTemplate: section.prTemplate as string | undefined,
        cloneHost: (section.cloneHost as string | undefined) ?? DEFAULT_CLONE_HOST,
        watchComments: (section.watchComments as WatchComments | undefined) ?? "after-create",
        watchBots: (section.watchBots as boolean | undefined) ?? false,
        ...(forges === undefined ? {} : { forges }),
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
