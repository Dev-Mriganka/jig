// Commands that a secret reference `cmd:<name>` may run, by name. A company declares the command-line tool that owns its
// login, so Jig holds no token of its own: the tool signs in and Jig reads what it prints.
//
// The first word is the program and the rest are its arguments; no shell is used. A name that the user also declares in
// `secrets.commands` of jig.json takes the user's command. A command runs only when the `cmd` backend is on, so the company turns
// it on for its users with `enableSecretBackends`: this plugin already runs in Pi with the user's rights, so that gives it nothing
// new, and the user can still turn `cmd` off with `secrets.disabledBackends`. The other backends stay the user's to turn on: a
// user who keeps the token in a variable adds `env` to `secrets.backends`.
import type { JigApi } from "./jig/types.ts";

/** `acme auth token` prints a short-lived single sign-on token for the signed-in user. */
export const SECRET_COMMANDS: Readonly<Record<string, readonly string[]>> = {
    "acme-sso": ["acme", "auth", "token"],
};

/** The secret backends Acme turns on: `cmd`, which the sign-in's default token needs. */
export const ENABLED_BACKENDS: readonly string[] = ["cmd"];

export function registerSecretCommands(api: JigApi): void {
    api.config.addSecretCommands(SECRET_COMMANDS);
    api.config.enableSecretBackends(ENABLED_BACKENDS);
}
