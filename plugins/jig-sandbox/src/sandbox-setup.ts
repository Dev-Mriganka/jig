// What the sandbox is set up with before any command runs: the session's private folders (and the removal of those a crash left behind),
// and the base configuration given to the runtime. Both are plain functions of what they are given, so they are apart from the class
// that holds the session's state.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { NetworkMode } from "./config.ts";
import type { FoundPrograms } from "./programs.ts";
import type { SandboxDeps } from "./sandbox-types.ts";

const STALE_SESSION_MS = 24 * 3_600_000;

/** Makes the session's private folders and returns the session folder: `broker/` for the broker, `tmp/` for the commands. */
export function makeSessionFolders(
    deps: Pick<SandboxDeps, "tmpRoot" | "uid" | "files" | "now">,
    sessionId: string,
): string {
    const root = path.join(deps.tmpRoot, `jig-sandbox-${deps.uid}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    removeStaleSessions(deps, root);
    const short = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
    const folder = mkdtempSync(path.join(root, `${short}-`));
    mkdirSync(path.join(folder, "broker"), { mode: 0o700 });
    mkdirSync(path.join(folder, "tmp"), { mode: 0o700 });
    return deps.files.real(folder) ?? folder;
}

/** Session folders that a crash left behind: nothing in them is wanted a day later. */
function removeStaleSessions(deps: Pick<SandboxDeps, "files" | "now">, root: string): void {
    for (const name of deps.files.list(root)) {
        const folder = path.join(root, name);
        try {
            if (deps.now() - statSync(folder).mtimeMs > STALE_SESSION_MS)
                rmSync(folder, { recursive: true, force: true });
        } catch {
            // Not ours to worry about.
        }
    }
}

/** The runtime's configuration for the whole session. The file-system rules come with each command. */
export function runtimeConfig(
    mode: NetworkMode,
    found: FoundPrograms["found"],
    removedNames: readonly string[],
): Record<string, unknown> {
    return {
        // Network `open` is the absence of an allow list: the runtime then leaves the network alone. `off` is an empty one
        // that nothing may widen. `filtered` and `ask` are an empty one that nothing widens either, except through the
        // callback, which asks this plugin about each host (see `network/policy.ts`): the allow and deny lists are read
        // there, and not given to the runtime, since a list entry the runtime decides is not checked for a private address.
        network:
            mode === "off"
                ? { allowedDomains: [], deniedDomains: [], strictAllowlist: true }
                : mode === "open"
                  ? { deniedDomains: [] }
                  : { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [], allowGitConfig: true },
        // The environment is cleaned before the command starts; the runtime removes the same names a second time.
        credentials: { envVars: removedNames.map((name) => ({ name, mode: "deny" })) },
        ...(found.bwrap === undefined ? {} : { bwrapPath: found.bwrap }),
        ...(found.socat === undefined ? {} : { socatPath: found.socat }),
        ...(found.ripgrep === undefined ? {} : { ripgrep: { command: found.ripgrep } }),
        // The runtime looks for dangerous files near the folder it runs in, the session's, which holds none.
        mandatoryDenySearchDepth: 1,
    };
}
