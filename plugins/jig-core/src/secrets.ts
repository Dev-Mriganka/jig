// Secrets: resolving a reference such as `pass:work/token` to its value, just before a Jig tool needs it.
//
// The reference says where the secret lives; the value never appears in what the model sees, in output, in records or
// on a command line. Every resolved value is registered with the redactor, which removes it (and its encodings) from
// every tool result until Pi exits.
//
//   pass:<entry>              the pass password store; the first line of the entry
//   env:<NAME>                an environment variable of the Pi process
//   keychain:<service>/<account>   the macOS Keychain (the part before the first `/` is the service)
//   op://<vault>/<item>/<field>    the 1Password command-line tool
//
// Only the backends listed in `secrets.backends` may resolve a reference (the default is `pass` alone).
import { errorMessage } from "./errors.ts";
import { run as defaultRun } from "./exec.ts";
import type { RunOptions, RunResult } from "./contract.ts";
import { SECRET_BACKENDS } from "./config.ts";
import type { SecretBackend } from "./config.ts";
import type { Redactor } from "./redact.ts";

export type SecretErrorCode = "invalid_ref" | "backend_disabled" | "missing" | "locked" | "unavailable";

/** Why a secret could not be resolved. The message never holds the reference text or a value, because a mistaken
 *  reference may be a pasted secret. */
export class SecretError extends Error {
    readonly code: SecretErrorCode;
    constructor(code: SecretErrorCode, message: string) {
        super(message);
        this.name = "SecretError";
        this.code = code;
    }
}

export interface Secrets {
    resolve(ref: string, signal?: AbortSignal): Promise<string>;
}

