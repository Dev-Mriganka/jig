// What the commands use of the outside world. A test replaces the parts that would start a program or open a page.
import type { LensSettings } from "./config.ts";
import type { Paths } from "./paths.ts";
import type { Open } from "./programs.ts";
import type { Spawn, ViewerState } from "./viewer.ts";

export interface Deps {
    /** Pi's environment, for the state folder, PATH and what the viewer is passed of it. */
    env: NodeJS.ProcessEnv;
    now(): Date;
    /** Looked up at each use, so the state folder is the one the environment names now. */
    paths(): Paths;
    /** From the `lens` section of jig.json, or the defaults. */
    settings(): LensSettings;
    /** The first of the program names that is on PATH, as an absolute path. */
    find(names: readonly string[]): string | undefined;
    /** Grafana's home folder, found from its program. */
    homepath(program: string): string | undefined;
    probe(viewer: LensSettings["viewer"], port: number): Promise<ViewerState>;
    spawn: Spawn;
    open: Open;
    sleep(ms: number): Promise<void>;
}
