// Paths that Pi's own file tools (read, write, edit, grep, find, ls) must not touch, on top of Jig's built-in list (`~/.ssh`,
// `~/.aws`, `~/.config/gh` and so on). A real company lists where its own command-line tools keep a login.
//
// `secret` paths are neither read nor written. `guarded` paths can be read but not written, which suits a tool's code or
// settings that the agent may look at and must not change. Paths are absolute or start with `~/`. This can only add: nothing
// removes a built-in path or one the user listed.
import type { JigApi } from "./jig/types.ts";

/** Where Acme's command-line tool, `acme`, keeps the session it signed in with. */
export const ACME_LOGIN = "~/.acme/credentials.json";

export const PROTECTED_PATHS: { secret: readonly string[]; guarded: readonly string[] } = {
    secret: [ACME_LOGIN],
    guarded: [],
};

export function registerProtection(api: JigApi): void {
    api.config.addProtectedPaths(PROTECTED_PATHS);
}
