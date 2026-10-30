// A world for the real-sandbox tests: a fake home with fake credentials made at run time, a project, a session, and the
// real sandbox around them.
//
// Test safety, on purpose and strict:
//   - every fake credential is built from parts when the test runs, so no secret-shaped text is in this repository;
//   - commands name the fake files by absolute path;
//   - the rules ALSO hide the real home's credential paths, because some programs ignore HOME (ssh and Java use the
//     password database's), so a command that missed the fake one could still not reach the real one;
//   - no test runs ssh, git against a remote, gh or aws, or reaches a host other than a server of its own on 127.0.0.1;
//   - nothing here reads or prints a file under the real home.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { startBroker } from "../../src/broker-client.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { SandboxSettings } from "../../src/config.ts";
import { nodeFiles } from "../../src/files.ts";
import { detectWsl } from "../../src/platform.ts";
import { Sandbox } from "../../src/sandbox.ts";
import type { SandboxDeps } from "../../src/sandbox.ts";
import { testPrograms } from "./programs.ts";

const BROKER = path.resolve(import.meta.dirname, "../../broker/broker.mjs");

/** The credential places of the real home that every test hides, whether or not they exist. */
export const REAL_HOME_CREDENTIALS = [
    ".ssh",
    ".aws",
    ".kube",
    ".config/gh",
    ".gnupg",
    ".password-store",
    ".gradle/gradle.properties",
    ".npmrc",
    ".azure",
    ".config/gcloud",
    ".netrc",
    ".git-credentials",
    ".docker/config.json",
    ".m2/settings.xml",
    ".pypirc",
    ".pi/agent/auth.json",
    ".pi/agent/mcp-auth.json",
    ".claude/.credentials.json",
];

export interface WorldOptions {
    settings?: Partial<SandboxSettings> | ((base: SandboxSettings) => SandboxSettings);
    /** Added to Pi's environment in the world. */
    env?: Record<string, string>;
    /** Replaces parts of the sandbox's dependencies. */
    deps?: Partial<SandboxDeps>;
}

export interface RunResult {
    exitCode: number | null;
    output: string;
}

export interface World {
    /** The folder that holds the whole world. */
    root: string;
    home: string;
    project: string;
    agentDir: string;
    /** A different marker for each fake credential: if one shows up in output, this says which file it came from. */
    markers: Record<string, string>;
    sandbox: Sandbox;
    env: Record<string, string>;
    /** Runs a command in the sandbox, in the project (or `cwd`), and returns what it printed. */
    run(command: string, options?: { cwd?: string; timeout?: number }): Promise<RunResult>;
    /** Writes a file, with its folders, relative to the world's root unless absolute. */
    put(file: string, text?: string): string;
    link(target: string, linkPath: string): void;
    cleanup(): Promise<void>;
}

function marker(kind: string): string {
    return ["jigtest", kind, randomBytes(6).toString("hex")].join("-");
}

/** Makes a world and starts its sandbox. */
export async function makeWorld(options: WorldOptions = {}): Promise<World> {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-world-")));
    const home = path.join(root, "home");
    const project = path.join(home, "work", "orders");
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    const put = (file: string, text = ""): string => {
        const full = path.isAbsolute(file) ? file : path.join(root, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
        return full;
    };
    const markers: Record<string, string> = {
        ssh: marker("ssh"),
        aws: marker("aws"),
        kube: marker("kube"),
        gh: marker("gh"),
        gradle: marker("gradle"),
        npmrc: marker("npmrc"),
        auth: marker("pi-auth"),
        dotenv: marker("dotenv"),
        envvar: marker("envvar"),
    };
    put(path.join(home, ".ssh", "id_ed25519"), markers.ssh);
    put(path.join(home, ".ssh", "config"), markers.ssh);
    put(path.join(home, ".aws", "credentials"), markers.aws);
    put(path.join(home, ".kube", "config"), markers.kube);
    put(path.join(home, ".config", "gh", "hosts.yml"), markers.gh);
    put(path.join(home, ".gradle", "gradle.properties"), markers.gradle);
    put(path.join(home, ".npmrc"), markers.npmrc);
    put(path.join(agentDir, "auth.json"), markers.auth);
    put(path.join(project, ".env"), markers.dotenv);
    put(path.join(home, ".bashrc"), "# fake\n");
    put(path.join(home, ".gitconfig"), "[user]\n\tname = Test\n");

    const programs = testPrograms();
    const realHome = userInfo().homedir;
    const base: SandboxSettings = {
        ...DEFAULT_SETTINGS,
        hide: REAL_HOME_CREDENTIALS.map((name) => path.join(realHome, name)),
        programs: {
            ...(programs.bwrap === undefined ? {} : { bwrap: programs.bwrap }),
            ...(programs.socat === undefined ? {} : { socat: programs.socat }),
            ...(programs.ripgrep === undefined ? {} : { ripgrep: programs.ripgrep }),
        },
    };
    const settings: SandboxSettings =
        typeof options.settings === "function" ? options.settings(base) : { ...base, ...options.settings };
    // The user's `hide` of the real home stays whatever the test sets.
    settings.hide = [...new Set([...base.hide, ...settings.hide])];

    // A folder of the user's own on PATH, which a command must not be able to put a program in.
    mkdirSync(path.join(home, "bin"), { recursive: true });
    const env: Record<string, string> = {
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        LANG: "C.UTF-8",
        // A credential in Pi's environment, which must not reach the command.
        MY_SERVICE_TOKEN: markers.envvar as string,
        ...options.env,
    };
    const exec = createLocalBashOperations().exec;
    const deps: SandboxDeps = {
        brokerScript: BROKER,
        env,
        files: nodeFiles,
        platform: "linux",
        home: () => home,
        uid: process.getuid?.() ?? 0,
        wsl: detectWsl(process.env, nodeFiles),
        tmpRoot: path.join(root, "tmp"),
        agentDir: () => agentDir,
        settings: () => settings,
        protectedPaths: () => [],
        runtimePaths: () => [],
        approved: () => [],
        createdByAgent: new Set(),
        startBroker,
        exec,
        random: () => randomBytes(4).toString("hex"),
        now: () => Date.now(),
        ...options.deps,
    };
    mkdirSync(deps.tmpRoot, { recursive: true });
    const sandbox = new Sandbox(deps);
    await sandbox.start("test-session", project);

    const world: World = {
        root,
        home,
        project,
        agentDir,
        markers,
        sandbox,
        env,
        put,
        link: (target, linkPath) => {
            mkdirSync(path.dirname(linkPath), { recursive: true });
            symlinkSync(target, linkPath);
        },
        async run(command, runOptions = {}) {
            const cwd = runOptions.cwd ?? project;
            const prepared = await sandbox.prepare(command, cwd, env);
            const chunks: Buffer[] = [];
            try {
                const result = await exec(prepared.wrapped, cwd, {
                    onData: (data) => chunks.push(Buffer.from(data)),
                    env: prepared.env,
                    ...(runOptions.timeout === undefined ? {} : { timeout: runOptions.timeout }),
                });
                return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf8") };
            } finally {
                await prepared.finish();
            }
        },
        async cleanup() {
            await sandbox.stop();
            rmSync(root, { recursive: true, force: true });
        },
    };
    return world;
}
