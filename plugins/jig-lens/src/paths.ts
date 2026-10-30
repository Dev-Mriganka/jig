// Where jig-lens reads and writes. Everything it owns is below `<state>/lens`; the records beside it belong to jig-core
// and are only read.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `$JIG_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/jig`. A relative `XDG_STATE_HOME` is ignored, as the XDG
 *  specification says. This is jig-core's rule, repeated: a plugin never imports jig-core's modules (see its
 *  contract.ts), and the rule is short. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    const chosen = env.JIG_STATE_DIR;
    if (chosen !== undefined && chosen !== "") return resolve(chosen);
    const xdg = env.XDG_STATE_HOME;
    const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
    return join(base, "jig");
}

/**
 * Pi's agent folder: `$PI_CODING_AGENT_DIR` with a leading `~` expanded, else `~/.pi/agent`. This is Pi's rule, repeated, so
 * that the plugin needs nothing from Pi but its types to know where the session files are.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
    const chosen = env.PI_CODING_AGENT_DIR;
    if (chosen !== undefined && chosen !== "") {
        if (chosen === "~") return homedir();
        return chosen.startsWith("~/") ? join(homedir(), chosen.slice(2)) : resolve(chosen);
    }
    return join(homedir(), ".pi", "agent");
}

/** Where Pi keeps its session files, which `/lens usage` reads. */
export const sessionsDir = (env: NodeJS.ProcessEnv = process.env): string => join(agentDir(env), "sessions");

export interface Paths {
    /** jig-core's record files, `<YYYY-MM-DD>.jsonl`. Read only. */
    records: string;
    /** The folder jig-lens owns. */
    lens: string;
    /** The SQLite copy of the records. */
    index: string;
    /** Grafana's own data: its database, with the sign-in. */
    grafanaData: string;
    /** What the viewer printed, from its last start. */
    log: string;
    /** Grafana's provisioning folder: the data source and the dashboards provider, as files. */
    provisioning: string;
    /** The dashboard files the provider loads. */
    dashboards: string;
    /** Datasette's metadata, with the canned queries. */
    datasetteMetadata: string;
}

/** The viewer files that ship with this plugin: `viewer/` beside `src/`. */
export function ownViewerDir(): string {
    return fileURLToPath(new URL("../viewer", import.meta.url));
}

export function lensPaths(state: string, viewerDir: string = ownViewerDir()): Paths {
    const lens = join(state, "lens");
    return {
        records: join(state, "records"),
        lens,
        index: join(lens, "index.sqlite"),
        grafanaData: join(lens, "grafana"),
        log: join(lens, "viewer.log"),
        provisioning: join(viewerDir, "grafana", "provisioning"),
        dashboards: join(viewerDir, "grafana", "dashboards"),
        datasetteMetadata: join(viewerDir, "datasette", "metadata.json"),
    };
}
