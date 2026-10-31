// The environment a background command starts from: what Pi's own bash tool would give it (the process environment, Pi's
// `bin` folder on `PATH`, the `PI_*` session variables), before the sandbox takes credentials out. Pi does not export its
// own `getShellEnv`, so this follows it.
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_VARIABLES = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

export function buildTaskEnv(
    base: NodeJS.ProcessEnv,
    agentDir: string,
    ctx: Partial<ExtensionContext> | undefined,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const binDir = path.join(agentDir, "bin");
    const entries = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
    if (!entries.includes(binDir)) env[pathKey] = [binDir, ...entries].join(path.delimiter);
    for (const name of SESSION_VARIABLES) delete env[name];
    try {
        const manager = ctx?.sessionManager;
        if (manager) {
            env.PI_SESSION_ID = manager.getSessionId();
            const file = manager.getSessionFile();
            if (file) env.PI_SESSION_FILE = file;
        }
        if (ctx?.model) {
            env.PI_PROVIDER = ctx.model.provider;
            env.PI_MODEL = ctx.model.id;
        }
        if (ctx?.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
    } catch {
        // A context that has ended: the command still runs.
    }
    return env;
}
