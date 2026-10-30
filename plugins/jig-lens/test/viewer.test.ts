// Starting the viewer: what Grafana and Datasette are run with, how the plugin asks whether one answers, and the
// start itself (with a harmless program, never with Grafana).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { lensPaths } from "../src/paths.ts";
import {
    DASHBOARDS_VARIABLE,
    datasetteCommand,
    grafanaCommand,
    homepathOf,
    homeUrl,
    INDEX_VARIABLE,
    probeViewer,
    spawnDetached,
    viewerUrl,
} from "../src/viewer.ts";
import type { ViewerCommand } from "../src/viewer.ts";
import { tempState } from "./support.ts";

const SETTINGS = { port: 3300 };
const where = lensPaths("/state/jig", "/plugin/viewer");
const SHELL_ENV = { PATH: "/usr/bin:/bin", HOME: "/home/me", USER: "me", LANG: "C.UTF-8" };

test("Grafana is started with exactly this environment: loopback, sign-in on, nothing sent, no admin password", () => {
    const command = grafanaCommand("/usr/bin/grafana", undefined, SETTINGS, where, SHELL_ENV);
    assert.equal(command.file, "/usr/bin/grafana");
    assert.deepEqual(command.args, ["server"]);
    assert.deepEqual(command.env, {
        PATH: "/usr/bin:/bin",
        HOME: "/home/me",
        USER: "me",
        LANG: "C.UTF-8",
        GF_SERVER_HTTP_ADDR: "127.0.0.1",
        GF_SERVER_HTTP_PORT: "3300",
        GF_PATHS_DATA: "/state/jig/lens/grafana",
        GF_PATHS_PROVISIONING: "/plugin/viewer/grafana/provisioning",
        GF_AUTH_ANONYMOUS_ENABLED: "false",
        GF_ANALYTICS_REPORTING_ENABLED: "false",
        GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
        GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
        GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: "false",
        GF_NEWS_NEWS_FEED_ENABLED: "false",
        GF_SECURITY_DISABLE_GRAVATAR: "true",
        GF_PLUGINS_PREINSTALL_DISABLED: "true",
        GF_LOG_MODE: "console",
        JIG_LENS_INDEX: "/state/jig/lens/index.sqlite",
        JIG_LENS_DASHBOARDS: "/plugin/viewer/grafana/dashboards",
    });
    assert.equal(command.cwd, "/state/jig/lens", "in a folder of ours, not in the project");
    assert.equal(command.log, "/state/jig/lens/viewer.log");
});

test("Grafana is never given an admin password: the user chooses one at the first sign-in", () => {
    const hostile = {
        ...SHELL_ENV,
        GF_SECURITY_ADMIN_PASSWORD: "from-the-shell",
        GF_SECURITY_ADMIN_PASSWORD__FILE: "/secret",
        GF_SECURITY_ADMIN_USER: "root",
    };
    const { env } = grafanaCommand("/usr/bin/grafana", undefined, SETTINGS, where, hostile);
    assert.deepEqual(
        Object.keys(env).filter((name) => /ADMIN|PASSWORD|SECRET|TOKEN|KEY/i.test(name)),
        [],
    );
});

test("the sign-in cannot be turned off from the shell, and the address is always loopback", () => {
    const shell = {
        ...SHELL_ENV,
        GF_AUTH_ANONYMOUS_ENABLED: "true",
        GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin",
        GF_SERVER_HTTP_ADDR: "0.0.0.0",
        GF_ANALYTICS_REPORTING_ENABLED: "true",
    };
    const { env } = grafanaCommand("/usr/bin/grafana", undefined, { port: 4100 }, where, shell);
    assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED, "false");
    assert.equal(env.GF_AUTH_ANONYMOUS_ORG_ROLE, undefined);
    assert.equal(env.GF_SERVER_HTTP_ADDR, "127.0.0.1");
    assert.equal(env.GF_SERVER_HTTP_PORT, "4100");
    assert.equal(env.GF_ANALYTICS_REPORTING_ENABLED, "false");
});

test("a program that outlives the session is given no API keys, tokens or other variables of Pi's", () => {
    const shell = {
        ...SHELL_ENV,
        ANTHROPIC_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "ghp_secret",
        JIG_STATE_DIR: "/state/jig",
        NODE_OPTIONS: "--require /tmp/evil.js",
    };
    for (const command of [
        grafanaCommand("/usr/bin/grafana", undefined, SETTINGS, where, shell),
        datasetteCommand("/usr/bin/datasette", SETTINGS, where, shell),
    ]) {
        assert.deepEqual(
            Object.keys(command.env).filter((name) => /KEY|TOKEN|SECRET|NODE_OPTIONS|JIG_STATE/.test(name)),
            [],
        );
        assert.equal(command.env.PATH, "/usr/bin:/bin");
        assert.equal(command.env.HOME, "/home/me");
    }
});

