// The programs the real-sandbox tests need, found the way a user's machine has them, or named by environment variables
// for a machine where they live somewhere else (nothing here is a path of this repository's own).
//
//   JIG_SANDBOX_TEST_BWRAP, JIG_SANDBOX_TEST_SOCAT, JIG_SANDBOX_TEST_RG   absolute paths to the three programs
//
// A test that needs the real sandbox calls `realSandboxReason()`: a string is the reason to skip. In CI (the `CI`
// variable is set) a missing program is a failure and not a skip, so the escape tests cannot quietly stop running.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export interface TestPrograms {
    bwrap?: string;
    socat?: string;
    ripgrep?: string;
}

function onPath(name: string): string | undefined {
    for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(folder)) continue;
        const candidate = path.join(folder, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Not here.
        }
    }
    return undefined;
}

/** Absolute paths for the three programs, from the environment variables first and the PATH after. */
export function testPrograms(): TestPrograms {
    const out: TestPrograms = {};
    const bwrap = process.env.JIG_SANDBOX_TEST_BWRAP ?? onPath("bwrap");
    const socat = process.env.JIG_SANDBOX_TEST_SOCAT ?? onPath("socat");
    const ripgrep = process.env.JIG_SANDBOX_TEST_RG ?? onPath("rg");
    if (bwrap !== undefined) out.bwrap = bwrap;
    if (socat !== undefined) out.socat = socat;
    if (ripgrep !== undefined) out.ripgrep = ripgrep;
    return out;
}

/** Whether `rg` is a program and not a shell function: the sandbox runs it, so a function cannot stand in. */
function runs(program: string, args: string[]): boolean {
    try {
        execFileSync(program, args, { stdio: "ignore", timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}

/** Why the real-sandbox tests cannot run here, or undefined when they can. */
export function realSandboxReason(): string | undefined {
    if (process.platform !== "linux") return "the real-sandbox tests run on Linux (bubblewrap)";
    const programs = testPrograms();
    const missing = [
        programs.bwrap === undefined ? "bwrap (apt install bubblewrap)" : undefined,
        programs.socat === undefined ? "socat (apt install socat)" : undefined,
        programs.ripgrep === undefined ? "rg (apt install ripgrep)" : undefined,
    ].filter((name) => name !== undefined);
    if (missing.length > 0) return `missing programs: ${missing.join(", ")}`;
    if (!runs(programs.bwrap as string, ["--unshare-user", "--ro-bind", "/", "/", "true"])) {
        return "bubblewrap cannot make a user namespace here (on Ubuntu 24.04: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)";
    }
    return undefined;
}

/**
 * The reason to skip a real-sandbox test, or undefined to run it. In CI a reason throws instead, so a runner without
 * the programs fails the build and does not pass by skipping every escape test.
 */
export function skipUnlessRealSandbox(): string | boolean {
    const reason = realSandboxReason();
    if (reason === undefined) return false;
    if (process.env.CI) throw new Error(`the real-sandbox tests are required in CI: ${reason}`);
    return reason;
}