export interface SecretsOptions {
    /** The backends allowed right now (read on every call, so a configuration reload applies). */
    backends: () => readonly string[];
    redactor: Redactor;
    /** How programs are started. Tests pass a fake. */
    run?: (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;
    /** Pi's environment, for the variables a backend needs. */
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Longest a backend may take, including time for the user to unlock it. Default 60 s. */
    timeoutMs?: number;
}

const PASS_ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_.@+/-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 1Password references: `op://vault/item/field`, optionally with a section before the field. No spaces or control
 *  characters. */
const OP_REF = /^op:\/\/[^\s/\u0000-\u001f\u007f]+(?:\/[^\s/\u0000-\u001f\u007f]+){2,3}$/;
const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Variables a `pass` run needs to find the store and to show a graphical passphrase prompt. */
const PASS_ENV = [
    "PASSWORD_STORE_DIR",
    "GNUPGHOME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
];

export function createSecrets(options: SecretsOptions): Secrets {
    const run = options.run ?? defaultRun;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Callers that need the same secret at the same moment share one lookup, and a locked store asks to be unlocked
    // once: lookups through the same program run one after another, so the first unlocks it for the rest.
    const inFlight = new Map<string, Promise<string>>();
    const queues = new Map<string, Promise<unknown>>();

    function inTurn<T>(program: string, job: () => Promise<T>): Promise<T> {
        const turn = (queues.get(program) ?? Promise.resolve()).then(job, job);
        queues.set(
            program,
            turn.catch(() => undefined),
        );
        return turn;
    }

    async function ask(
        program: string,
        args: string[],
        programEnv: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<RunResult> {
        return inTurn(program, () =>
            run(program, args, {
                env: programEnv,
                timeoutMs,
                maxOutputBytes: MAX_SECRET_BYTES,
                ...(signal === undefined ? {} : { signal }),
            }),
        );
    }

    function fromEnvironment(name: string): string {
        if (!ENV_NAME.test(name)) {
            throw new SecretError(
                "invalid_ref",
                "an env: reference names an environment variable with letters, digits and _ only",
            );
        }
        const value = env[name];
        if (value === undefined || value === "")
            throw new SecretError("missing", `the environment variable ${name} is not set`);
        return value;
    }

    async function fromPass(entry: string, signal: AbortSignal | undefined): Promise<string> {
        if (!PASS_ENTRY.test(entry) || entry.split("/").some((part) => part === "" || part === "." || part === "..")) {
            throw new SecretError("invalid_ref", "a pass: entry uses letters, digits and . _ @ + - / only");
        }
        const passEnv: Record<string, string> = { LC_ALL: "C" };
        for (const name of PASS_ENV) {
            const value = env[name];
            if (value !== undefined) passEnv[name] = value;
        }
        const result = await runBackend("pass", ["show", entry], passEnv, signal);
        if (result.code === 0) {
            const value = firstLine(result.stdout);
            if (value === "") throw new SecretError("missing", "the pass entry is empty");
            return value;
        }
        if (/is not in the password store/i.test(result.stderr))
            throw new SecretError("missing", "the pass entry does not exist");
        if (/pinentry|inappropriate ioctl|passphrase|cancelled|decryption failed|no secret key/i.test(result.stderr)) {
            throw new SecretError(
                "locked",
                "the pass store is locked: unlock it (for example run `pass show` in a terminal) and try again",
            );
        }
        throw new SecretError("unavailable", "pass failed: check that pass and gpg work");
    }

    async function fromKeychain(rest: string, signal: AbortSignal | undefined): Promise<string> {
        if (platform !== "darwin") throw new SecretError("unavailable", "the keychain backend needs macOS");
        const slash = rest.indexOf("/");
        const service = slash < 0 ? "" : rest.slice(0, slash);
        const account = slash < 0 ? "" : rest.slice(slash + 1);
        // Control characters and a leading dash do not belong in a service or account name; the dash would read as an option.
        const fine = (part: string) => part !== "" && !part.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(part);
        if (!fine(service) || !fine(account)) {
            throw new SecretError("invalid_ref", "a keychain: reference is keychain:<service>/<account>");
        }
        const result = await runBackend(
            "security",
            ["find-generic-password", "-s", service, "-a", account, "-w"],
            {},
            signal,
        );
        if (result.code !== 0) throw new SecretError("missing", "the keychain has no such item, or it is locked");
        return withoutFinalNewline(result.stdout);
    }

    async function fromOnePassword(ref: string, signal: AbortSignal | undefined): Promise<string> {
        if (!OP_REF.test(ref))
            throw new SecretError("invalid_ref", "an op:// reference is op://<vault>/<item>/<field>");
        const opEnv: Record<string, string> = {};
        for (const [name, value] of Object.entries(env))
            if (name.startsWith("OP_") && value !== undefined) opEnv[name] = value;
        const result = await runBackend("op", ["read", ref], opEnv, signal);
        if (result.code !== 0)
            throw new SecretError("missing", "1Password could not read the item: is it there, and are you signed in?");
        return withoutFinalNewline(result.stdout);
    }

    /** Starts a backend program and turns "could not run" and "took too long" into one clear error each. */
    async function runBackend(
        program: string,
        args: string[],
        backendEnv: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<RunResult> {
        let result: RunResult;
        try {
            result = await ask(program, args, backendEnv, signal);
        } catch (error) {
            throw new SecretError("unavailable", `${program} could not run: ${errorMessage(error)}`);
        }
        if (result.timedOut)
            throw new SecretError("unavailable", `${program} did not answer in ${Math.round(timeoutMs / 1000)} s`);
        return result;
    }

    async function lookup(ref: string, signal: AbortSignal | undefined): Promise<string> {
        const parsed = parse(ref);
        if (parsed === undefined) {
            // The reference is not echoed: a pasted secret value must not end up in an error.
            throw new SecretError(
                "invalid_ref",
                "not a secret reference: use pass:<entry>, env:<NAME>, keychain:<service>/<account> or op://<vault>/<item>/<field>",
            );
        }
        if (!options.backends().includes(parsed.backend)) {
            throw new SecretError(
                "backend_disabled",
                `the ${parsed.backend} secret backend is not enabled: add "${parsed.backend}" to secrets.backends in jig.json`,
            );
        }
        let value: string;
        switch (parsed.backend) {
            case "env":
                value = fromEnvironment(parsed.rest);
                break;
            case "pass":
                value = await fromPass(parsed.rest, signal);
                break;
            case "keychain":
                value = await fromKeychain(parsed.rest, signal);
                break;
            case "op":
                value = await fromOnePassword(ref, signal);
                break;
        }
        // Registered before it is returned, so it is hidden from output from this moment on.
        options.redactor.register(value);
        return value;
    }

    return {
        resolve(ref, signal) {
            if (typeof ref !== "string")
                return Promise.reject(new SecretError("invalid_ref", "a secret reference is a string"));
            const pending = inFlight.get(ref);
            if (pending !== undefined) return pending;
            const started = lookup(ref, signal).finally(() => inFlight.delete(ref));
            inFlight.set(ref, started);
            return started;
        },
    };
}

function parse(ref: string): { backend: SecretBackend; rest: string } | undefined {
    if (ref.startsWith("op://")) return { backend: "op", rest: ref };
    const match = /^(pass|env|keychain):([\s\S]+)$/.exec(ref);
    if (match === null) return undefined;
    const backend = match[1] as string;
    if (!(SECRET_BACKENDS as readonly string[]).includes(backend)) return undefined;
    return { backend: backend as SecretBackend, rest: match[2] as string };
}

function firstLine(text: string): string {
    const end = text.search(/\r?\n/);
    return end === -1 ? text : text.slice(0, end);
}

function withoutFinalNewline(text: string): string {
    return text.replace(/\r?\n$/, "");
}
