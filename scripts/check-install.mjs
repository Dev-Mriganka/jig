// `npm run check:install`: Jig installed the way a user gets it, and loaded by the stock Pi.
//
// The repository's tests run inside a full checkout, where devDependencies and hoisting can hide a missing dependency. A user runs
// `pi install git:...`: Pi clones the repository and installs its `dependencies` only (Pi 1.4 runs `npm install --omit=dev
// --legacy-peer-deps` in the clone; its docs/packages.md says "Declare dependencies"). This script lets Pi do exactly that:
//   1. the tracked files of this working tree become a git repository in a temporary folder, which git reaches as
//      https://example.com/jig/jig (a `url.<base>.insteadOf` setting in a temporary git configuration), so no network host is involved;
//   2. `pi install git:example.com/jig/jig` runs in a temporary agent folder and home;
//   3. the installed copy is checked: the exact dependencies are there and no dev dependency is;
//   4. the stock Pi starts in RPC mode with that copy as its only package, and every extension of package.json's `pi.extensions` must
//      have loaded and registered a command or a tool, with no `extension_error` and no load failure.
// It needs network access for npm, a Pi 1.x (PI_HOST_DIR, else the global install next to this Node) and git.
//   node scripts/check-install.mjs [--keep]      the temporary folder is removed at the end; --keep, or a failure, leaves it and prints where it is
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { piHostDir } from "../test/support/pi-host-dir.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const PROBE = path.join(REPO, "test/support/install-probe.ts");
const SOURCE = "git:example.com/jig/jig";
const REQUIRED_COMMANDS = ["jig", "sandbox", "agents"];
const keep = process.argv.includes("--keep");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The Pi to test: its entry file and version. */
function stockPi() {
    const manifest = path.join(piHostDir, "package.json");
    if (!existsSync(manifest))
        throw new Error(`No Pi at ${piHostDir}: npm install -g @earendil-works/pi-coding-agent, or set PI_HOST_DIR`);
    const pi = read(manifest);
    if (pi.name !== "@earendil-works/pi-coding-agent") throw new Error(`${piHostDir} is ${pi.name}, not Pi`);
    return { cli: path.resolve(piHostDir, typeof pi.bin === "string" ? pi.bin : pi.bin.pi), version: pi.version };
}

/** Runs a program to its end and returns its output; a failure stops the check with that output. */
function run(file, args, options) {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 600_000, ...options });
    if (result.status !== 0) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
        throw new Error(
            `${[path.basename(file), ...args].join(" ")} failed (${result.status ?? result.error?.message}):\n${output}`,
        );
    }
    return result.stdout;
}

/** The tracked files of the working tree, and new files git would add: what the next commit holds. */
function filesToInstall() {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: REPO,
        encoding: "utf8",
    });
    return listed.split("\0").filter((file) => file !== "" && existsSync(path.join(REPO, file)));
}

/** Makes the repository Pi will clone, and the git configuration that points https://example.com/ at it. */
function makeOrigin(root, env) {
    const origin = path.join(root, "origin");
    const repository = path.join(origin, "jig/jig");
    for (const file of filesToInstall()) {
        mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
        copyFileSync(path.join(REPO, file), path.join(repository, file));
    }
    writeFileSync(
        env.GIT_CONFIG_GLOBAL,
        `[user]\n\tname = Jig Check\n\temail = check@example.com\n[url "file://${origin}/"]\n\tinsteadOf = https://example.com/\n`,
    );
    run("git", ["init", "-q", "-b", "main"], { cwd: repository, env });
    run("git", ["add", "-A"], { cwd: repository, env });
    run("git", ["commit", "-q", "-m", "The files of the working tree"], { cwd: repository, env });
}

/** What the install must have left: the dependencies at their exact versions, and nothing only a developer needs. */
function checkInstalled(clone, manifest) {
    const problems = [];
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        const file = path.join(clone, "node_modules", name, "package.json");
        const found = existsSync(file) ? read(file).version : undefined;
        if (found !== version) problems.push(`dependency ${name}: wanted ${version}, installed ${found ?? "nothing"}`);
    }
    const lock = read(path.join(clone, "package-lock.json"));
    for (const [place, entry] of Object.entries(lock.packages)) {
        if (entry.dev === true && existsSync(path.join(clone, place)))
            problems.push(`${place} is a dev dependency, but it was installed`);
    }
    return problems;
}

