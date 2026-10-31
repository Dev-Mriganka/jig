// Commands that a secret reference `cmd:<name>` may run, by name. A company declares the command-line tool that owns its
// login, so Jig holds no token of its own: the tool signs in and Jig reads what it prints.
//
// The first word is the program and the rest are its arguments; no shell is used. A name that the user also declares in
// `secrets.commands` of jig.json takes the user's command. A command runs only when `cmd` is in the user's `secrets.backends`:
// a company plugin cannot turn a secret backend on, so the README of a company plugin tells each user to do it.
import type { JigApi } from "./jig/types.ts";

/** `acme auth token` prints a short-lived single sign-on token for the signed-in user. */
export const SECRET_COMMANDS: Readonly<Record<string, readonly string[]>> = {
    "acme-sso": ["acme", "auth", "token"],
};

export function registerSecretCommands(api: JigApi): void {
    api.config.addSecretCommands(SECRET_COMMANDS);
}
