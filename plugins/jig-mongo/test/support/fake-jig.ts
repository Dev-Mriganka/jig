// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under jig-core.
// Only what jig-mongo uses is real: the section of jig.json, secrets, the kind of an environment, the approved preview, the
// facts, `tunnels` (jig-core's own registry, so what a provider gives is checked as jig-core checks it), and `exec.run`, which
// starts real programs from an argument list with a short environment, as jig-core does. The programs are a fake `ssh`, found
// through a PATH that starts with its folder.
import { spawn } from "node:child_process";
import path from "node:path";
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import { createTunnels } from "../../../jig-core/src/tunnels.ts";
import type {
    EnvironmentKind,
    Facts,
    JigApi,
    Preview,
    RunOptions,
    RunResult,
    ToolDeclaration,
} from "../../../jig-core/src/contract.ts";

/** One program the plugin started. */
export interface Started {
    file: string;
    args: string[];
    options: RunOptions;
}

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    /** The check each plugin registered for its section of jig.json. */
    sections: Map<string, (raw: unknown) => readonly string[]>;
    /** The keys each plugin named that replace a company's defaults instead of merging into them. */
    sectionReplace: Map<string, readonly string[] | undefined>;
    approved: Map<string, Preview>;
    facts: Map<string, Facts[]>;
    /** The lines each plugin asked `/jig` to show. */
    status: Map<string, () => readonly string[]>;
    /** Secret values by reference, and every reference resolved, in order. */
    secrets: Map<string, string>;
    resolved: string[];
    /** The kind of each environment jig-core knows. A name that is not here counts as production, as in jig-core. */
    kinds: Map<string, EnvironmentKind>;
    /** Every program the plugin asked to start, in order. */
    started: Started[];
    /** What `config.section(name)` returns once the section passes its check, as at jig-core's session start. */
    setSection(name: string, value: unknown): void;
    /** The folder that starts the PATH of the programs run. */
    useProgramsIn(bin: string): void;
    publish(): void;
    reset(): void;
    remove(): void;
}

/** What jig-core passes on from Pi's own environment. */
const PASSED_ON = ["HOME", "USER", "LANG", "TMPDIR"];

const defaultKinds = (): Array<[string, EnvironmentKind]> => [
    ["local", "local"],
    ["external", "external"],
    ["production", "production"],
    ["prod", "production"],
    ["staging", "test"],
    ["qa", "test"],
    ["dev", "test"],
];

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const sectionReplace = new Map<string, readonly string[] | undefined>();
    const values = new Map<string, unknown>();
    const approved = new Map<string, Preview>();
    const facts = new Map<string, Facts[]>();
    const status = new Map<string, () => readonly string[]>();
    const secrets = new Map<string, string>();
    const resolved: string[] = [];
    const kinds = new Map<string, EnvironmentKind>(defaultKinds());
    const started: Started[] = [];
    const programs = { bin: "" };
    let tunnels = createTunnels();

    function spawnProgram(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
        return new Promise((resolve, reject) => {
            const env: Record<string, string> = {};
            for (const name of PASSED_ON) {
                const value = process.env[name];
                if (value !== undefined) env[name] = value;
            }
            env.PATH = [programs.bin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
            Object.assign(env, options.env);
            const child = spawn(file, [...args], {
                env,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
            });
            const out: Buffer[] = [];
            const err: Buffer[] = [];
            let stop: "timeout" | "aborted" | undefined;
            const kill = (why: "timeout" | "aborted"): void => {
                stop ??= why;
                try {
                    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
                child.stdout.destroy();
                child.stderr.destroy();
            };
            child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
            const timer = setTimeout(() => kill("timeout"), options.timeoutMs ?? 60_000);
            const onAbort = (): void => kill("aborted");
            if (options.signal?.aborted) onAbort();
            else options.signal?.addEventListener("abort", onAbort, { once: true });
            child.once("error", (error: NodeJS.ErrnoException) => {
                clearTimeout(timer);
                reject(
                    new Error(
                        error.code === "ENOENT" ? `${file} is not installed or not on PATH` : `${file} could not start`,
                    ),
                );
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                if (stop === "aborted") return reject(new Error(`${file} was aborted`));
                const stdout = Buffer.concat(out).toString("utf8");
                const stderr = Buffer.concat(err).toString("utf8");
                if (stop === "timeout") return resolve({ code: 124, stdout, stderr, timedOut: true });
                resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
            });
            child.stdin.on("error", () => {});
            child.stdin.end(options.input);
        });
    }

    const api: JigApi = {
        version: 1,
        declareTool: (declaration) => void declared.set(declaration.tool, declaration),
        approvedPreview: (id) => approved.get(id),
        addFacts: (id, added) => void facts.set(id, [...(facts.get(id) ?? []), added]),
        setTicket: () => {},
        secrets: {
            async resolve(reference) {
                resolved.push(reference);
                const value = secrets.get(reference);
                // Like jig-core, the error does not repeat the reference.
                if (value === undefined) throw new Error("the secret could not be resolved");
                return value;
            },
        },
        environments: { kindOf: (name) => kinds.get(name) ?? "production", list: () => [] },
        tunnels: {
            register: (name, provider) => tunnels.register(name, provider),
            open: (name, target, signal) => tunnels.open(name, target, signal),
        },
        transports: {
            register: () => {},
            request: async () => {
                throw new Error("no transports in tests");
            },
        },
        signIn: {
            register: () => {},
            headers: async () => {
                throw new Error("no sign-in in tests");
            },
        },
        http: {
            request: async () => {
                throw new Error("this fake has no http");
            },
        },

        mask: { text: (input) => input, value: (input) => input },
        watches: {
            registerKind: () => {},
            start: () => {
                throw new Error("no watches in tests");
            },
            list: () => [],
            stop: () => false,
        },
        config: {
            addEnvironments: () => {},
            addRules: () => {},
            addClassifyRules: () => {},
            addProtectedPaths: () => {},
            addSecretCommands: () => {},
            enableSecretBackends: () => {},
            addMaskFields: () => {},
            registerSection: (name, validate, options) => {
                sections.set(name, validate);
                sectionReplace.set(name, options?.replace);
            },
            addSectionDefaults: () => {},
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                // As in jig-core: a section with errors is reported at start-up, and then reads as absent.
                return value !== undefined && (validate === undefined || validate(value).length === 0)
                    ? value
                    : undefined;
            },
        },
        protectedPaths: { list: () => [] },
        sandbox: {
            register: () => undefined,
            canRun: false,
            run: async () => {
                throw new Error("no sandbox in tests");
            },
        },
        gates: { register: () => undefined },
        approvals: { inTurn: (job) => job() },
        status: { register: (plugin, lines) => void status.set(plugin, lines) },
        exec: {
            run: async (file, args, options = {}) => {
                started.push({ file, args: [...args], options });
                return spawnProgram(file, args, options);
            },
            git: async () => {
                throw new Error("jig-mongo starts no git");
            },
        },
    };

    publishJig(api);
    return {
        api,
        declared,
        sections,
        sectionReplace,
        approved,
        facts,
        status,
        secrets,
        resolved,
        kinds,
        started,
        setSection: (name, value) => void values.set(name, value),
        useProgramsIn: (bin) => void (programs.bin = bin),
        publish: () => void publishJig(api),
        reset() {
            values.clear();
            approved.clear();
            facts.clear();
            resolved.length = 0;
            started.length = 0;
            kinds.clear();
            for (const [name, kind] of defaultKinds()) kinds.set(name, kind);
            tunnels = createTunnels();
        },
        remove: () => withdrawJig(api),
    };
}
