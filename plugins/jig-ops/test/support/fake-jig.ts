// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. Only what jig-ops uses is real: the tools' declarations, the `ops` section, facts, the kind of an
// environment, the approved preview of a call, the watch kinds and the watches it starts, secrets, sign-in services and
// transports, and `exec.run`, which starts real programs from an argument list with a short environment, as jig-core
// does. The programs are the fake kubectl, helm and gh, found through a PATH that starts with their folders.
//
// `exec.run` follows jig-core's rules where they matter to this plugin: no shell, the input on standard input, output
// cut at `maxOutputBytes` with a marker, a program that runs too long ends with code 124 and `timedOut`, a missing
// program or a stopped call is an error. A secret, a sign-in service or a transport that is not there is an error that
// does not repeat what was asked, and every credential handed out is remembered in `issued`, so a test can check that
// none of them reaches a result.
import { spawn } from "node:child_process";
import path from "node:path";
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import { createHttp } from "../../../jig-core/src/kit/http.ts";
import type {
    EnvironmentKind,
    Facts,
    JigApi,
    Preview,
    RunOptions,
    RunResult,
    SignInRequest,
    SignInService,
    StartWatch,
    ToolDeclaration,
    Transport,
    TransportRequest,
    TransportResponse,
    WatchKind,
} from "../../../jig-core/src/contract.ts";

/** One program the plugin started. */
export interface Started {
    file: string;
    args: string[];
    options: RunOptions;
}

/** A watch the plugin started: what it asked for, and the id it was given. */
export interface StartedWatch extends StartWatch<unknown> {
    id: string;
    status: "open" | "done";
}

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    /** The watch kinds the plugin registered, by name. */
    kinds: Map<string, WatchKind<never, never>>;
    /** The watches the plugin started, in order. */
    watches: StartedWatch[];
    /** The check each plugin registered for its section of jig.json. */
    sections: Map<string, (raw: unknown) => readonly string[]>;
    /** The keys each plugin named that replace a company's defaults instead of merging into them. */
    sectionReplace: Map<string, readonly string[] | undefined>;
    facts: Map<string, Facts[]>;
    /** Every program the plugin asked to start, in order. */
    started: Started[];
    /** What `config.section(name)` returns once the section passes its check, as at jig-core's session start. */
    setSection(name: string, value: unknown): void;
    /** What jig-core says each environment is, over the default table. A name that is not in it counts as production. */
    setKinds(kinds: Readonly<Record<string, EnvironmentKind>>): void;
    /** Records that the user approved this preview for this call, as `approvedPreview` will return it. */
    approve(toolCallId: string, preview: Preview): void;
    /** The folders that start the PATH of the programs run, and the environment they get besides jig-core's own. */
    useProgramsIn(bin: string | readonly string[], env: Readonly<Record<string, string>>): void;
    /** Secret values by reference. An unknown reference is an error that never repeats it, as in jig-core. */
    secrets: Map<string, string>;
    /** Every reference asked for, in order. */
    resolved: string[];
    /** The sign-in services plugins asked for, by name; and every request one was asked to sign in. */
    signInServices: Map<string, SignInService>;
    signedIn: SignInRequest[];
    /** The transports a test registers, and the requests that were sent through them. */
    transports: Map<string, Transport>;
    sent: TransportRequest[];
    /** The network that `http.request` uses for a direct request. Default: the global `fetch`. */
    setFetch(fetchImpl: typeof fetch | undefined): void;
    /** Every credential value handed out: secrets and sign-in headers. A test checks that none reaches a result. */
    issued: Set<string>;
    /** Answers a program instead of starting it, when it returns a result. For cases a real process cannot make. */
    script: ((file: string, args: readonly string[], options: RunOptions) => RunResult | Error | undefined) | undefined;
    /** Makes this the jig-core that plugins reach. */
    publish(): void;
    reset(): void;
    remove(): void;
}

