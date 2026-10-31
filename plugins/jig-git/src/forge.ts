// Which forge a repository is on. The decision is made from the host of origin and from the `git.forges` setting, never from
// anything the model says: a call cannot send a pull request to one forge and the credentials of another.
//
// - github.com and its ssh forms (and the configured clone host, an ssh alias for it) are GitHub, run through `gh`;
// - gitlab.com and its alternate ssh host are GitLab, run through `glab`;
// - a host named in `git.forges` is what the setting says, which is how a self-hosted GitLab is told apart. An entry may also be an
//   object, `{ "forge": "github", "host": "github.com" }`, for an ssh alias in `~/.ssh/config`: git goes on using the alias in
//   origin, and `gh` and `glab` are told the real host;
// - an origin with no host at all (a local path, or no origin) stays on GitHub as it always did: gh then reads the
//   repository's own remotes and says for itself when it finds none;
// - any other host is refused with the line that fixes it, because guessing would send a request to the wrong service.
import type { Forge, GitSettings } from "./config.ts";
import { originUrl, parseRemotePath } from "./repo.ts";
import type { Repo } from "./repo.ts";

export type { Forge } from "./config.ts";

/** A repository on GitLab: the host that glab talks to (the real one, when origin's host is an alias), and the project's path with all its groups. */
export interface GitlabHome {
    forge: "gitlab";
    host: string;
    /** `acme/orders-api`, or `platform/payments/orders-api` for a project in a subgroup. */
    path: string;
}

/** Where a repository lives. GitHub needs nothing more: `gh` and `repo.ts` find the rest. */
export type Home = { forge: "github"; host?: string } | GitlabHome;

const GITLAB_COM = "gitlab.com";
/** GitLab's hosted service has a second ssh host for networks that block port 22. */
const GITLAB_COM_HOSTS = new Set([GITLAB_COM, "altssh.gitlab.com"]);

function isGithubHost(host: string, settings: GitSettings): boolean {
    return (
        host === "github.com" ||
        host === "ssh.github.com" ||
        host.startsWith("github.com-") ||
        host === settings.cloneHost.toLowerCase()
    );
}

/** Origin is on a host that is neither GitHub nor GitLab, and `git.forges` does not name it. */
export class UnknownForgeHost extends Error {
    constructor(name: string, host: string) {
        super(
            `origin of ${name} is on ${host}, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "${host}": "gitlab" } }, ` +
                `or, when it is an ssh alias for a real host, "git": { "forges": { "${host}": { "forge": "github", "host": "github.com" } } }`,
        );
        this.name = "UnknownForgeHost";
    }
}

/** The forge of the repository, from origin. Throws a one-line refusal for a host it does not know. */
export async function forgeOf(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<Home> {
    const remote = parseRemotePath(await originUrl(repo, signal));
    if (remote === undefined) return { forge: "github" };
    const host = remote.host.toLowerCase();
    const entry = settings.forges?.[host];
    const configured: Forge | undefined = typeof entry === "string" ? entry : entry?.forge;
    // The host the forge's own command is told: the alias in origin is for git alone.
    const real = typeof entry === "object" ? entry.host : undefined;
    if (configured === "github") return real === undefined ? { forge: "github" } : { forge: "github", host: real };
    if (configured === "gitlab") return { forge: "gitlab", host: real ?? host, path: remote.path };
    if (isGithubHost(host, settings)) return { forge: "github" };
    if (GITLAB_COM_HOSTS.has(host)) return { forge: "gitlab", host: GITLAB_COM, path: remote.path };
    throw new UnknownForgeHost(repo.name, host);
}

/**
 * The GitLab project behind origin, or undefined when the repository is not on GitLab, or its host is not known. Anything else
 * is thrown: a refusal from jig-core about the repository's configuration is not an answer of "no".
 */
export async function gitlabHome(
    repo: Repo,
    settings: GitSettings,
    signal?: AbortSignal,
): Promise<GitlabHome | undefined> {
    try {
        const home = await forgeOf(repo, settings, signal);
        return home.forge === "gitlab" ? home : undefined;
    } catch (error) {
        if (error instanceof UnknownForgeHost) return undefined;
        throw error;
    }
}
