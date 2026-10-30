// Facts about the machine that the rules depend on, found the cheap way.
import type { FileView } from "./files.ts";

/** Linux running inside Windows: its Windows drives and interop sockets are doors out of the sandbox. */
export function detectWsl(
    env: NodeJS.ProcessEnv,
    files: FileView,
    platform: NodeJS.Platform = process.platform,
): boolean {
    if (platform !== "linux") return false;
    if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== "") return true;
    return /microsoft|wsl/i.test(files.read("/proc/version") ?? "");
}
