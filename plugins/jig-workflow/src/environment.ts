// The plain environment variables of a test command (`env` of a `workflow.tests` entry, such as `JAVA_HOME` to pick a JDK for one
// repository): what is accepted, how `~` expands, and the shell text that sets them where a run has no environment of its own.
// A credential does not belong in this file, so a name that looks like one is refused with the way to give it properly.
import path from "node:path";

export const MAX_ENV_ENTRIES = 20;
/** The command and its variables are shown whole when a run needs your approval, and a long text cannot be read there. */
export const MAX_ENV_VALUE = 1000;
const NAME = /^[A-Z_][A-Z0-9_]*$/;

// The names that jig-sandbox removes from the environment of a sandboxed command because they look like credentials
// (plugins/jig-sandbox/src/env.ts). A plugin does not import another's modules, so the lists are copied, and a test compares
// the two on a long list of names. A name that would be removed there is refused here, so that a token never sits in a plain file.
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /TOKEN/i,
    /SECRET/i,
    /PASSWORD/i,
    /PASSWD/i,
    /_KEY$/i,
    /APIKEY/i,
    /CREDENTIAL/i,
    /^AWS_/i,
    /^AZURE_/i,
    /^GH_/i,
    /^GITHUB_/i,
    /^VAULT_/i,
];
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
    "GOOGLE_APPLICATION_CREDENTIALS",
    "NPM_TOKEN",
    "KUBECONFIG",
    "SSH_AUTH_SOCK",
    "GPG_AGENT_INFO",
    "DBUS_SESSION_BUS_ADDRESS",
    "WSL_INTEROP",
]);

/** Whether a variable of this name looks like a credential: the sandbox would take it out of a command's environment. */
export function looksLikeCredential(name: string): boolean {
    return CREDENTIAL_NAMES.has(name.toUpperCase()) || CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The errors in the `env` of an entry (`at` is the entry's key, as the messages write it). An empty list means it is valid. */
export function validateEnv(env: unknown, at: string): string[] {
    if (!isObject(env)) return [`${at}.env: must be an object from a variable name to its value`];
    const errors: string[] = [];
    const names = Object.keys(env);
    if (names.length > MAX_ENV_ENTRIES) errors.push(`${at}.env: at most ${MAX_ENV_ENTRIES} variables`);
    for (const name of names) {
        const value = env[name];
        if (!NAME.test(name)) {
            errors.push(
                `${at}.env: ${JSON.stringify(name.slice(0, 40))} is not a variable name: capital letters, digits and _, and not a digit first`,
            );
        } else if (looksLikeCredential(name)) {
            errors.push(
                `${at}.env.${name}: this name looks like a credential, and credentials belong in a secret reference, not here`,
            );
        } else if (typeof value !== "string") {
            errors.push(`${at}.env.${name}: must be text`);
        } else if (value.includes("\u0000")) {
            errors.push(`${at}.env.${name}: must not contain a NUL character`);
        } else if (value.length > MAX_ENV_VALUE) {
            errors.push(`${at}.env.${name}: at most ${MAX_ENV_VALUE} characters`);
        }
    }
    return errors;
}

/**
 * The value with `~` written as the home folder: at the start, and after a `:` (a list such as `PATH`), when what follows is `/`,
 * the next `:` or the end. `~user` and a `~` in the middle of a word stay as they are.
 */
export function expandHome(value: string, home: string): string {
    return value
        .split(":")
        .map((part) => (part === "~" ? home : part.startsWith("~/") ? path.join(home, part.slice(2)) : part))
        .join(":");
}

/** The variables of a validated `env` with `~` expanded, in the order they were written. */
export function expandedEnv(env: Record<string, unknown>, home: string): Record<string, string> {
    return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, expandHome(String(value), home)]));
}

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A word for `sh`: as it is when nothing in it means anything to a shell, else in single quotes. */
export function shellWord(value: string): string {
    return PLAIN_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The command with its variables set first, for a run that has no environment of its own to give (the sandbox's `run` and the
 * `bash` tool take a command and nothing else). The values are quoted: none is expanded or run by the shell.
 */
export function withEnvironment(command: string, env: Readonly<Record<string, string>> | undefined): string {
    const entries = Object.entries(env ?? {});
    if (entries.length === 0) return command;
    return `export ${entries.map(([name, value]) => `${name}=${shellWord(value)}`).join(" ")} && ${command}`;
}

/** Control characters made visible, so that a value cannot hide itself in a question. */
function visible(text: string): string {
    return text.replace(
        /[\u0000-\u001f\u007f-\u009f]/g,
        (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}

/** The lines that say which variables a command runs with, for a question: none when it has none. */
export function environmentLines(env: Readonly<Record<string, string>> | undefined, indent = "    "): string[] {
    const entries = Object.entries(env ?? {});
    return entries.length === 0
        ? []
        : [`${indent}with ${entries.map(([name, value]) => `${name}=${visible(value)}`).join(" ")}`];
}
