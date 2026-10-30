// A fake GitHub behind git's ssh transport. "GitHub" is a folder of bare repositories (`<root>/<owner>/<name>.git`), and
// "ssh" is a script that git runs in place of the real one (GIT_SSH). Git's ssh transport, the arguments git builds, the
// temporary folder and the rename are all real; only the network is replaced, so nothing here reaches the internet or the
// user's keys.
import fs from "node:fs";
import path from "node:path";
import { git, setEnv } from "./repos.ts";
import type { Sandbox } from "./repos.ts";

export type SshMode = "serve" | "deny" | "unresolvable" | "hang";

export interface FakeGithub {
    /** Where the bare repositories live: `<root>/<owner>/<name>.git`. */
    root: string;
    /** The arguments the fake ssh was started with, one line each. */
    sshCalls(): string[];
    /** How the fake ssh answers from now on. */
    mode(mode: SshMode): void;
    /** The pid of the last ssh process in hang mode, to check that it was stopped. */
    sshPid(): number | undefined;
    /** Removes every repository and forgets the ssh log, between tests. */
    clear(): void;
    /** A bare repository `owner/name` with `main` (and the extra branches), a README and an AGENTS.md. */
    addRepo(slug: string, options?: { branches?: string[]; tags?: string[]; empty?: boolean }): string;
}

const SCRIPT = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/ssh.log"
while [ $# -gt 0 ]; do
    case "$1" in
        -o|-p|-i|-l|-F) shift 2 ;;
        -*) shift ;;
        *) break ;;
    esac
done
host="$1"; shift
mode="$(cat "$dir/mode" 2>/dev/null || echo serve)"
case "$mode" in
    deny) echo "$host: Permission denied (publickey)." >&2; echo "fatal: Could not read from remote repository." >&2; exit 255 ;;
    unresolvable) echo "ssh: Could not resolve hostname \${host#*@}: Name or service not known" >&2; exit 255 ;;
    hang) echo $$ > "$dir/ssh.pid"; exec sleep 600 ;;
esac
cmd="$*"
cd "$dir/remote" && exec sh -c "git \${cmd#git-}"
`;

/** Puts a fake GitHub behind git's ssh transport until the sandbox is cleaned up. */
export function installFakeGithub(sb: Sandbox): FakeGithub {
    const dir = path.join(sb.root, "fake-github");
    const root = path.join(dir, "remote");
    fs.mkdirSync(root, { recursive: true });
    const script = path.join(dir, "ssh");
    fs.writeFileSync(script, SCRIPT, { mode: 0o755 });
    setEnv("GIT_SSH", script);
    setEnv("GIT_SSH_VARIANT", "ssh");
    const log = path.join(dir, "ssh.log");
    return {
        root,
        sshCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
        mode: (mode) => fs.writeFileSync(path.join(dir, "mode"), mode),
        sshPid: () => {
            const file = path.join(dir, "ssh.pid");
            return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : undefined;
        },
        clear() {
            fs.rmSync(root, { recursive: true, force: true });
            fs.mkdirSync(root, { recursive: true });
            for (const name of ["ssh.log", "ssh.pid"]) fs.rmSync(path.join(dir, name), { force: true });
        },
        addRepo(slug, options = {}) {
            const bare = path.join(root, `${slug}.git`);
            fs.mkdirSync(path.dirname(bare), { recursive: true });
            git(sb.root, "init", "-q", "--bare", "-b", "main", bare);
            if (options.empty) return bare;
            const seed = path.join(
                sb.root,
                "seed",
                `${slug.replace("/", "-")}-${Math.random().toString(36).slice(2, 8)}`,
            );
            fs.mkdirSync(seed, { recursive: true });
            git(seed, "init", "-q", "-b", "main");
            fs.writeFileSync(path.join(seed, "README.md"), `# ${slug}\n`);
            git(seed, "add", "-A");
            git(seed, "commit", "-q", "-m", "Initial commit");
            for (const branch of options.branches ?? []) {
                git(seed, "switch", "-q", "-c", branch);
                fs.writeFileSync(path.join(seed, "branch.txt"), `${branch}\n`);
                git(seed, "add", "-A");
                git(seed, "commit", "-q", "-m", `On ${branch}`);
                git(seed, "switch", "-q", "main");
            }
            for (const tag of options.tags ?? []) git(seed, "tag", tag);
            git(seed, "push", "-q", "--all", bare);
            git(seed, "push", "-q", "--tags", bare);
            return bare;
        },
    };
}

/** Whether a process is alive. */
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
