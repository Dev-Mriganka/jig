// Releases on GitLab: `releases` lists them or shows one in full, and `release_create` makes one, through `glab api`. They follow
// the GitHub release actions. GitLab has no draft release, no pre-release flag and no generated notes, so a call that asks for
// one of them is refused in a line that names the GitLab way. Tags themselves are git and are not here.
import type { GitlabHome } from "./forge.ts";
import { afterLostReply } from "./github.ts";
import { apiArgs, answerOf, glab, glabFailure, glabWrite, projectBase, statusOf, withQuery } from "./gitlab.ts";
import { get } from "./gitlab-pr-read.ts";
import type { Gl } from "./gitlab-pr-read.ts";
import { checkBody, checkRev, checkTag, checkTitle } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { digest, readOnly, reviewPreview } from "./previews.ts";
import { baseBranch, resolveRepo } from "./repo.ts";
import { gitOut, revParse, T_NETWORK } from "./run.ts";
import { firstLines, plural } from "./text.ts";

interface GlRelease {
    tag_name: string;
    name?: string | null;
    description?: string | null;
    created_at?: string;
    released_at?: string | null;
    /** A release dated in the future. */
    upcoming_release?: boolean;
    commit?: { id?: string } | null;
    assets?: { links?: Array<{ name?: string }> } | null;
    _links?: { self?: string };
}

const day = (release: GlRelease): string => (release.released_at ?? release.created_at ?? "").slice(0, 10);

export function planReleases(
    params: { repo?: string; tag?: string; n?: number },
    call: Call,
    home: GitlabHome,
): Planned {
    const tag = params.tag === undefined ? undefined : checkTag(params.tag);
    const n = Math.max(1, Math.min(100, Math.trunc(params.n ?? 20)));
    return readOnly(`release releases in ${params.repo ?? "here"}`, async () => {
        const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
        if (tag !== undefined) {
            const r = await get<GlRelease>(gl, "glab api (release)", `releases/${encodeURIComponent(tag)}`);
            const flags = r.upcoming_release ? "upcoming" : "";
            const links = (r.assets?.links ?? []).map((link) => link.name ?? "").filter(Boolean);
            return {
                text: [
                    `Release ${r.tag_name}${r.name && r.name !== r.tag_name ? ` "${r.name}"` : ""}${flags ? ` [${flags}]` : ""}, published ${day(r) || "not yet"}, target ${(r.commit?.id ?? "").slice(0, 7) || "unknown"}`,
                    r._links?.self ?? "",
                    links.length > 0 ? `assets: ${links.join(", ")}` : "no assets",
                    "",
                    firstLines(r.description ?? "", 120).text,
                ].join("\n"),
            };
        }
        const rows = await get<GlRelease[]>(
            gl,
            "glab api (releases)",
            withQuery("releases", { per_page: n, order_by: "released_at", sort: "desc" }),
        );
        if (rows.length === 0) return { text: `No releases in ${gl.repo.name}.` };
        const lines = rows.map(
            (r) =>
                `${r.tag_name}  ${day(r) || "unpublished"}${r.upcoming_release ? "  upcoming" : ""}${r.name && r.name !== r.tag_name ? `  ${r.name}` : ""}`,
        );
        return { text: `${gl.repo.name}: ${plural(rows.length, "release")}\n${lines.join("\n")}` };
    });
}

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

export async function planReleaseCreate(params: CreateReleaseParams, call: Call, home: GitlabHome): Promise<Planned> {
    const tag = checkTag(params.tag);
    const title = params.title === undefined ? tag : checkTitle(params.title);
    const notes = params.notes === undefined ? "" : checkBody(params.notes, "notes");
    const target = params.target === undefined ? undefined : checkRev(params.target, "target");
    // GitLab has none of these; the call is refused before a repository is read or anyone is asked.
    if (params.draft === true)
        throw new Error(
            "release_create: GitLab has no draft releases; create the release when it is ready (a release dated in the future shows as upcoming)",
        );
    if (params.prerelease === true)
        throw new Error("release_create: GitLab has no pre-release flag; say it in the title or the notes");
    if (params.generate_notes === true)
        throw new Error(
            "release_create: GitLab does not write release notes; write them in notes, or use its changelog API to generate them",
        );
    const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
    const { signal, settings } = call;
    const where = `${projectBase(home)}/releases/${encodeURIComponent(tag)}`;
    const exists = await glab(apiArgs(home, where), { cwd: gl.repo.root, signal });
    if (exists.code === 0) throw new Error(`a release for ${tag} already exists in ${home.path}`);
    if (statusOf(exists) !== 404) throw glabFailure("glab api (release)", exists, home.host);
    const there =
        (
            await gitOut(gl.repo.root, ["ls-remote", "origin", `refs/tags/${tag}`], {
                signal,
                network: true,
                timeoutMs: T_NETWORK,
            })
        )
            .trim()
            .split("\t")[0] ?? "";
    const base = await baseBranch(gl.repo, settings, signal);
    const ref = target ?? base;
    const at =
        there !== ""
            ? `the existing tag ${tag} (${there.slice(0, 7)})`
            : `a new tag ${tag} at ${target ?? `the head of ${base}`}`;
    const baseSha = there !== "" ? "" : ((await revParse(gl.repo.root, `refs/remotes/origin/${ref}`, signal)) ?? "");
    const text = `# ${title}\n\n${notes}`.trimEnd();
    return {
        preview: reviewPreview(
            `create the release ${tag} on ${at} in ${home.path}`,
            text,
            digest("release_create", home.host, home.path, tag, title, notes, target ?? "", there, baseSha),
        ),
        run: async () => {
            const done = (url: string) => `Created the release ${tag} in ${home.path}${url ? `: ${url}` : "."}`;
            const sent = await glabWrite(
                "glab api (create release)",
                home,
                "POST",
                `${projectBase(home)}/releases`,
                {
                    tag_name: tag,
                    name: title,
                    ...(notes === "" ? {} : { description: notes }),
                    // A tag that is not there yet is made from this ref; one that is there keeps the commit it has.
                    ...(there === "" ? { ref } : {}),
                },
                { cwd: gl.repo.root, signal },
            );
            if (sent.kind === "sent")
                return { text: done(answerOf<GlRelease>(sent)?._links?.self ?? ""), details: { tag } };
            return afterLostReply(
                "glab api (create release)",
                sent.why,
                async () => {
                    const now = await glab(apiArgs(home, where), { cwd: gl.repo.root });
                    if (now.code !== 0) return undefined;
                    let url = "";
                    try {
                        url = (JSON.parse(now.stdout) as GlRelease)._links?.self ?? "";
                    } catch {
                        // The release is there; its address is not worth failing for.
                    }
                    return done(url);
                },
                "GitLab",
            );
        },
    };
}
