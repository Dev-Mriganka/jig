// "The artifact is ready": the rules in `ops.artifacts`, tested when a watch has passed. A rule says where to look: the
// log of a named job, a comment by a bot, or a new tag or release. What it finds is announced on Pi's event bus as
// `jig-ops:artifact-ready`. The watch announces and does nothing more: whether to deploy is not its decision.
//
// Every rule is tied to the commit that was watched. A version read from a log or a comment that does not contain the
// commit's short id belongs to some other build and is ignored.
import type { WatchResult } from "../../../jig-core/src/contract.ts";
import { cleanLog } from "./logs.ts";
import type { Check } from "./model.ts";
import type { ArtifactRule } from "./settings.ts";

// The name was `jig-git:artifact-ready` while jig-git ran the watch. The plugin that publishes an event owns its name,
// and jig-git no longer publishes this one.
export const ARTIFACT_EVENT = "jig-ops:artifact-ready";

/** What the event carries. */
export interface ArtifactReady {
    repo: string;
    pr?: number;
    sha: string;
    kind: "image" | "tag" | "release";
    /** The version, image reference, tag or release tag. */
    ref: string;
    /** Where it was found. */
    source: "check" | "log" | "comment" | "tag" | "release";
}

/** Publishes an event on Pi's event bus (`pi.events.emit`). */
export type Announce = (event: string, payload: unknown) => void;

export interface Comment {
    login: string;
    bot: boolean;
    body: string;
    createdAt: string;
    url: string;
}

export interface Tag {
    name: string;
    sha: string;
}

export interface Release {
    tag: string;
    name: string;
    url: string;
}

/** Where the rules look. Each is read when a rule needs it, and at most once. */
export interface ArtifactSources {
    checks(): Promise<readonly Check[]>;
    log(jobId: number): Promise<string>;
    comments(): Promise<readonly Comment[]>;
    tags(): Promise<readonly Tag[]>;
    releases(): Promise<readonly Release[]>;
}

export interface ArtifactTest {
    repo: string;
    pr?: number;
    /** The commit that was watched. */
    sha: string;
    rules: readonly ArtifactRule[];
    sources: ArtifactSources;
    announce: Announce;
}

/** The versions a rule's pattern finds in a text: its first group, else the whole match. */
function versionsIn(text: string, pattern: string): string[] {
    return [...text.matchAll(new RegExp(pattern, "g"))].map((match) => match[1] ?? match[0]);
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
    let held: Promise<T> | undefined;
    return () => (held ??= read());
}

/** Tests every rule against the watched commit, announces each artifact found, and returns them. */
export async function testArtifacts(test: ArtifactTest): Promise<ArtifactReady[]> {
    const { sha, rules } = test;
    const short = sha.slice(0, 7);
    const carriesSha = (version: string) => version.includes(short);
    const sources: ArtifactSources = {
        checks: once(test.sources.checks),
        log: test.sources.log,
        comments: once(test.sources.comments),
        tags: once(test.sources.tags),
        releases: once(test.sources.releases),
    };
    const found: ArtifactReady[] = [];
    const add = (rule: ArtifactRule, ref: string, source: ArtifactReady["source"]) => {
        if (!found.some((artifact) => artifact.kind === rule.kind && artifact.ref === ref))
            found.push({ repo: test.repo, pr: test.pr, sha, kind: rule.kind, ref, source });
    };
    for (const rule of rules) {
        if (rule.check !== undefined) {
            const check = (await sources.checks()).find((candidate) => candidate.name === rule.check);
            if (!check || check.bucket !== "pass") continue;
            if (rule.log === undefined) {
                add(rule, short, "check");
            } else if (check.id !== undefined) {
                const version = versionsIn(cleanLog(await sources.log(check.id)), rule.log).find(carriesSha);
                if (version !== undefined) add(rule, version, "log");
            }
        } else if (rule.comment !== undefined) {
            if (test.pr === undefined) continue;
            for (const comment of await sources.comments()) {
                if (rule.bot === undefined ? !comment.bot : comment.login !== rule.bot) continue;
                const version = versionsIn(comment.body, rule.comment).find(carriesSha);
                if (version !== undefined) {
                    add(rule, version, "comment");
                    break;
                }
            }
        } else if (rule.tag !== undefined) {
            const pattern = new RegExp(rule.tag);
            const tags = await sources.tags();
            const onCommit = (name: string) => tags.some((tag) => tag.name === name && tag.sha === sha);
            const names =
                rule.kind === "release"
                    ? (await sources.releases()).map((release) => release.tag)
                    : tags.map((tag) => tag.name);
            const name = names.find(
                (candidate) => pattern.test(candidate) && (carriesSha(candidate) || onCommit(candidate)),
            );
            if (name !== undefined) add(rule, name, rule.kind === "release" ? "release" : "tag");
        }
    }
    for (const artifact of found) test.announce(ARTIFACT_EVENT, artifact);
    return found;
}

/**
 * Tests the artifact rules when a watch has passed, and adds what they found to the result. A rule that cannot be tested
 * (the log has expired, say) does not lose the watch's result: the message says so.
 */
export async function addArtifacts(result: WatchResult, test: ArtifactTest): Promise<WatchResult> {
    if (test.rules.length === 0) return result;
    try {
        const found = await testArtifacts(test);
        if (found.length === 0) return result;
        const line = `Ready: ${found.map((artifact) => `${artifact.kind} ${artifact.ref}`).join(", ")}`;
        return {
            ...result,
            details: [result.details, line].filter(Boolean).join("\n"),
            facts: { ...(result.facts ?? {}), artifacts: found.length },
        };
    } catch (error) {
        return {
            ...result,
            details: [result.details, `The artifact rules could not be tested: ${(error as Error).message}`]
                .filter(Boolean)
                .join("\n"),
        };
    }
}
