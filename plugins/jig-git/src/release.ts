// The `release` tool: tags and releases. Creating a tag is local. Pushing a tag and creating a release on GitHub or GitLab change
// the forge, so they ask. A tag is never deleted or moved from here, and a pushed tag is never forced. Tags are git; the releases
// go to the forge of the repository, through gh or glab (see forge.ts).
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { forgeOf } from "./forge.ts";
import { afterLostReply, gh, ghFailure, ghJson, ghWrite, repoFlags, requireSlug } from "./github.ts";
import { planReleaseCreate as planGitlabReleaseCreate, planReleases as planGitlabReleases } from "./gitlab-release.ts";
import { checkBody, checkCommitMessage, checkRemote, checkRev, checkTag, checkTitle } from "./names.ts";
import { describeActions } from "./params.ts";
import type { ActionTable } from "./params.ts";
import type { Call, Planned } from "./previews.ts";
import { digest, readOnly, reviewPreview } from "./previews.ts";
import { baseBranch, resolveRepo } from "./repo.ts";
import { git, gitOut, gitTry, mayHaveLanded, revParse, summaryOf, T_NETWORK, T_PUSH } from "./run.ts";
import { at, buildTool } from "./tool.ts";
import type { JigTool } from "./tool.ts";
import { firstLines, plural } from "./text.ts";

export const RELEASE_ACTIONS = {
    tags: {
        summary: "tags: the latest matching a pattern, or those containing a commit",
        optional: ["repo", "pattern", "contains", "n"],
    },
    releases: { summary: "releases, listed; or one in full", optional: ["repo", "tag", "n"] },
    tag_create: { summary: "an annotated tag, locally", required: ["tag", "message"], optional: ["repo", "target"] },
    tag_push: { summary: "push a tag (asks)", required: ["tag"], optional: ["repo", "remote"] },
    release_create: {
        summary: "a GitHub or GitLab release (asks)",
        required: ["tag"],
        optional: ["repo", "title", "notes", "target", "draft", "prerelease", "generate_notes"],
    },
} satisfies ActionTable;

const ACTION_NAMES = Object.keys(RELEASE_ACTIONS) as (keyof typeof RELEASE_ACTIONS)[];

const ReleaseParams = Type.Object(
    {
        action: StringEnum(ACTION_NAMES, { description: describeActions(RELEASE_ACTIONS) }),
        repo: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 1000,
                description:
                    "A folder in the workspace, or an absolute path inside a work tree. Omit it for the repo Pi runs in.",
            }),
        ),
        tag: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "A tag name. releases: show this release in full.",
            }),
        ),
        message: Type.Optional(
            Type.String({ minLength: 1, maxLength: 10_000, description: "tag_create: the tag's message." }),
        ),
        target: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description:
                    "tag_create: the commit to tag. Default HEAD. release_create: the branch or commit a new tag points at. Default: the default branch.",
            }),
        ),
        remote: Type.Optional(
            Type.String({ minLength: 1, maxLength: 100, description: "tag_push: the remote. Default origin." }),
        ),
        title: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 256,
                description: "release_create: the release title. Default: the tag.",
            }),
        ),
        notes: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 60_000,
                description: "release_create: the release notes, Markdown.",
            }),
        ),
        draft: Type.Optional(Type.Boolean({ description: "release_create: save it as a draft. GitHub only." })),
        prerelease: Type.Optional(
            Type.Boolean({ description: "release_create: mark it as a pre-release. GitHub only." }),
        ),
        generate_notes: Type.Optional(
            Type.Boolean({ description: "release_create: let GitHub write the notes. GitHub only." }),
        ),
        pattern: Type.Optional(
            Type.String({ minLength: 1, maxLength: 100, description: "tags: a glob such as v1.*." }),
        ),
        contains: Type.Optional(
            Type.String({ minLength: 1, maxLength: 200, description: "tags: only tags that contain this commit." }),
        ),
        n: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, description: "tags, releases: how many. Default 20." }),
        ),
    },
    { additionalProperties: false },
);

function classifyRelease(input: Readonly<Record<string, unknown>>): CallClass | undefined {
    const action = input.action;
    switch (action) {
        case "tags":
            return at(action, "local", "read");
        case "releases":
            return at(action, "external", "read");
        case "tag_create":
            return at(action, "local", "write");
        case "tag_push":
        case "release_create":
            return at(action, "external", "write");
        default:
            return undefined;
    }
}

// ---- tags ---------------------------------------------------------------------------------------------------------

