// The viewer: the commands that start Grafana or Datasette, asking whether one answers, and starting one detached.
//
// The viewer is one process shared by every Pi session, so it is started detached and keeps running when Pi exits. It
// binds 127.0.0.1 only.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { get } from "node:http";
import { basename, dirname, join } from "node:path";
import type { LensSettings } from "./config.ts";
import type { Paths } from "./paths.ts";

/** The two programs that can show the index, which `/lens grafana` and `/lens datasette` start. */
export type Viewer = "grafana" | "datasette";

/** Whether the viewer answers on its port: `busy` is something else, which answers but is not the viewer. */
export type ViewerState = "running" | "stopped" | "busy";

/** A program to start, with its whole environment. */
export interface ViewerCommand {
    file: string;
    args: string[];
    env: Record<string, string>;
    /** Where to run it: a folder of ours, not the project, which the program would then hold open. */
    cwd: string;
    /** Where its output goes. */
    log: string;
}

export const GRAFANA_PROGRAMS = ["grafana", "grafana-server"] as const;
export const DATASETTE_PROGRAMS = ["datasette"] as const;

/** The data source and dashboard provisioning files read these two, so they never hold a path of this machine. */
export const INDEX_VARIABLE = "JIG_LENS_INDEX";
export const DASHBOARDS_VARIABLE = "JIG_LENS_DASHBOARDS";

/** The uid of the dashboard that `/lens grafana` opens. */
export const HOME_DASHBOARD = "jig-overview";

/** Datasette names a database after its file, `index.sqlite`, and the metadata is filed under that name. */
export const DATASETTE_DATABASE = "index";

export const viewerUrl = (settings: LensSettings) => `http://127.0.0.1:${settings.port}`;

/** The page `/lens grafana` or `/lens datasette` opens: Grafana's overview, or Datasette's page for the index. */
export function homeUrl(viewer: Viewer, settings: LensSettings): string {
    const page = viewer === "grafana" ? `d/${HOME_DASHBOARD}` : DATASETTE_DATABASE;
    return `${viewerUrl(settings)}/${page}`;
}

/**
 * What the viewer is given of Pi's environment. A process that outlives the session gets no API keys or tokens, and
 * none of Grafana's own settings from the shell either: an admin password in `GF_SECURITY_ADMIN_PASSWORD` must not
 * reach it.
 */
const PASSED = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "GRAFANA_HOME",
];

function passedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const name of PASSED) {
        const value = env[name];
        if (value !== undefined && value !== "") kept[name] = value;
    }
    return kept;
}

/**
 * Grafana's home folder, the one that holds `conf/defaults.ini`, found from the program: beside `bin/` in an unpacked
 * download, or in `share/grafana` where distributions put it. Without it Grafana looks in the folder it runs in, and
 * there is none there. Undefined when neither exists, as with a packaged install, whose `grafana` wrapper passes the
 * folder itself.
 */
export function homepathOf(program: string): string | undefined {
    let real: string;
    try {
        real = realpathSync(program);
    } catch {
        return undefined;
    }
    const root = dirname(dirname(real));
    return [root, join(root, "share", "grafana")].find((folder) => existsSync(join(folder, "conf", "defaults.ini")));
}

/**
 * Grafana on 127.0.0.1, with its sign-in on and no admin password set: the user chooses one at the first sign-in. It
 * reads its provisioning from this plugin, which points it at the index through `JIG_LENS_INDEX`, and keeps its own
 * data under the lens folder.
 */