/** What jig-core passes on from Pi's own environment. */
const PASSED_ON = ["HOME", "USER", "LANG", "TMPDIR"];

/** What jig-core's configuration says each environment is. A name it does not know counts as production. */
export const DEFAULT_KINDS: Readonly<Record<string, EnvironmentKind>> = {
    local: "local",
    external: "external",
    production: "production",
    prod: "production",
    staging: "test",
    qa: "test",
};

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const sectionReplace = new Map<string, readonly string[] | undefined>();
    const values = new Map<string, unknown>();
    const facts = new Map<string, Facts[]>();
    const started: Started[] = [];
    const kinds = new Map<string, WatchKind<never, never>>();
    const watches: StartedWatch[] = [];
    const approved = new Map<string, Preview>();
    let environments: Record<string, EnvironmentKind> = { ...DEFAULT_KINDS };
    const programs = { bin: "", env: {} as Readonly<Record<string, string>> };
    const secrets = new Map<string, string>();
    const resolved: string[] = [];
    const signInServices = new Map<string, SignInService>();
    const signedIn: SignInRequest[] = [];
    const transports = new Map<string, Transport>();
    const sent: TransportRequest[] = [];
    const issued = new Set<string>();
    const fake = { script: undefined as FakeJig["script"] };

    function spawnProgram(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
        return new Promise((resolve, reject) => {
            const env: Record<string, string> = {};
            for (const name of PASSED_ON) {
                const value = process.env[name];
                if (value !== undefined) env[name] = value;
            }
            env.PATH = [programs.bin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
            Object.assign(env, programs.env, options.env);

            const child = spawn(file, [...args], {
                env,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
            });
            const limit = options.maxOutputBytes ?? 10 * 1024 * 1024;
            const timeoutMs = options.timeoutMs ?? 60_000;
            const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], size: { stdout: 0, stderr: 0 }, cut: false };
            let stop: "timeout" | "aborted" | undefined;

            const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
                const room = limit - out.size[stream];
                if (room <= 0) {
                    out.cut = true;
                    return;
                }
                const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
                if (piece.length < chunk.length) out.cut = true;
                out[stream].push(piece);
                out.size[stream] += piece.length;
            };
            const kill = (why: "timeout" | "aborted") => {
                stop ??= why;
                try {
                    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
                child.stdout.destroy();
                child.stderr.destroy();
            };
            child.stdout.on("data", keep("stdout"));
            child.stderr.on("data", keep("stderr"));
            const timer = setTimeout(() => kill("timeout"), timeoutMs);
            const onAbort = () => kill("aborted");
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
                // Like jig-core, a cut stream ends with a marker, so a caller can tell that the end is missing.
                const text = (stream: "stdout" | "stderr") =>
                    Buffer.concat(out[stream]).toString("utf8") +
                    (out.cut && stream === "stdout" ? `\n[output cut at ${limit} bytes]\n` : "");
                if (stop === "aborted") return reject(new Error(`${file} was aborted`));
                if (stop === "timeout")
                    return resolve({ code: 124, stdout: text("stdout"), stderr: text("stderr"), timedOut: true });
                resolve({ code: code ?? 1, stdout: text("stdout"), stderr: text("stderr"), timedOut: false });
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
                issued.add(value);
                return value;
            },
        },
        environments: {
            // As in jig-core: a name nobody defined counts as production.
            kindOf: (name) =>
                Object.hasOwn(environments, name) ? (environments[name] as EnvironmentKind) : "production",
        },
        tunnels: {
            register: () => {},
            open: async () => {
                throw new Error("no tunnels in tests");
            },
        },
        transports: {
            register: (name, transport) => void transports.set(name, transport),
            async request(name, request, signal): Promise<TransportResponse> {
                const transport = transports.get(name);
                if (transport === undefined) throw new Error(`no transport named "${name}"`);
                sent.push(request);
                try {
                    const response = await transport.request(request, signal);
                    return { ...response, headers: response.headers ?? {} };
                } catch (error) {
                    throw new Error(
                        `transport "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            },
        },
        signIn: {
            register: (name, service) => void signInServices.set(name, service),
            async headers(name, request, signal) {
                const service = signInServices.get(name);
                if (service === undefined) throw new Error(`no sign-in service is named "${name}"`);
                signedIn.push(request);
                const headers = await service.headers(request, signal);
                for (const value of Object.values(headers)) issued.add(value);
                return headers;
            },
        },
        http: { request: (request, signal) => http.request(request, signal) },

        mask: { text: (input) => input, value: (input) => input },
        watches: {
            registerKind: (kind) => void kinds.set(kind.kind, kind as unknown as WatchKind<never, never>),
            start: (watch) => {
                const id = `watch-${watches.length + 1}`;
                watches.push({ ...(watch as StartWatch<unknown>), id, status: "open" });
                return id;
            },
            list: () =>
                watches.map((watch) => ({
                    id: watch.id,
                    kind: watch.kind,
                    plugin: "jig-ops",
                    title: watch.title,
                    status: watch.status,
                    startedAt: "2026-10-15T09:00:00Z",
                })),
            stop: (id) => {
                const open = watches.find((watch) => watch.id === id && watch.status === "open");
                if (open === undefined) return false;
                open.status = "done";
                return true;
            },
        },
        config: {
            addEnvironments: () => {},
            addRules: () => {},
            addClassifyRules: () => {},
            addProtectedPaths: () => {},
            addSecretCommands: () => {},
            addMaskFields: () => {},
            addSectionDefaults: () => {},
            registerSection: (name, validate, options) => {
                sections.set(name, validate);
                sectionReplace.set(name, options?.replace);
            },
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
        sandbox: { register: () => undefined },
        exec: {
            run: async (file, args, options = {}) => {
                started.push({ file, args: [...args], options });
                const scripted = fake.script?.(file, args, options);
                if (scripted instanceof Error) throw scripted;
                if (scripted !== undefined) return scripted;
                return spawnProgram(file, args, options);
            },
            git: async () => {
                throw new Error("jig-ops starts no git");
            },
        },
    };

    // The real request logic over this fake's secrets, sign-in services, transports and network.
    let fetchImpl: typeof fetch | undefined;
    const http = createHttp({
        fetch: (input, init) => (fetchImpl ?? fetch)(input, init),
        secrets: { resolve: (reference, signal) => api.secrets.resolve(reference, signal) },
        signIn: { headers: (name, request, signal) => api.signIn.headers(name, request, signal) },
        transports: { request: (name, request, signal) => api.transports.request(name, request, signal) },
    });

    publishJig(api);
    return {
        api,
        declared,
        kinds,
        watches,
        sections,
        sectionReplace,
        facts,
        started,
        secrets,
        resolved,
        signInServices,
        signedIn,
        transports,
        sent,
        setFetch: (replacement) => {
            fetchImpl = replacement;
        },
        issued,
        setSection: (name, value) => void values.set(name, value),
        setKinds(more) {
            environments = { ...DEFAULT_KINDS, ...more };
        },
        approve: (id, preview) => void approved.set(id, preview),
        useProgramsIn(bin, env) {
            programs.bin = typeof bin === "string" ? bin : bin.join(path.delimiter);
            programs.env = env;
        },
        get script() {
            return fake.script;
        },
        set script(value) {
            fake.script = value;
        },
        publish: () => void publishJig(api),
        reset() {
            values.clear();
            facts.clear();
            started.length = 0;
            resolved.length = 0;
            signedIn.length = 0;
            sent.length = 0;
            issued.clear();
            watches.length = 0;
            approved.clear();
            environments = { ...DEFAULT_KINDS };
            fake.script = undefined;
            fetchImpl = undefined;
        },
        remove: () => withdrawJig(api),
    };
}
