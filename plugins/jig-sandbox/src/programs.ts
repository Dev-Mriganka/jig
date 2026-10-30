// The programs the sandbox runtime needs, found on PATH or named in `sandbox.programs`. On Linux that is bubblewrap
// (the sandbox itself), socat (the runtime's bridge to its proxy, used by every network mode) and ripgrep (which the
// runtime uses to look for files it must protect). macOS has its sandbox built in.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { SandboxSettings } from "./config.ts";

export type ProgramName = "bwrap" | "socat" | "ripgrep";

export interface FoundPrograms {
    /** Absolute paths of the programs that were found. */
    found: Partial<Record<ProgramName, string>>;
    /** What is missing, as the doctor says it. */
    missing: Array<{ name: ProgramName; command: string }>;
}

const COMMAND: Record<ProgramName, string> = { bwrap: "bwrap", socat: "socat", ripgrep: "rg" };
const PACKAGE: Record<ProgramName, string> = { bwrap: "bubblewrap", socat: "socat", ripgrep: "ripgrep" };

function isExecutable(file: string): boolean {
    try {
        if (!statSync(file).isFile()) return false;
        accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** An absolute path for a program name from the folders of `pathValue`, or undefined. */
export function onPath(command: string, pathValue: string | undefined): string | undefined {
    for (const folder of (pathValue ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(folder)) continue;
        const candidate = path.join(folder, command);
        if (isExecutable(candidate)) return candidate;
    }
    return undefined;
}

/** The programs the platform needs: the configured path when there is one, else PATH. */
export function findPrograms(
    platform: "linux" | "darwin",
    configured: SandboxSettings["programs"],
    pathValue: string | undefined,
): FoundPrograms {
    const found: FoundPrograms["found"] = {};
    const missing: FoundPrograms["missing"] = [];
    if (platform !== "linux") return { found, missing };
    for (const name of ["bwrap", "socat", "ripgrep"] as const) {
        const given = configured[name];
        const real = given !== undefined ? (isExecutable(given) ? given : undefined) : onPath(COMMAND[name], pathValue);
        if (real === undefined) missing.push({ name, command: given ?? COMMAND[name] });
        else found[name] = real;
    }
    return { found, missing };
}

/** The command that installs what is missing, for a message. */
export function installCommand(platform: "linux" | "darwin", missing: ReadonlyArray<{ name: ProgramName }>): string {
    if (platform === "darwin") return "the sandbox is part of macOS; nothing to install";
    const packages = missing.length === 0 ? Object.values(PACKAGE) : missing.map((item) => PACKAGE[item.name]);
    return `sudo apt install ${packages.join(" ")}`;
}
