// The `sandbox` section of jig.json. jig-core checks it with validateSandbox when it loads, so the rest of the plugin
// reads a section that is valid, or absent. Every field is optional.
import path from "node:path";
import { readRolePolicy } from "../../jig-core/src/kit/role-policy.ts";

export type NetworkMode = "open" | "filtered" | "ask" | "off";

export interface SandboxSettings {
    /** Folders writable although a rule hides them, such as a Windows work folder under `/mnt`. */
    share: string[];
    hide: string[];
    lock: string[];
    network: {
        mode: NetworkMode;
        /** For `ask`: hosts allowed without asking. In `filtered` every public host is allowed already. */
        allow: string[];
        deny: string[];
        localhost: number[];
    };
    env: { keep: string[] };
    docker: boolean;
    background: {
        /** Tasks running at once. */
        maxTasks: number;
        /** The longest run, and the default deadline. */
        maxRuntimeMinutes: number;
        /** Finished tasks kept for `bg_list` and `bg_output`. */
        keepFinished: number;
        /** `off` sends the messages without waking the agent. */
        wake: "on" | "off";
    };
    /** Where the programs the runtime needs are, when they are not on `PATH`. Absolute paths. */
    programs: { bwrap?: string; socat?: string; ripgrep?: string };
    /**
     * True in a child agent whose role may not write: its home folder and working folder are locked. Never read from `jig.json` (a
     * field of the section cannot set it) and never switched off by it: it comes from the environment the child was started in.
     */
    readOnly: boolean;
}

export const DEFAULT_SETTINGS: SandboxSettings = {
    share: [],
    hide: [],
    lock: [],
    network: { mode: "open", allow: [], deny: [], localhost: [] },
    env: { keep: [] },
    docker: false,
    background: { maxTasks: 4, maxRuntimeMinutes: 240, keepFinished: 12, wake: "on" },
    programs: {},
    readOnly: false,
};

const MODES: readonly NetworkMode[] = ["open", "filtered", "ask", "off"];
const FIELDS: ReadonlySet<string> = new Set([
    "share",
    "hide",
    "lock",
    "network",
    "env",
    "docker",
    "background",
    "programs",
]);
const BACKGROUND_FIELDS: ReadonlySet<string> = new Set(["maxTasks", "maxRuntimeMinutes", "keepFinished", "wake"]);
const NETWORK_FIELDS: ReadonlySet<string> = new Set(["mode", "allow", "deny", "localhost"]);
const PROGRAMS: readonly string[] = ["bwrap", "socat", "ripgrep"];

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function isStrings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

/** `~`, `~/x` or an absolute path: the only forms a path in this section may take. */
function isListable(text: string): boolean {
    return text === "~" || text.startsWith("~/") || path.posix.isAbsolute(text);
}