export function grafanaCommand(
    program: string,
    homepath: string | undefined,
    settings: LensSettings,
    paths: Paths,
    env: NodeJS.ProcessEnv,
): ViewerCommand {
    // The new `grafana` takes a subcommand; the old `grafana-server` is the server itself.
    const subcommand = basename(program) === "grafana" ? ["server"] : [];
    return {
        file: program,
        args: [...subcommand, ...(homepath === undefined ? [] : ["--homepath", homepath])],
        env: {
            ...passedEnv(env),
            GF_SERVER_HTTP_ADDR: "127.0.0.1",
            GF_SERVER_HTTP_PORT: String(settings.port),
            GF_PATHS_DATA: paths.grafanaData,
            GF_PATHS_PROVISIONING: paths.provisioning,
            GF_AUTH_ANONYMOUS_ENABLED: "false",
            // Nothing leaves the machine once the plugin is installed: no usage report, no check for a new version of
            // Grafana or a plugin, no feedback links, and no news feed, avatar lookup or download of preinstalled apps.
            GF_ANALYTICS_REPORTING_ENABLED: "false",
            GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
            GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
            GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: "false",
            GF_NEWS_NEWS_FEED_ENABLED: "false",
            GF_SECURITY_DISABLE_GRAVATAR: "true",
            GF_PLUGINS_PREINSTALL_DISABLED: "true",
            // To the console, which the log file catches, so Grafana needs no log folder of its own: the one it would
            // use by default may be one the user cannot write to.
            GF_LOG_MODE: "console",
            [INDEX_VARIABLE]: paths.index,
            [DASHBOARDS_VARIABLE]: paths.dashboards,
        },
        cwd: paths.lens,
        log: paths.log,
    };
}

/** Datasette over the index, with arbitrary SQL turned off in its metadata, so it runs only the queries kept there. */
export function datasetteCommand(
    program: string,
    settings: LensSettings,
    paths: Paths,
    env: NodeJS.ProcessEnv,
): ViewerCommand {
    return {
        file: program,
        args: [
            paths.index,
            "--host",
            "127.0.0.1",
            "--port",
            String(settings.port),
            "--metadata",
            paths.datasetteMetadata,
        ],
        env: passedEnv(env),
        cwd: paths.lens,
        log: paths.log,
    };
}

// ---- asking ---------------------------------------------------------------------------------------------------------

/** Whether a viewer's own health page gave the answer that viewer gives. */
function isViewer(viewer: Viewer, status: number | undefined, body: string): boolean {
    if (status !== 200) return false;
    try {
        const answer = JSON.parse(body) as Record<string, unknown>;
        return viewer === "grafana" ? answer.database === "ok" : "datasette" in answer;
    } catch {
        return false;
    }
}

/** Asks 127.0.0.1 on the viewer's port. No answer is `stopped`; an answer that is not the viewer's is `busy`. */
export function probeViewer(viewer: Viewer, port: number): Promise<ViewerState> {
    const path = viewer === "grafana" ? "/api/health" : "/-/versions.json";
    return new Promise((resolve) => {
        const request = get({ host: "127.0.0.1", port, path, timeout: 1500 }, (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                // A health page is a few hundred bytes. Anything bigger is something else.
                if (size > 65536) {
                    response.destroy();
                    resolve("busy");
                } else {
                    chunks.push(chunk);
                }
            });
            response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve(isViewer(viewer, response.statusCode, body) ? "running" : "busy");
            });
            response.on("error", () => resolve("busy"));
        });
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve("stopped"));
    });
}

// ---- starting -------------------------------------------------------------------------------------------------------

/** A program that was started. `exited` tells, later, whether it has stopped. */
export interface Started {
    pid: number | undefined;
    exited(): { code: number | null } | undefined;
}

/** Starts a program. Rejects when it cannot be started at all. */
export type Spawn = (command: ViewerCommand) => Promise<Started>;

/**
 * Starts the program detached, in a group of its own, so it keeps running when Pi exits and a Ctrl-C in Pi does not
 * reach it. Its output goes to the log file, which starts empty each time.
 */
export const spawnDetached: Spawn = (command) =>
    new Promise((resolve, reject) => {
        const log = openSync(command.log, "w", 0o600);
        const child = spawn(command.file, command.args, {
            env: command.env,
            cwd: command.cwd,
            detached: true,
            stdio: ["ignore", log, log],
        });
        let started = false;
        let exit: { code: number | null } | undefined;
        child.once("exit", (code) => {
            exit = { code };
        });
        child.on("error", (error) => {
            // After the start an error is not ours to report: the process is on its own.
            if (started) return;
            closeSync(log);
            reject(error);
        });
        child.once("spawn", () => {
            started = true;
            closeSync(log);
            // Pi must not wait for it, or keep it from exiting.
            child.unref();
            resolve({ pid: child.pid, exited: () => exit });
        });
    });
