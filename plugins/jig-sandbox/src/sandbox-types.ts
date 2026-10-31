// The shapes the sandbox is built from and hands out: its state, what the network modes need from the plugin around it, everything the
// sandbox is given (`SandboxDeps`), what `prepare` returns for one command, and what a command run for the sandbox's own sake printed.
// Types only, so sandbox.ts is the class and nothing else.
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { Allowed } from "./allowed.ts";
import type { Broker, BrokerLaunch } from "./broker-client.ts";
import type { NetworkMode, SandboxSettings } from "./config.ts";
import type { FileView } from "./files.ts";
import type { Screen } from "./network/ask-host.ts";
import type { BridgeDeps } from "./network/bridge.ts";
import type { PolicyDeps } from "./network/policy.ts";
import type { ProtectedEntry, RuleSet } from "./rules.ts";

export type SandboxState =
    | { kind: "starting" }
    | { kind: "ready" }
    | { kind: "unavailable"; reason: string }
    /** The user turned it off for this session with `/sandbox off`. */
    | { kind: "off" }
    | { kind: "stopped" };

/** What the `filtered` and `ask` network modes need from the plugin around the sandbox. All of it is optional. */
export interface NetworkDeps {
    /** What you allowed; hosts you answered `This session` or `Always` for are kept here. Default: nothing kept. */
    allowed?: Allowed;
    /** The screen to ask on, or undefined for none. Default: none, so `ask` refuses every new host. */
    screen?: () => Screen | undefined;
    /** Runs a question in jig-core's queue. Default: at once. */
    inTurn?: <T>(job: () => Promise<T>) => Promise<T>;
    /** Says something to you that is not an answer to a command. */
    notify?: (message: string) => void;
    /** Tests only: the parts that make the policy and the bridge reach outside the test. */
    range?: PolicyDeps["range"];
    own?: PolicyDeps["own"];
    onceMs?: number;
    processes?: BridgeDeps["processes"];
    enter?: BridgeDeps["enter"];
    python?: string | undefined;
}

export interface SandboxDeps {
    brokerScript: string;
    /** Pi's environment. */
    env: NodeJS.ProcessEnv;
    files: FileView;
    platform: NodeJS.Platform;
    /** The home folder from the password database. */
    home: () => string;
    uid: number;
    wsl: boolean;
    /** Where the per-session folders go: the system's temporary folder. */
    tmpRoot: string;
    agentDir: () => string;
    settings: () => SandboxSettings;
    protectedPaths: () => ProtectedEntry[];
    /** The folders of the Node.js and Pi that run Pi. */
    runtimePaths: () => string[];
    /** The ask-first folders the user allowed. */
    approved: () => string[];
    createdByAgent: Set<string>;
    startBroker: (launch: BrokerLaunch) => Promise<Broker>;
    /** Runs a wrapped command with a shell, the way Pi runs one. */
    exec: BashOperations["exec"];
    /** For a name that is not guessed. */
    random: () => string;
    now: () => number;
    network?: NetworkDeps;
}

/** What `prepare` hands the caller: the command to spawn and the environment to spawn it with. */
export interface Prepared {
    wrapped: string;
    env: NodeJS.ProcessEnv;
    /** Credential values to replace if they show up in output. */
    values: string[];
    rules: RuleSet;
    mode: NetworkMode;
    commandId: string;
    /** Ends the command in the broker. Safe to call twice. */
    finish(): Promise<{ violations: Array<{ line: string }> }>;
}

/** What a command run for the sandbox's own sake (the start-up probe, the doctor) printed. */
export interface Captured {
    exitCode: number | null;
    output: string;
}
