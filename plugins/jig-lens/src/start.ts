// Starting the viewer, and waiting until it answers.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LensSettings } from "./config.ts";
import type { Deps } from "./deps.ts";
import type { Paths } from "./paths.ts";
import { FIRST_START, missingProgram, reason } from "./report.ts";
import { DATASETTE_PROGRAMS, datasetteCommand, GRAFANA_PROGRAMS, grafanaCommand, viewerUrl } from "./viewer.ts";
import type { Started, Viewer } from "./viewer.ts";

/** Grafana takes several seconds to start, and most of a minute the first time on a busy machine. These wait for it
 *  up to a minute. */
export const START_ATTEMPTS = 120;
export const START_WAIT_MS = 500;

/** What starting came to: whether the viewer answers now, and what to tell the user. */
export interface StartResult {
    ok: boolean;
    lines: string[];
}

/**
 * Starts the viewer detached and waits for it to answer. It stops waiting early when the program has already exited,
 * which is what a wrong port or a missing home folder looks like.
 */
export async function startViewer(
    deps: Pick<Deps, "env" | "find" | "homepath" | "probe" | "spawn" | "sleep">,
    viewer: Viewer,
    settings: LensSettings,
    paths: Paths,
): Promise<StartResult> {
    const grafana = viewer === "grafana";
    const name = grafana ? "Grafana" : "Datasette";
    const program = deps.find(grafana ? GRAFANA_PROGRAMS : DATASETTE_PROGRAMS);
    if (program === undefined) return { ok: false, lines: [missingProgram(viewer)] };

    const firstStart = grafana && !existsSync(join(paths.grafanaData, "grafana.db"));
    const command = grafana
        ? grafanaCommand(program, deps.homepath(program), settings, paths, deps.env)
        : datasetteCommand(program, settings, paths, deps.env);
    let started: Started;
    try {
        // Grafana makes its data folder when it is missing, but the user's own umask would decide who can read it.
        mkdirSync(grafana ? paths.grafanaData : paths.lens, { recursive: true, mode: 0o700 });
        started = await deps.spawn(command);
    } catch (error) {
        return { ok: false, lines: [`Could not start ${program}: ${reason(error)}`] };
    }

    const url = viewerUrl(settings);
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
        if ((await deps.probe(viewer, settings.port)) === "running") {
            const pid = started.pid === undefined ? "" : ` (process ${started.pid})`;
            return { ok: true, lines: [`${name} started${pid} at ${url}.`, ...(firstStart ? FIRST_START : [])] };
        }
        const exit = started.exited();
        if (exit !== undefined) {
            const stopped = `${name} stopped as soon as it started (exit code ${exit.code}).`;
            return { ok: false, lines: [`${stopped} Its output is in ${paths.log}.`] };
        }
        await deps.sleep(START_WAIT_MS);
    }
    const silent = `${name} was started but does not answer on ${url} yet.`;
    return { ok: false, lines: [`${silent} Its output is in ${paths.log}.`] };
}