// The newest tag first. Tags made in the same second are put in version order, newest first, so the order is always the same.
const TAG_FORMAT =
    "%(refname:short)%09%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%09%(creatordate:short)%09%(contents:subject)";

function planTags(params: { repo?: string; pattern?: string; contains?: string; n?: number }, call: Call): Planned {
    if (params.pattern !== undefined && !/^[A-Za-z0-9._*?/[\]-]{1,100}$/.test(params.pattern))
        throw new Error("release tags: pattern must be a glob such as v1.*");
    const contains = params.contains === undefined ? undefined : checkRev(params.contains, "contains");
    const n = Math.max(1, Math.min(100, Math.trunc(params.n ?? 20)));
    return readOnly(`release tags in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const args = [
            "tag",
            "--list",
            ...(params.pattern ? [params.pattern] : []),
            "--sort=-version:refname",
            "--sort=-creatordate",
            `--format=${TAG_FORMAT}`,
            ...(contains ? ["--contains", contains] : []),
        ];
        const rows = (await gitOut(repo.root, args, { signal: call.signal })).split("\n").filter(Boolean);
        if (rows.length === 0)
            return {
                text: `No tags${params.pattern ? ` match ${params.pattern}` : ""}${contains ? ` that contain ${contains}` : ""} in ${repo.name}.`,
            };
        const shown = rows.slice(0, n).map((row) => row.split("\t").join("  "));
        return {
            text: `${repo.name}: ${plural(rows.length, "tag")}, newest first\n${shown.join("\n")}${rows.length > n ? `\n... ${rows.length - n} more` : ""}`,
            details: { latest: rows[0]?.split("\t")[0] },
        };
    });
}

// ---- releases -----------------------------------------------------------------------------------------------------

interface ReleaseRow {
    name: string;
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
    isLatest: boolean;
    publishedAt: string;
}

interface ReleaseDetail extends ReleaseRow {
    body: string;
    url: string;
    targetCommitish: string;
    assets: { name: string; size: number }[];
}

function planReleases(params: { repo?: string; tag?: string; n?: number }, call: Call): Planned {
    const tag = params.tag === undefined ? undefined : checkTag(params.tag);
    const n = Math.max(1, Math.min(100, Math.trunc(params.n ?? 20)));
    return readOnly(`release releases in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const flags = await repoFlags(repo, call.settings, call.signal);
        if (tag !== undefined) {
            const r = ghJson<ReleaseDetail>(
                "gh release view",
                await gh(
                    [
                        "release",
                        "view",
                        tag,
                        "--json",
                        "name,tagName,isDraft,isPrerelease,publishedAt,url,targetCommitish,body,assets",
                        ...flags,
                    ],
                    { cwd: repo.root, signal: call.signal },
                ),
            );
            const flagsText = [r.isDraft ? "draft" : "", r.isPrerelease ? "pre-release" : ""]
                .filter(Boolean)
                .join(", ");
            const assets =
                r.assets.length > 0 ? `assets: ${r.assets.map((asset) => asset.name).join(", ")}` : "no assets";
            return {
                text: [
                    `Release ${r.tagName}${r.name && r.name !== r.tagName ? ` "${r.name}"` : ""}${flagsText ? ` [${flagsText}]` : ""}, published ${r.publishedAt?.slice(0, 10) ?? "not yet"}, target ${r.targetCommitish}`,
                    r.url,
                    assets,
                    "",
                    firstLines(r.body ?? "", 120).text,
                ].join("\n"),
            };
        }
        const rows = ghJson<ReleaseRow[]>(
            "gh release list",
            await gh(
                [
                    "release",
                    "list",
                    "--limit",
                    String(n),
                    "--json",
                    "name,tagName,isDraft,isPrerelease,isLatest,publishedAt",
                    ...flags,
                ],
                { cwd: repo.root, signal: call.signal },
            ),
        );
        if (rows.length === 0) return { text: `No releases in ${repo.name}.` };
        const lines = rows.map(
            (r) =>
                `${r.tagName}  ${r.publishedAt?.slice(0, 10) ?? "unpublished"}${r.isLatest ? "  latest" : ""}${r.isDraft ? "  draft" : ""}${r.isPrerelease ? "  pre-release" : ""}${r.name && r.name !== r.tagName ? `  ${r.name}` : ""}`,
        );
        return { text: `${repo.name}: ${plural(rows.length, "release")}\n${lines.join("\n")}` };
    });
}

// ---- tag_create ---------------------------------------------------------------------------------------------------

