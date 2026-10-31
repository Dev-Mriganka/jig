// Pi entry point of jig-sandbox. The factory only registers: the `bash` tool that replaces Pi's, the `/sandbox` command, the
// `sandbox` section of jig.json, and the sandbox itself with jig-core. Nothing is started until a session starts, and the
// one long-lived thing, the broker, is a child process that Pi stops when the session ends. This plugin installs no signal
// handler in Pi: the runtime that does is in the broker.
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withJig } from "../../jig-core/src/client.ts";
import type { SandboxProvider } from "../../jig-core/src/contract.ts";
import { createAftermath } from "./aftermath.ts";
import type { Aftermath } from "./aftermath.ts";
import { createAllowed } from "./allowed.ts";
import { createAsker } from "./ask.ts";
import { backgroundDeclarations } from "./background/declarations.ts";
import { registerPs } from "./background/ps.ts";
import { Tasks } from "./background/tasks.ts";
import type { TasksDeps } from "./background/tasks.ts";
import { backgroundTools } from "./background/tools.ts";
import { createBashTool } from "./bash.ts";
import type { Decision } from "./bash.ts";
import { startBroker } from "./broker-client.ts";
import { registerSandboxCommand } from "./commands.ts";
import { settingsFrom, validateSandbox } from "./config.ts";
import { bashDeclaration } from "./outside.ts";
import type { OutsideRun } from "./outside.ts";
import type { SandboxSettings } from "./config.ts";
import { nodeFiles } from "./files.ts";
import type { FileView } from "./files.ts";
import { detectWsl } from "./platform.ts";
import { Sandbox } from "./sandbox.ts";
import type { SandboxDeps } from "./sandbox.ts";
import type { ProtectedEntry } from "./rules.ts";

/** The parts a test replaces, so that no test starts a sandbox it did not mean to. */
export type SandboxOptions = Partial<Omit<SandboxDeps, "createdByAgent">> & {
    /** The aftermath of a command; default is the real one. */
    aftermath?: Aftermath;
    /** The name `/sandbox doctor` looks up. */
    lookupName?: string;
    /** Parts of the background tasks a test replaces: the shell that runs a wrapped command, the timing of wake-ups, the grace period. */
    background?: Partial<Pick<TasksDeps, "shell" | "timing" | "graceMs" | "segmentBytes" | "port">>;
};

/** The `sandbox` section as jig-core loaded it. Without jig-core, or without the section, the defaults apply. */
function sandboxSection(): unknown {
    try {
        return jig().config.section("sandbox");
    } catch {
        return undefined;
    }
}

/** The protected paths of jig-core, or none when jig-core is not loaded: the sandbox has lists of its own as well. */
function protectedFromCore(): ProtectedEntry[] {
    try {
        return jig()
            .protectedPaths.list()
            .map((entry) => ({ path: entry.path, shown: entry.shown, kind: entry.kind, source: entry.source }));
    } catch {
        return [];
    }
}

/** The folders of the Node.js and the Pi that run Pi: what a command in the sandbox must not be able to replace. */
function runtimeFolders(files: FileView): string[] {
    const found = new Set<string>();
    const node = files.real(process.execPath);
    // <prefix>/bin/node: the prefix holds the global packages, Pi among them.
    if (node !== undefined && path.basename(path.dirname(node)) === "bin") found.add(path.dirname(path.dirname(node)));
    const script = process.argv[1] === undefined ? undefined : files.real(process.argv[1]);
    for (let folder = script === undefined ? undefined : path.dirname(script); folder !== undefined; ) {
        const manifest = files.read(path.join(folder, "package.json"));
        if (manifest !== undefined && /"name"\s*:\s*"@earendil-works\/pi-coding-agent"/.test(manifest)) {
            found.add(folder);
            break;
        }
        const parent = path.dirname(folder);
        folder = parent === folder ? undefined : parent;
    }
    return [...found];
}

