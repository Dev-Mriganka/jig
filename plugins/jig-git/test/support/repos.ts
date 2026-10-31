// Real repositories for the tests. A "remote" is a bare repository in a temporary folder, and a "clone" is a normal
// repository that was cloned from it, so push, fetch and tracking all work as they do against a hosting service. HOME
// and the git configuration are redirected into the temporary folder, so nothing here touches the user's own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAVED = new Map<string, string | undefined>();

/** Sets an environment variable until the sandbox is cleaned up. */
export function setEnv(name: string, value: string): void {
    if (!SAVED.has(name)) SAVED.set(name, process.env[name]);
    process.env[name] = value;
}

export interface Sandbox {
    root: string;
    /** The folder that holds the repositories; Pi's working directory in most tests. */
    workspace: string;
    cleanup(): void;
}

/**
 * A temporary root with HOME and the git configuration redirected into it, and a fixed git identity. By default "GitHub" is a
 * folder (see below); `github: "real"` leaves github.com alone, for the tests that go to the real one.
 */
export function sandbox(options: { github?: "folder" | "real" } = {}): Sandbox {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jig-git-")));
    const workspace = path.join(root, "ws");
    const home = path.join(root, "home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(home);
    // "GitHub" is a folder: a remote URL that looks like git@github.com:acme/svc.git is a bare repository in it. So are "GitLab"
    // (git@gitlab.com:) and a self-hosted GitLab (git@gitlab.example.com:). The rule is in the global configuration, as a person
    // would put it, so the repositories' own .git/config stays plain.
    const remotes = path.join(root, "remotes");
    const redirect =
        options.github === "real"
            ? ""
            : `[url "${remotes}/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = git@gitlab.com:\n\tinsteadOf = git@gitlab.example.com:\n`;
    fs.writeFileSync(
        path.join(home, ".gitconfig"),
        `[user]\n\tname = Test Author\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n${redirect}`,
    );
    setEnv("HOME", home);
    setEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
    setEnv("GIT_CONFIG_NOSYSTEM", "1");
    setEnv("GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig"));
    return {
        root,
        workspace,
        cleanup() {
            for (const [name, value] of SAVED) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            SAVED.clear();
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

/** Synchronous git for fixtures and assertions. */
export function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function writeFile(dir: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

export function commitFile(dir: string, file: string, content: string, message: string): string {
    writeFile(dir, file, content);
    git(dir, "add", "--", file);
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
}

export interface Fixture {
    name: string;
    /** The clone, at `<workspace>/<name>`. */
    dir: string;
    /** The bare repository it was cloned from. */
    origin: string;
}

/**
 * A clone at `<workspace>/<name>` on `main`, tracking `origin/main`. The bare origin has one commit on main, and
 * `origin/HEAD` is set, as it is after a real clone. With `owner`, origin's URL is `git@<host>:<owner>/<name>.git`, which
 * the sandbox's git configuration maps to the bare repository, so forge-aware code finds a repository on a forge: GitHub by
 * default, or `gitlab.com` or `gitlab.example.com` for `host`. An `owner` may have groups (`platform/payments`).
 */
export function makeRepo(
    sb: Sandbox,
    name: string,
    owner?: string,
    host: "github.com" | "gitlab.com" | "gitlab.example.com" = "github.com",
): Fixture {
    const origin = path.join(sb.root, "remotes", ...(owner ? [owner] : []), `${name}.git`);
    fs.mkdirSync(path.dirname(origin), { recursive: true });
    git(sb.root, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(sb.root, "seed", name);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    commitFile(seed, "README.md", `# ${name}\n`, "Initial commit");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    const dir = path.join(sb.workspace, name);
    git(sb.workspace, "clone", "-q", origin, dir);
    if (owner) git(dir, "remote", "set-url", "origin", `git@${host}:${owner}/${name}.git`);
    return { name, dir, origin };
}

/** Advances `origin/<branch>` by a commit made in a separate clone, as a teammate would. */
export function teammateCommit(sb: Sandbox, fixture: Fixture, branch: string, file: string, message: string): string {
    const other = path.join(sb.root, "teammate", `${fixture.name}-${Math.random().toString(36).slice(2, 8)}`);
    git(sb.root, "clone", "-q", "--branch", branch, fixture.origin, other);
    const sha = commitFile(other, file, `${message}\n`, message);
    git(other, "push", "-q", "origin", branch);
    return sha;
}
