// Which forge a repository is on, so that `pull-request-open` and `checks-pass` ask the right one. The decision is made from the
// host of origin and from the `git.forges` setting, as jig-git makes it, and never from anything the agent says. This plugin
// cannot import jig-git, so it reads the `git` section through jig-core and keeps the few rules itself:
//
// - github.com, its ssh forms and the configured clone host are GitHub, read with `gh`;
// - gitlab.com and its alternate ssh host are GitLab, read with `glab`;
// - a host named in `git.forges` is what the setting says, which is how a self-hosted GitLab is told apart. The entry is
//   "github" or "gitlab", or `{ "forge": ..., "host": ... }` when the host in origin is an ssh alias (`github.com-work`) for the
//   real one: git keeps using the alias, and `gh` and `glab` are told the real host;
// - any other host, and an origin with no host, stay on `gh`, as they always did: `gh` then says for itself what it cannot find.

/**
 * Where a repository is: on GitHub, where `gh` finds the repository from the remotes (or from `repo`, as `host/owner/name`, when
 * origin's host is an ssh alias for the real one); or on GitLab, with the host glab talks to and the project's whole path.
 */
export type Forge = { forge: "github"; repo?: string } | { forge: "gitlab"; host: string; path: string };

/** The host and the whole path of origin's address. */
export interface Remote {
    host: string;
    /** The path without a trailing `.git`: two to twenty parts, each a name a forge allows. */
    path: string;
}

const PATH_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** GitLab allows a project in a subgroup of a subgroup, up to twenty parts. */
const MAX_PATH_PARTS = 20;

/**
 * The host and the full path of a remote address in any of git's forms with a host (https, ssh, git, or scp style), with any
 * number of groups. Undefined for a local path, and for a path part that could be read as an option or as a step up.
 */
export function parseRemoteAddress(url: string | undefined): Remote | undefined {
    if (!url) return undefined;
    const match =
        /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:]([^\s?#]+?)(?:\.git)?\/?$/.exec(
            url.trim(),
        );
    if (!match) return undefined;
    const [, host, path] = match as unknown as [string, string, string];
    const parts = path.split("/");
    if (parts.length < 2 || parts.length > MAX_PATH_PARTS || !parts.every((part) => PATH_PART.test(part)))
        return undefined;
    return { host, path: parts.join("/") };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** GitLab's hosted service has a second ssh host for networks that block port 22. */
const GITLAB_COM_HOSTS = new Set(["gitlab.com", "altssh.gitlab.com"]);

/**
 * The forge of a repository from its origin, given the `git` section as jig-core loaded it (anything, since it is read from
 * another plugin's settings: what is not in the shape is ignored).
 */
export function forgeOf(remote: Remote | undefined, gitSection: unknown): Forge {
    if (remote === undefined) return { forge: "github" };
    const host = remote.host.toLowerCase();
    const section = isObject(gitSection) ? gitSection : {};
    const forges = isObject(section.forges) ? section.forges : {};
    const entry = Object.entries(forges).find(([name]) => name.toLowerCase() === host)?.[1];
    const configured = isObject(entry) ? entry.forge : entry;
    // The host the forge's own command line is told: the alias in origin's address is for git alone.
    const real =
        isObject(entry) && typeof entry.host === "string" && entry.host !== "" ? entry.host.toLowerCase() : host;
    if (configured === "gitlab") return { forge: "gitlab", host: real, path: remote.path };
    if (configured === "github")
        return real === host ? { forge: "github" } : { forge: "github", repo: `${real}/${remote.path}` };
    const cloneHost = typeof section.cloneHost === "string" ? section.cloneHost.toLowerCase() : "github.com";
    if (host === "github.com" || host === "ssh.github.com" || host.startsWith("github.com-") || host === cloneHost) {
        return { forge: "github" };
    }
    if (GITLAB_COM_HOSTS.has(host)) return { forge: "gitlab", host: "gitlab.com", path: remote.path };
    return { forge: "github" };
}