test("the old grafana-server is the server itself and takes no subcommand", () => {
    assert.deepEqual(grafanaCommand("/usr/sbin/grafana-server", undefined, SETTINGS, where, SHELL_ENV).args, []);
    assert.deepEqual(grafanaCommand("/opt/g/bin/grafana", undefined, SETTINGS, where, SHELL_ENV).args, ["server"]);
});

test("Grafana's home folder is passed when it is known", () => {
    assert.deepEqual(grafanaCommand("/opt/grafana/bin/grafana", "/opt/grafana", SETTINGS, where, SHELL_ENV).args, [
        "server",
        "--homepath",
        "/opt/grafana",
    ]);
    assert.deepEqual(
        grafanaCommand("/opt/grafana/bin/grafana-server", "/opt/grafana", SETTINGS, where, SHELL_ENV).args,
        ["--homepath", "/opt/grafana"],
    );
});

test("Datasette is started with arbitrary SQL off in its metadata, over the index, on loopback", () => {
    const command = datasetteCommand("/usr/bin/datasette", { port: 4100 }, where, SHELL_ENV);
    assert.equal(command.file, "/usr/bin/datasette");
    assert.deepEqual(command.args, [
        "/state/jig/lens/index.sqlite",
        "--host",
        "127.0.0.1",
        "--port",
        "4100",
        "--metadata",
        "/plugin/viewer/datasette/metadata.json",
    ]);
    assert.deepEqual(command.env, SHELL_ENV);
    assert.equal(command.cwd, "/state/jig/lens");
});

test("the viewer's address is on 127.0.0.1, and the page that opens is the overview", () => {
    assert.equal(viewerUrl(SETTINGS), "http://127.0.0.1:3300");
    assert.equal(homeUrl("grafana", SETTINGS), "http://127.0.0.1:3300/d/jig-overview");
    assert.equal(homeUrl("datasette", { port: 8001 }), "http://127.0.0.1:8001/index");
});

test("the variables the provisioning files read are named here", () => {
    assert.equal(INDEX_VARIABLE, "JIG_LENS_INDEX");
    assert.equal(DASHBOARDS_VARIABLE, "JIG_LENS_DASHBOARDS");
});

// ---- Grafana's home folder ------------------------------------------------------------------------------------------

function tree(t: TestContext, files: Record<string, string>): string {
    const root = tempState(t);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), text);
    }
    return root;
}

test("the home folder is beside bin/ in an unpacked download", (t) => {
    const root = tree(t, { "grafana/bin/grafana": "", "grafana/conf/defaults.ini": "" });
    assert.equal(homepathOf(path.join(root, "grafana/bin/grafana")), path.join(root, "grafana"));
});

test("the home folder is in share/grafana where distributions put it", (t) => {
    const root = tree(t, { "usr/bin/grafana": "", "usr/share/grafana/conf/defaults.ini": "" });
    assert.equal(homepathOf(path.join(root, "usr/bin/grafana")), path.join(root, "usr/share/grafana"));
});

test("the home folder is found from the real place of a link", (t) => {
    const root = tree(t, { "opt/g/bin/grafana": "", "opt/g/conf/defaults.ini": "" });
    mkdirSync(path.join(root, "usr/local/bin"), { recursive: true });
    symlinkSync(path.join(root, "opt/g/bin/grafana"), path.join(root, "usr/local/bin/grafana"));
    assert.equal(homepathOf(path.join(root, "usr/local/bin/grafana")), path.join(root, "opt/g"));
});

test("with no home folder to be found, or no program, there is none to pass", (t) => {
    const root = tree(t, { "usr/sbin/grafana": "" });
    assert.equal(homepathOf(path.join(root, "usr/sbin/grafana")), undefined);
    assert.equal(homepathOf(path.join(root, "nowhere/grafana")), undefined);
});

// ---- asking ---------------------------------------------------------------------------------------------------------

/** A server that answers every request with one status and body, on a port the system picks. */
async function answering(t: TestContext, status: number, body: string): Promise<number> {
    const server: Server = createServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    return (server.address() as AddressInfo).port;
}