/** What the footer says. */
function footerText(sandbox: Sandbox): string | undefined {
    switch (sandbox.state.kind) {
        case "ready":
            return `bash: sandboxed, network ${sandbox.mode}`;
        case "off":
            return "bash: not sandboxed";
        case "unavailable":
            return "bash: refused, no sandbox";
        default:
            return undefined;
    }
}

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function sandbox(options: SandboxOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const env = options.env ?? process.env;
        const files = options.files ?? nodeFiles;
        const platform = options.platform ?? process.platform;
        const agentDir = options.agentDir ?? (() => getAgentDir());
        const homeOf = options.home ?? (() => userInfo().homedir);
        const allowed = createAllowed(agentDir);
        const settings: () => SandboxSettings = options.settings ?? (() => settingsFrom(sandboxSection()));
        const exec: BashOperations["exec"] = options.exec ?? createLocalBashOperations().exec;
        const core = new Sandbox({
            brokerScript: options.brokerScript ?? fileURLToPath(new URL("../broker/broker.mjs", import.meta.url)),
            env,
            files,
            platform,
            home: homeOf,
            uid: options.uid ?? process.getuid?.() ?? 0,
            wsl: options.wsl ?? detectWsl(env, files, platform),
            tmpRoot: options.tmpRoot ?? os.tmpdir(),
            agentDir,
            settings,
            protectedPaths: options.protectedPaths ?? protectedFromCore,
            runtimePaths: options.runtimePaths ?? (() => runtimeFolders(files)),
            approved: options.approved ?? (() => allowed.folders()),
            createdByAgent: new Set(),
            startBroker: options.startBroker ?? startBroker,
            exec,
            random: options.random ?? (() => randomBytes(4).toString("hex")),
            now: options.now ?? (() => Date.now()),
        });

        // jig-core announces every decision; the tool reads them, so that what it runs is only what jig-core let through.
        const decisions = new Map<string, Decision>();
        const unlisten = pi.events.on("jig:decision", (event) => {
            const decision = event as Decision & { toolCallId?: string };
            if (typeof decision?.toolCallId !== "string") return;
            decisions.set(decision.toolCallId, decision);
            if (decisions.size > 500) decisions.delete(decisions.keys().next().value as string);
        });

        const provider: SandboxProvider = {
            get active() {
                return core.state.kind === "ready" || core.state.kind === "starting";
            },
            get mode() {
                return core.mode;
            },
            get note() {
                switch (core.state.kind) {
                    case "off":
                        return "you switched it off for this session with /sandbox off; /sandbox on turns it back on";
                    case "unavailable":
                        return `bash is refused, because ${core.state.reason}`;
                    case "stopped":
                        return "the sandbox is not running";
                    default:
                        return undefined;
                }
            },
            canWrite: (place) => core.canWrite(place),
            whenReady: () => core.whenReady(),
        };
        // Where the session's commands run, for the dialog that asks about running one outside.
        let sessionFolder = process.cwd();
        const outsideRuns: OutsideRun[] = [];
        withJig((api) => {
            api.config.registerSection("sandbox", validateSandbox);
            api.sandbox.register(provider);
            api.declareTool(bashDeclaration({ folder: () => sessionFolder, home: homeOf }));
            for (const declaration of backgroundDeclarations()) api.declareTool(declaration);
        });

        const refresh = (ctx: Pick<ExtensionContext, "ui">): void => {
            try {
                const text = footerText(core);
                const red = core.state.kind === "off" || core.state.kind === "unavailable";
                const themed = text !== undefined && red ? ctx.ui.theme?.fg("error", text) : text;
                ctx.ui.setStatus("jig-sandbox", themed);
            } catch {
                // A screen from a session that has ended.
            }
        };

        const aftermath =
            options.aftermath ??
            createAftermath({
                sandbox: core,
                agentDir,
                now: options.now ?? (() => Date.now()),
                asker: createAsker(allowed, homeOf),
            });
        const tasks = new Tasks({
            sandbox: core,
            aftermath,
            agentDir,
            settings: () => settings().background,
            env,
            shell:
                options.background?.shell ??
                (() => {
                    const found = getShellConfig();
                    return { shell: found.shell, args: found.args };
                }),
            now: options.now ?? (() => Date.now()),
            send: (message, sendOptions) => pi.sendMessage(message, sendOptions),
            emit: (channel, data) => pi.events.emit(channel, data),
            ...(options.background?.timing === undefined ? {} : { timing: options.background.timing }),
            ...(options.background?.graceMs === undefined ? {} : { graceMs: options.background.graceMs }),
            ...(options.background?.segmentBytes === undefined
                ? {}
                : { segmentBytes: options.background.segmentBytes }),
            ...(options.background?.port === undefined ? {} : { port: options.background.port }),
        });
        pi.registerTool(
            createBashTool({
                sandbox: core,
                shell: { exec },
                aftermath,
                decisions,
                outsideRuns,
                tasks,
                now: options.now ?? (() => Date.now()),
                jig: () => {
                    try {
                        return jig();
                    } catch {
                        return undefined;
                    }
                },
            }) as never,
        );
        for (const tool of backgroundTools(tasks)) pi.registerTool(tool as never);
        registerPs(pi, tasks);
        pi.on("message_start", (event) => {
            tasks.onMessageStart(event.message as { role?: string; customType?: string });
        });
        registerSandboxCommand(pi, {
            sandbox: core,
            allowed,
            platform,
            refresh,
            outsideRuns,
            ...(options.lookupName === undefined ? {} : { lookupName: options.lookupName }),
        });

        pi.on("session_start", (_event, ctx) => {
            sessionFolder = ctx.cwd;
            tasks.sessionStart(ctx);
            const started = core.start(ctx.sessionManager.getSessionId(), ctx.cwd);
            refresh(ctx);
            void started.then(() => refresh(ctx));
        });
        pi.on("session_shutdown", async () => {
            // Stopping the broker is the one thing this plugin does when a session ends. It is safe to run twice.
            unlisten?.();
            // The tasks first: they are commands in the sandbox, and the broker that wraps them must outlive their stop.
            await tasks.shutdown();
            await core.stop();
        });
    };
}

export default sandbox();