/** A host for `allow` and `deny`: a name or `*.name`, with an optional `:port`. */
function isHost(text: string): boolean {
    return /^(?:\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(text);
}

const isPort = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

/**
 * The errors in a raw `sandbox` section, each naming its key. An empty list means the section is valid. A misspelt field
 * is an error and not a silent default: `shar` would otherwise leave a work folder read-only without a word.
 */
export function validateSandbox(raw: unknown): string[] {
    if (!isObject(raw)) return ["sandbox: must be an object"];
    const errors: string[] = [];
    for (const name of Object.keys(raw)) if (!FIELDS.has(name)) errors.push(`sandbox.${name}: unknown field`);

    for (const name of ["share", "hide", "lock"] as const) {
        const value = raw[name];
        if (value === undefined) continue;
        if (!isStrings(value)) errors.push(`sandbox.${name}: must be a list of paths`);
        else
            for (const item of value)
                if (!isListable(item)) errors.push(`sandbox.${name}: "${item}" must be absolute or start with ~/`);
    }

    const network = raw.network;
    if (network !== undefined) {
        if (!isObject(network)) errors.push("sandbox.network: must be an object");
        else {
            for (const name of Object.keys(network)) {
                if (!NETWORK_FIELDS.has(name)) errors.push(`sandbox.network.${name}: unknown field`);
            }
            if (network.mode !== undefined && !MODES.includes(network.mode as NetworkMode)) {
                errors.push(`sandbox.network.mode: must be one of ${MODES.join(", ")}`);
            }
            for (const name of ["allow", "deny"] as const) {
                const value = network[name];
                if (value === undefined) continue;
                if (!isStrings(value)) errors.push(`sandbox.network.${name}: must be a list of hosts`);
                else
                    for (const item of value)
                        if (!isHost(item))
                            errors.push(
                                `sandbox.network.${name}: "${item}" is not a host such as api.example.com or *.example.com:443`,
                            );
            }
            const ports = network.localhost;
            if (ports !== undefined && !(Array.isArray(ports) && ports.every(isPort))) {
                errors.push("sandbox.network.localhost: must be a list of ports from 1 to 65535");
            }
        }
    }

    const env = raw.env;
    if (env !== undefined) {
        if (!isObject(env)) errors.push("sandbox.env: must be an object");
        else {
            for (const name of Object.keys(env)) if (name !== "keep") errors.push(`sandbox.env.${name}: unknown field`);
            if (
                env.keep !== undefined &&
                !(isStrings(env.keep) && env.keep.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
            ) {
                errors.push("sandbox.env.keep: must be a list of variable names");
            }
        }
    }

    if (raw.docker !== undefined && typeof raw.docker !== "boolean")
        errors.push("sandbox.docker: must be true or false");

    const background = raw.background;
    if (background !== undefined) {
        if (!isObject(background)) errors.push("sandbox.background: must be an object");
        else {
            for (const name of Object.keys(background)) {
                if (!BACKGROUND_FIELDS.has(name)) errors.push(`sandbox.background.${name}: unknown field`);
            }
            for (const name of ["maxTasks", "maxRuntimeMinutes", "keepFinished"] as const) {
                const value = background[name];
                if (value !== undefined && !(typeof value === "number" && Number.isInteger(value) && value >= 1)) {
                    errors.push(`sandbox.background.${name}: must be a whole number of at least 1`);
                }
            }
            if (background.wake !== undefined && background.wake !== "on" && background.wake !== "off") {
                errors.push("sandbox.background.wake: must be on or off");
            }
        }
    }

    const programs = raw.programs;
    if (programs !== undefined) {
        if (!isObject(programs)) errors.push("sandbox.programs: must be an object");
        else {
            for (const name of Object.keys(programs)) {
                if (!PROGRAMS.includes(name))
                    errors.push(`sandbox.programs.${name}: unknown field (bwrap, socat or ripgrep)`);
                else if (typeof programs[name] !== "string" || !path.posix.isAbsolute(programs[name] as string)) {
                    errors.push(`sandbox.programs.${name}: must be an absolute path`);
                }
            }
        }
    }
    return errors;
}

/**
 * A warning when `network.deny` lists hosts that nothing refuses: the list is read by the proxy that `filtered` and `ask`
 * route every command through, and `open` has none. Undefined when there is nothing to warn about. `allow` needs no warning:
 * it only lets hosts through, and `open` lets every host through.
 */
export function denyNotApplied(settings: Pick<SandboxSettings, "network">): string | undefined {
    const { mode, deny } = settings.network;
    if (mode !== "open" || deny.length === 0) return undefined;
    const shown = deny.length > 5 ? `${deny.slice(0, 5).join(", ")} and ${deny.length - 5} more` : deny.join(", ");
    return (
        `sandbox.network.deny (${shown}) does nothing in the open network mode: network.allow and network.deny apply in ` +
        "filtered and ask only, so these hosts are NOT refused. Set sandbox.network.mode to filtered or ask to refuse them."
    );
}

/** The settings for the section as `config.section("sandbox")` returns it. A missing or wrong field is the default. */
export function settingsFrom(raw: unknown): SandboxSettings {
    const section = isObject(raw) ? raw : {};
    const strings = (value: unknown): string[] => (isStrings(value) ? [...value] : []);
    const network = isObject(section.network) ? section.network : {};
    const env = isObject(section.env) ? section.env : {};
    const background = isObject(section.background) ? section.background : {};
    const programs = isObject(section.programs) ? section.programs : {};
    const program = (name: string): string | undefined => {
        const value = programs[name];
        return typeof value === "string" && path.posix.isAbsolute(value) ? value : undefined;
    };
    const bwrap = program("bwrap");
    const socat = program("socat");
    const ripgrep = program("ripgrep");
    const whole = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
    return {
        share: strings(section.share),
        hide: strings(section.hide),
        lock: strings(section.lock),
        network: {
            mode: MODES.includes(network.mode as NetworkMode)
                ? (network.mode as NetworkMode)
                : DEFAULT_SETTINGS.network.mode,
            allow: strings(network.allow),
            deny: strings(network.deny),
            localhost: Array.isArray(network.localhost) ? network.localhost.filter(isPort) : [],
        },
        env: { keep: strings(env.keep) },
        docker: section.docker === true,
        background: {
            maxTasks: whole(background.maxTasks, DEFAULT_SETTINGS.background.maxTasks),
            maxRuntimeMinutes: whole(background.maxRuntimeMinutes, DEFAULT_SETTINGS.background.maxRuntimeMinutes),
            keepFinished: whole(background.keepFinished, DEFAULT_SETTINGS.background.keepFinished),
            wake: background.wake === "off" ? "off" : "on",
        },
        programs: {
            ...(bwrap === undefined ? {} : { bwrap }),
            ...(socat === undefined ? {} : { socat }),
            ...(ripgrep === undefined ? {} : { ripgrep }),
        },
        readOnly: false,
    };
}

/**
 * Whether this process is a child agent whose role may not write, from the policy its parent put in the environment. A policy that is
 * there and cannot be read counts as read-only: the sandbox locks more, never less, when it is not sure.
 */
export function readOnlyRole(env: Readonly<Record<string, string | undefined>>): boolean {
    const reading = readRolePolicy(env);
    return reading.kind === "unreadable" || (reading.kind === "policy" && !reading.policy.writes);
}