test("Grafana's health page makes the viewer running", async (t) => {
    const port = await answering(t, 200, '{"commit":"abc","database":"ok","version":"13.3.0"}');
    assert.equal(await probeViewer("grafana", port), "running");
});

test("a health page without the version, as newer Grafana gives it, is running too", async (t) => {
    const port = await answering(t, 200, '{"database":"ok"}');
    assert.equal(await probeViewer("grafana", port), "running");
});

test("Datasette's version page makes it running", async (t) => {
    const port = await answering(t, 200, '{"python":{"version":"3.12"},"datasette":{"version":"0.65.5"}}');
    assert.equal(await probeViewer("datasette", port), "running");
});

test("something else on the port is busy, not running: other JSON, text, an error, the other viewer", async (t) => {
    assert.equal(await probeViewer("grafana", await answering(t, 200, '{"hello":"world"}')), "busy");
    assert.equal(await probeViewer("grafana", await answering(t, 200, "<html>not json</html>")), "busy");
    assert.equal(await probeViewer("grafana", await answering(t, 404, "{}")), "busy");
    assert.equal(await probeViewer("grafana", await answering(t, 503, '{"database":"failing"}')), "busy");
    assert.equal(await probeViewer("grafana", await answering(t, 200, '{"datasette":{}}')), "busy");
    assert.equal(await probeViewer("datasette", await answering(t, 200, '{"database":"ok"}')), "busy");
});

test("an answer that is too big to be a health page is something else", async (t) => {
    const port = await answering(t, 200, JSON.stringify({ database: "ok", padding: "x".repeat(200_000) }));
    assert.equal(await probeViewer("grafana", port), "busy");
});

test("nothing listening is stopped", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await probeViewer("grafana", port), "stopped");
});

// ---- starting -------------------------------------------------------------------------------------------------------

/** Waits until the started program has exited, which a short script does at once. */
async function exited(started: { exited(): { code: number | null } | undefined }): Promise<{ code: number | null }> {
    for (let i = 0; i < 200; i++) {
        const exit = started.exited();
        if (exit !== undefined) return exit;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the program did not exit");
}

test("a program is started with exactly its environment, in its folder, and its output goes to the log", async (t) => {
    const folder = tempState(t);
    const command: ViewerCommand = {
        file: process.execPath,
        args: [
            "-e",
            "console.log(JSON.stringify({ env: process.env, cwd: process.cwd() })); console.error('to stderr')",
        ],
        env: { ONLY: "this" },
        cwd: folder,
        log: path.join(folder, "viewer.log"),
    };
    const started = await spawnDetached(command);
    assert.equal(typeof started.pid, "number");
    assert.deepEqual(await exited(started), { code: 0 });

    const log = readFileSync(command.log, "utf8");
    const printed = JSON.parse(log.split("\n")[0] ?? "") as { env: Record<string, string>; cwd: string };
    assert.deepEqual(printed.env, { ONLY: "this" }, "nothing of this process's environment goes along");
    assert.equal(printed.cwd, folder);
    assert.match(log, /to stderr/, "the error output is in the log too");
    assert.equal(statSync(command.log).mode & 0o777, 0o600);
});

test("the log starts empty each time", async (t) => {
    const folder = tempState(t);
    const command: ViewerCommand = {
        file: process.execPath,
        args: ["-e", "console.log(process.argv[1])", "first"],
        env: {},
        cwd: folder,
        log: path.join(folder, "viewer.log"),
    };
    await exited(await spawnDetached(command));
    await exited(await spawnDetached({ ...command, args: ["-e", "console.log(process.argv[1])", "second"] }));
    assert.equal(readFileSync(command.log, "utf8"), "second\n");
});

test("a program that stops with an error says so", async (t) => {
    const folder = tempState(t);
    const started = await spawnDetached({
        file: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: {},
        cwd: folder,
        log: path.join(folder, "viewer.log"),
    });
    assert.deepEqual(await exited(started), { code: 3 });
});

test("a program that cannot be started is an error, and the log is not left open", async (t) => {
    const folder = tempState(t);
    await assert.rejects(
        spawnDetached({
            file: path.join(folder, "missing"),
            args: [],
            env: {},
            cwd: folder,
            log: path.join(folder, "viewer.log"),
        }),
        /ENOENT/,
    );
});

test("a program that is not executable is an error too", async (t) => {
    const folder = tempState(t);
    const program = path.join(folder, "program");
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o644);
    await assert.rejects(
        spawnDetached({ file: program, args: [], env: {}, cwd: folder, log: path.join(folder, "viewer.log") }),
        /EACCES/,
    );
});
