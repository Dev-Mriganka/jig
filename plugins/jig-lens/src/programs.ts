// Finding programs on PATH, and opening a page in the user's browser.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function isExecutable(file: string): boolean {
    try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

/**
 * The first of `names` that is an executable file in a folder of PATH, as an absolute path; the names are in order of
 * preference. A relative folder in PATH (the empty one means the current folder) is left out. The current folder is a
 * project the agent works in, and a program placed there must not run because the user typed `/lens`.
 */
export function findProgram(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
    const folders = (env.PATH ?? "").split(delimiter).filter((folder) => isAbsolute(folder));
    for (const name of names) {
        for (const folder of folders) {
            const file = join(folder, name);
            if (isExecutable(file)) return file;
        }
    }
    return undefined;
}

/** Opens a page in the browser. Resolves to false when there was nothing to open it with. */
export type Open = (url: string) => Promise<boolean>;

/**
 * Opens the page the way a desktop does: with `$BROWSER` when it is set (a program, with arguments if needed), else
 * with `xdg-open`, else with `open` on macOS. Only on macOS: on other systems `open` can be another program, such as
 * the console tool `openvt`. The program is started without a shell, so the address is never read as a command.
 */
export function browserOpener(
    env: NodeJS.ProcessEnv,
    find: (names: readonly string[]) => string | undefined,
    platform: NodeJS.Platform,
): Open {
    return (url) => {
        const [program = "", ...args] = (env.BROWSER ?? "").trim().split(/\s+/);
        const fromEnv = program === "" ? undefined : isAbsolute(program) ? program : find([program]);
        const file = fromEnv ?? find(platform === "darwin" ? ["xdg-open", "open"] : ["xdg-open"]);
        if (file === undefined) return Promise.resolve(false);
        // The arguments belong to `$BROWSER`; the desktop's own opener takes only the address.
        const given = fromEnv === undefined ? [] : args;
        return new Promise((resolve) => {
            const child = spawn(file, [...given, url], { detached: true, stdio: "ignore" });
            child.once("error", () => resolve(false));
            child.once("spawn", () => {
                // The browser outlives this call, and Pi must not wait for it.
                child.unref();
                resolve(true);
            });
        });
    };
}