/** Starts Pi in RPC mode, asks for its commands and the probe's tools, and ends it. */
async function loadInPi(cli, env, cwd, probeOut) {
    const child = spawn(
        process.execPath,
        [cli, "--mode", "rpc", "--no-session", "--model", "faux/faux-1", "-e", PROBE],
        {
            cwd,
            env: { ...env, PI_OFFLINE: "1", JIG_INSTALL_PROBE_OUT: probeOut },
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    let stderr = "";
    let buffer = "";
    const records = [];
    const waiting = new Map();
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            records.push(record);
            if (record.type === "response") waiting.get(record.id)?.(record);
        }
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve({ exited: code })));
    const ask = (command) =>
        Promise.race([
            new Promise((resolve) => waiting.set(command.id, resolve)).finally(() => waiting.delete(command.id)),
            exited,
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 60_000).unref()),
        ]).then((answer) => {
            if (answer.exited !== undefined || answer.timedOut) {
                throw new Error(
                    `Pi ${answer.timedOut ? "did not answer in 60 s" : `ended with code ${answer.exited} before it answered`}.\nstderr:\n${stderr.trim()}`,
                );
            }
            return answer;
        });
    const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
    try {
        const commands = ask({ id: "commands", type: "get_commands" });
        send({ id: "commands", type: "get_commands" });
        const listed = (await commands).data.commands.map((command) => ({
            name: command.name,
            path: command.sourceInfo?.path,
        }));
        const probed = ask({ id: "probe", type: "prompt", message: "/install-probe" });
        send({ id: "probe", type: "prompt", message: "/install-probe" });
        await probed;
        for (let waited = 0; !existsSync(probeOut) && waited < 100; waited += 1)
            await new Promise((r) => setTimeout(r, 100));
        const tools = existsSync(probeOut) ? read(probeOut).tools : [];
        return { commands: listed, tools, records, stderr };
    } finally {
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }
}

async function main() {
    const pi = stockPi();
    const manifest = read(path.join(REPO, "package.json"));
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-install-")));
    const home = path.join(root, "home");
    const agent = path.join(root, "agent");
    const work = path.join(root, "work");
    for (const folder of [home, agent, work]) mkdirSync(folder);
    const cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
    const env = {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        PI_CODING_AGENT_DIR: agent,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        npm_config_cache: cache,
        ...Object.fromEntries(
            [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "NO_PROXY",
                "http_proxy",
                "https_proxy",
                "no_proxy",
                "NODE_EXTRA_CA_CERTS",
                "SSL_CERT_FILE",
            ]
                .filter((name) => process.env[name] !== undefined)
                .map((name) => [name, process.env[name]]),
        ),
    };
    let failed = false;
    try {
        console.log(
            `Pi ${pi.version} (${piHostDir}), Node ${process.version}, npm ${run("npm", ["--version"], { env }).trim()}`,
        );
        makeOrigin(root, env);
        console.log(`pi install ${SOURCE}`);
        run(process.execPath, [pi.cli, "install", SOURCE], { cwd: work, env });
        const clone = path.join(agent, "git/example.com/jig/jig");

        const problems = checkInstalled(clone, manifest);
        const { commands, tools, records, stderr } = await loadInPi(pi.cli, env, work, path.join(root, "probe.json"));
        const here = (file) => realpathSync(file);
        const from = (list, file) =>
            list.filter((item) => item.path !== undefined && existsSync(item.path) && here(item.path) === file);
        for (const entry of manifest.pi.extensions) {
            const file = here(path.join(clone, entry));
            const count = from(commands, file).length + from(tools, file).length;
            if (count === 0) problems.push(`${entry} registered no command and no tool: it did not load`);
            else console.log(`  ${entry}: ${from(commands, file).length} commands, ${from(tools, file).length} tools`);
        }
        const names = new Set(commands.map((command) => command.name));
        for (const name of REQUIRED_COMMANDS)
            if (!names.has(name)) problems.push(`/${name} is not among Pi's commands`);
        for (const record of records.filter((item) => item.type === "extension_error")) {
            problems.push(`extension_error in ${record.extensionPath}: ${record.error}`);
        }
        if (/Failed to load extension|extension_error/.test(stderr))
            problems.push(`Pi reported on stderr:\n${stderr.trim()}`);

        if (problems.length > 0) throw new Error(`The installed copy does not load:\n  ${problems.join("\n  ")}`);
        console.log(`ok: ${manifest.pi.extensions.length} extensions of an installed copy loaded in Pi ${pi.version}`);
    } catch (error) {
        failed = true;
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        if (keep || failed) console.log(`kept: ${root}`);
        else rmSync(root, { recursive: true, force: true });
    }
}

await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
