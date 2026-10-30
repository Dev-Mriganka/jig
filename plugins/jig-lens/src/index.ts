// Pi entry point of jig-lens. The factory only registers: the `lens` section goes to jig-core, and the import and the
// commands are wired to Pi's events. Nothing is read, opened or started until an agent run ends or a command runs.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withJig } from "../../jig-core/src/client.ts";
import { settingsFrom, validateLens } from "./config.ts";
import type { Deps } from "./deps.ts";
import { registerLens } from "./lens.ts";
import { lensPaths, stateDir } from "./paths.ts";
import { browserOpener, findProgram } from "./programs.ts";
import { homepathOf, probeViewer, spawnDetached } from "./viewer.ts";

/** The parts a test replaces, so that no test starts Grafana or opens a browser. */
export type LensOptions = Partial<Deps> & {
    /** The folder with `grafana/` and `datasette/`. Default: this plugin's own `viewer` folder. */
    viewerDir?: string;
};

/** The `lens` section as jig-core loaded it. Without jig-core, or without the section, the defaults apply. */
function lensSection(): unknown {
    try {
        return jig().config.section("lens");
    } catch {
        return undefined;
    }
}

/** The extension, with parts a test can replace (the program that starts the viewer, the browser). Pi loads the default
 *  export below. */
export function lens(options: LensOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const env = options.env ?? process.env;
        const find = options.find ?? ((names) => findProgram(names, env));
        withJig((api) => api.config.registerSection("lens", validateLens));
        registerLens(pi, {
            env,
            now: options.now ?? (() => new Date()),
            paths: options.paths ?? (() => lensPaths(stateDir(env), options.viewerDir)),
            settings: options.settings ?? (() => settingsFrom(lensSection())),
            find,
            homepath: options.homepath ?? homepathOf,
            probe: options.probe ?? probeViewer,
            spawn: options.spawn ?? spawnDetached,
            open: options.open ?? browserOpener(env, find, process.platform),
            sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        });
    };
}

export default lens();