async function planTagCreate(
    params: { repo?: string; tag?: string; message?: string; target?: string },
    call: Call,
): Promise<Planned> {
    const tag = checkTag(params.tag);
    const message = checkCommitMessage(params.message);
    const target = params.target === undefined ? "HEAD" : checkRev(params.target, "target");
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    if (await revParse(repo.root, `refs/tags/${tag}`, signal))
        throw new Error(`tag ${tag} already exists in ${repo.name}; a tag is never moved or deleted from here`);
    const sha = await revParse(repo.root, target, signal);
    if (!sha) throw new Error(`${target} is not a commit in ${repo.name}`);
    return {
        preview: {
            summary: `tag ${sha.slice(0, 7)} as ${tag} in ${repo.name}`,
            body: message,
            format: "text",
            fingerprint: digest("tag_create", repo.root, tag, sha, message),
        },
        run: async () => {
            await gitOut(repo.root, ["tag", "--annotate", "-m", message, tag, sha], { signal });
            return {
                text: `Created the annotated tag ${tag} at ${sha.slice(0, 7)} in ${repo.name}. It is local until tag_push sends it.`,
                details: { tag, sha },
            };
        },
    };
}

// ---- tag_push -----------------------------------------------------------------------------------------------------

async function planTagPush(params: { repo?: string; tag?: string; remote?: string }, call: Call): Promise<Planned> {
    const tag = checkTag(params.tag);
    const remote = params.remote === undefined ? "origin" : checkRemote(params.remote);
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const object = (
        await gitTry(repo.root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { signal })
    )?.trim();
    if (!object) throw new Error(`tag ${tag} does not exist in ${repo.name}; tag_create makes it`);
    const commit = (await revParse(repo.root, `refs/tags/${tag}`, signal)) ?? object;
    const there = (
        await gitOut(repo.root, ["ls-remote", remote, `refs/tags/${tag}`], {
            signal,
            network: true,
            timeoutMs: T_NETWORK,
        })
    ).trim();
    if (there !== "" && !there.startsWith(object))
        throw new Error(
            `${remote} already has a tag ${tag} that points elsewhere; a pushed tag is never forced or deleted from here`,
        );
    const subject = (await gitOut(repo.root, ["log", "-1", "--format=%s", commit], { signal })).trim();
    const already = there !== "";
    return {
        preview: {
            summary: `push the tag ${tag} (${commit.slice(0, 7)}) to ${remote} from ${repo.name}${already ? "; it is already there" : ""}`,
            body: `Tag ${tag} points at ${commit.slice(0, 7)}: ${subject}`,
            format: "text",
            fingerprint: digest("tag_push", repo.root, remote, tag, object),
        },
        run: async () => {
            if (already) return { text: `${remote} already has ${tag} at ${commit.slice(0, 7)}; nothing to push.` };
            const result = await git(
                repo.root,
                ["push", "--no-progress", remote, `refs/tags/${tag}:refs/tags/${tag}`],
                { signal, network: true, timeoutMs: T_PUSH },
            );
            if (result.code !== 0 || result.timedOut) {
                if (!mayHaveLanded(result) && !signal?.aborted)
                    throw new Error(
                        `git push failed: ${summaryOf(result.stderr || result.stdout) || `exit ${result.code}`}`,
                    );
                const why = result.timedOut
                    ? "timed out"
                    : signal?.aborted
                      ? "the call was cancelled"
                      : summaryOf(result.stderr);
                const now = await gitTry(repo.root, ["ls-remote", remote, `refs/tags/${tag}`], {
                    network: true,
                    timeoutMs: T_NETWORK,
                });
                if (now === undefined)
                    throw new Error(
                        `git push: the reply was lost (${why}) and the check failed too. Run git ls-remote ${remote} before pushing again. Nothing was sent twice.`,
                    );
                if (!now.startsWith(object))
                    throw new Error(
                        `git push: the reply was lost (${why}) and ${remote} does not have ${tag}. Nothing was sent twice; push again if you still want it.`,
                    );
                return {
                    text: `Pushed the tag ${tag} (${commit.slice(0, 7)}) to ${remote}. (The reply was lost (${why}); one check shows ${remote} has it. Nothing was sent twice.)`,
                };
            }
            return {
                text: `Pushed the tag ${tag} (${commit.slice(0, 7)}) to ${remote} from ${repo.name}.`,
                details: { tag, commit },
            };
        },
    };
}

// ---- release_create -----------------------------------------------------------------------------------------------

interface CreateReleaseParams {
    repo?: string;
    tag?: string;
    title?: string;
    notes?: string;
    target?: string;
    draft?: boolean;
    prerelease?: boolean;
    generate_notes?: boolean;
}

