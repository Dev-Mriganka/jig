// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. Only what jig-k8s uses is real: the tool's declaration, the `k8s` section, facts, and `exec.run`, which starts
// real programs from an argument list with a short environment, as jig-core does. The programs are the fake kubectl,
// found through a PATH that starts with its folder.
//
// `exec.run` follows jig-core's rules where they matter to this plugin: no shell, the input on standard input, output cut
// at `maxOutputBytes` with a marker, a program that runs too long ends with code 124 and `timedOut`, a missing program or
// a stopped call is an error.
import { spawn } from "node:child_process";
import path from "node:path";
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import type { Facts, JigApi, RunOptions, RunResult, ToolDeclaration } from "../../../jig-core/src/contract.ts";

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
    facts: Map<string, Facts[]>;
    /** Every program the plugin asked to start, in order. */
    started: Started[];
    /** What `config.section(name)` returns once the section passes its check, as at jig-core's session start. */
    setSection(name: string, value: unknown): void;
    /** The folders that start the PATH of the programs run, and the environment they get besides jig-core's own. */
    useProgramsIn(bin: string, env: Readonly<Record<string, string>>): void;
    /** Answers a program instead of starting it, when it returns a result. For cases a real process cannot make. */
    script: ((file: string, args: readonly string[], options: RunOptions) => RunResult | Error | undefined) | undefined;
    /** Makes this the jig-core that plugins reach. */
    publish(): void;
    reset(): void;
    remove(): void;
}

/** What jig-core passes on from Pi's own environment. */
const PASSED_ON = ["HOME", "USER", "LANG", "TMPDIR"];

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const values = new Map<string, unknown>();
    const facts = new Map<string, Facts[]>();
    const started: Started[] = [];
    const programs = { bin: "", env: {} as Readonly<Record<string, string>> };
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

            const child = spawn(file, [...args], { env, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: true });
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
                reject(new Error(error.code === "ENOENT" ? `${file} is not installed or not on PATH` : `${file} could not start`));
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                // Like jig-core, a cut stream ends with a marker, so a caller can tell that the end is missing.
                const text = (stream: "stdout" | "stderr") =>
                    Buffer.concat(out[stream]).toString("utf8") + (out.cut && stream === "stdout" ? `\n[output cut at ${limit} bytes]\n` : "");
                if (stop === "aborted") return reject(new Error(`${file} was aborted`));
                if (stop === "timeout") return resolve({ code: 124, stdout: text("stdout"), stderr: text("stderr"), timedOut: true });
                resolve({ code: code ?? 1, stdout: text("stdout"), stderr: text("stderr"), timedOut: false });
            });
            child.stdin.on("error", () => {});
            child.stdin.end(options.input);
        });
    }

    const api: JigApi = {
        version: 1,
        declareTool: (declaration) => void declared.set(declaration.tool, declaration),
        approvedPreview: () => undefined,
        addFacts: (id, added) => void facts.set(id, [...(facts.get(id) ?? []), added]),
        setTicket: () => {},
        secrets: {
            resolve: async () => {
                throw new Error("jig-k8s resolves no secrets");
            },
        },
        transports: {
            register: () => {},
            request: async () => {
                throw new Error("jig-k8s makes no requests of its own");
            },
        },
        signIn: {
            register: () => {},
            headers: async () => {
                throw new Error("jig-k8s signs in nothing itself");
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
            addMaskFields: () => {},
            registerSection: (name, validate) => void sections.set(name, validate),
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                // As in jig-core: a section with errors is reported at start-up, and then reads as absent.
                return value !== undefined && (validate === undefined || validate(value).length === 0) ? value : undefined;
            },
        },
        exec: {
            run: async (file, args, options = {}) => {
                started.push({ file, args: [...args], options });
                const scripted = fake.script?.(file, args, options);
                if (scripted instanceof Error) throw scripted;
                if (scripted !== undefined) return scripted;
                return spawnProgram(file, args, options);
            },
            git: async () => {
                throw new Error("jig-k8s starts no git");
            },
        },
    };

    publishJig(api);
    return {
        api,
        declared,
        sections,
        facts,
        started,
        setSection: (name, value) => void values.set(name, value),
        useProgramsIn(bin, env) {
            programs.bin = bin;
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
            fake.script = undefined;
        },
        remove: () => withdrawJig(api),
    };
}