async function planReleaseCreate(params: CreateReleaseParams, call: Call): Promise<Planned> {
    const tag = checkTag(params.tag);
    const title = params.title === undefined ? tag : checkTitle(params.title);
    const notes = params.notes === undefined ? "" : checkBody(params.notes, "notes");
    const target = params.target === undefined ? undefined : checkRev(params.target, "target");
    const generate = params.generate_notes === true;
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal, settings } = call;
    const slug = await requireSlug(repo, settings, signal);
    const flags = ["-R", slug];
    const exists = await gh(["release", "view", tag, "--json", "url", ...flags], { cwd: repo.root, signal });
    if (exists.code === 0) throw new Error(`a release for ${tag} already exists in ${slug}`);
    if (!/not found/i.test(exists.stderr)) throw ghFailure("gh release view", exists);
    const there =
        (
            await gitOut(repo.root, ["ls-remote", "origin", `refs/tags/${tag}`], {
                signal,
                network: true,
                timeoutMs: T_NETWORK,
            })
        )
            .trim()
            .split("\t")[0] ?? "";
    const base = await baseBranch(repo, settings, signal);
    const at =
        there !== ""
            ? `the existing tag ${tag} (${there.slice(0, 7)})`
            : `a new tag ${tag} at ${target ?? `the head of ${base}`}`;
    const baseSha =
        there !== "" ? "" : ((await revParse(repo.root, `refs/remotes/origin/${target ?? base}`, signal)) ?? "");
    const flagsText = [params.draft ? "draft" : "", params.prerelease ? "pre-release" : ""].filter(Boolean).join(", ");
    const text = `# ${title}\n\n${generate ? "(GitHub writes the notes.)\n\n" : ""}${notes}`.trimEnd();
    return {
        preview: reviewPreview(
            `create the release ${tag}${flagsText ? ` (${flagsText})` : ""} on ${at} in ${slug}`,
            text,
            digest(
                "release_create",
                slug,
                tag,
                title,
                notes,
                target ?? "",
                generate,
                params.draft === true,
                params.prerelease === true,
                there,
                baseSha,
            ),
        ),
        run: async () => {
            const args = [
                "release",
                "create",
                tag,
                `--title=${title}`,
                "--notes-file",
                "-",
                ...(generate ? ["--generate-notes"] : []),
                ...(target && there === "" ? ["--target", target] : []),
                ...(params.draft ? ["--draft"] : []),
                ...(params.prerelease ? ["--prerelease"] : []),
                ...flags,
            ];
            const done = (url: string) => `Created the release ${tag} in ${slug}${url ? `: ${url}` : "."}`;
            const sent = await ghWrite("gh release create", args, { cwd: repo.root, signal, input: notes });
            if (sent.kind === "sent")
                return { text: done(sent.result.stdout.trim().split("\n").at(-1) ?? ""), details: { tag } };
            return afterLostReply("gh release create", sent.why, async () => {
                const now = await gh(["release", "view", tag, "--json", "url", ...flags], { cwd: repo.root });
                return now.code === 0 ? done((JSON.parse(now.stdout) as { url?: string }).url ?? "") : undefined;
            });
        },
    };
}

async function planRelease(params: Readonly<Record<string, unknown>>, call: Call): Promise<Planned> {
    const p = params as never;
    // The releases are the forge's; the repository says which forge. Tags are git and need no answer.
    if (params.action === "releases" || params.action === "release_create") {
        const repo = await resolveRepo(params.repo as string | undefined, call.signal);
        const home = await forgeOf(repo, call.settings, call.signal);
        if (home.forge === "gitlab")
            return params.action === "releases"
                ? planGitlabReleases(p, call, home)
                : planGitlabReleaseCreate(p, call, home);
    }
    switch (params.action) {
        case "tags":
            return planTags(p, call);
        case "releases":
            return planReleases(p, call);
        case "tag_create":
            return planTagCreate(p, call);
        case "tag_push":
            return planTagPush(p, call);
        case "release_create":
            return planReleaseCreate(p, call);
        default:
            throw new Error(`release: unknown action ${String(params.action)}`);
    }
}

export const releaseTool: JigTool = buildTool({
    name: "release",
    label: "Release",
    description:
        "Tags and releases on GitHub or GitLab, by the repository's origin: tags, releases, tag_create (local), tag_push and release_create (these ask). A tag is never moved, forced or deleted from here.",
    promptSnippet: "Tags and releases: list, create, push",
    parameters: ReleaseParams,
    table: RELEASE_ACTIONS,
    classify: classifyRelease,
    plan: async (params, call) => planRelease(params, call),
});
