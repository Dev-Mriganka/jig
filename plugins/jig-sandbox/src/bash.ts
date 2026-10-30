// The `bash` tool. It replaces Pi's own, the way Pi's documentation says a tool is replaced (a tool registered under a
// built-in's name wins), and keeps everything of Pi's: its streaming, truncation, time limits and rendering. Only where the
// command runs changes. Pi's `BashSpawnHook` is synchronous and wrapping a command is not, so the tool is built from Pi's
// own definition with its own operations: ask the broker to wrap the command, then hand the wrapped command to Pi's local
// operations with the clean environment.
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Aftermath } from "./aftermath.ts";
import { createOutputCleaner } from "./output.ts";
import { SandboxRefused } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

/** How much of the end of a command's output is kept to explain a block from. */
const TAIL_CHARS = 64 * 1024;

/** What the model is told about this shell, after Pi's own description. */
export const SANDBOX_DESCRIPTION = [
    "This shell runs in a sandbox (jig-sandbox). Everything works as usual: the project, your home folder, /tmp, build caches, git configuration, the network.",
    "The sandbox cannot read credentials (~/.ssh, ~/.aws, ~/.kube, ~/.config/gh, a project's .env files, ...) and cannot write what runs later outside it (shell start-up files, PATH folders, git hooks, Pi's settings and extensions).",
    "A blocked command prints a '[sandbox]' line that says which rule stopped it and what to do instead. Use these ways through:",
    "- git over SSH, fetch, pull, push: the git tool. GitHub pull requests and releases: the pr and release actions.",
    "- kubectl, aws, gcloud, deploys, logs: the runtime, deploy and company tools.",
    "- A project's .env: ask the user for the value, or use the tool that holds the secret.",
    "- Changing source code: the edit and write tools, not a script, so the change shows in reviews.",
    "- A toolchain folder such as ~/.sdkman or ~/.nvm: the user is asked; when a '[sandbox]' line says they allowed it, run the command again.",
    "- A locked file such as ~/.bashrc: the user does it themselves with !.",
].join("\n");

/** What `jig-core` decided about a call, as it announces it on the event bus. */
export interface Decision {
    tool: string;
    action?: string;
    decision: string;
    source: string;
    answer?: string;
}

export interface BashDeps {
    sandbox: Sandbox;
    /** How a wrapped command is run: Pi's own local operations. */
    shell: BashOperations;
    aftermath: Aftermath;
    /** Decisions by tool call id, kept from jig-core's announcements. */
    decisions: ReadonlyMap<string, Decision>;
}

/** Output of a command, cleaned and with the end of it kept for the explanation. */
class Tail {
    private text = "";
    add(chunk: Buffer): void {
        this.text = (this.text + chunk.toString("utf8")).slice(-TAIL_CHARS);
    }
    value(): string {
        return this.text;
    }
}

/**
 * Operations for one call: wrap the command, run it with Pi's local operations, clean what it prints, and explain a
 * block after its output. `shell` is how a wrapped command is run (Pi's own).
 */
export function sandboxedOperations(deps: BashDeps, ctx: ExtensionContext, shell: BashOperations): BashOperations {
    return {
        async exec(command, cwd, { onData, signal, timeout, env }) {
            const prepared = await deps.sandbox.prepare(command, cwd, env);
            const snapshot = deps.aftermath.before(prepared, cwd);
            const cleaner = createOutputCleaner(prepared.values);
            const tail = new Tail();
            const emit = (chunk: Buffer): void => {
                if (chunk.length === 0) return;
                tail.add(chunk);
                onData(chunk);
            };
            let result: { exitCode: number | null } | undefined;
            let failure: unknown;
            let violations: ReadonlyArray<{ line: string }> = [];
            try {
                result = await shell.exec(prepared.wrapped, cwd, {
                    onData: (data) => emit(cleaner.push(data)),
                    ...(signal === undefined ? {} : { signal }),
                    ...(timeout === undefined ? {} : { timeout }),
                    env: prepared.env,
                });
            } catch (error) {
                // An aborted or timed-out command may have planted something before it was stopped, so it is audited as well.
                failure = error;
            }
            emit(cleaner.end());
            // Always: the broker keeps state until it is told, and the audit looks at what the command left.
            violations = (await prepared.finish()).violations;
            const lines = await deps.aftermath.after({
                prepared,
                output: tail.value(),
                cwd,
                ctx,
                snapshot,
                violations,
            });
            if (lines.length > 0) {
                // The lines come after the command's own output, on lines of their own.
                const lead = tail.value() === "" || tail.value().endsWith("\n") ? "" : "\n";
                onData(Buffer.from(`${lead}${lines.join("\n")}\n`));
            }
            if (failure !== undefined) throw failure;
            return result as { exitCode: number | null };
        },
    };
}

/** The tool, ready for `pi.registerTool`. */
export function createBashTool(deps: BashDeps) {
    const base = createBashToolDefinition(process.cwd());

    return {
        ...base,
        description: `${base.description}\n\n${SANDBOX_DESCRIPTION}`,
        async execute(
            toolCallId: string,
            params: { command: string; timeout?: number },
            signal: AbortSignal | undefined,
            onUpdate: Parameters<typeof base.execute>[3],
            ctx: ExtensionContext,
        ) {
            const plain = {
                command: params.command,
                ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
            };
            const cwd = ctx.cwd || process.cwd();
            // The user turned the sandbox off for this session: the command runs as Pi runs it.
            if (deps.sandbox.state.kind === "off") {
                return base.execute(toolCallId, plain, signal, onUpdate, ctx as never);
            }
            const definition = createBashToolDefinition(cwd, {
                operations: sandboxedOperations(deps, ctx, deps.shell),
            });
            try {
                return await definition.execute(toolCallId, plain, signal, onUpdate, ctx as never);
            } catch (error) {
                // Pi shows an error as the tool's result; a refusal says what to do.
                if (error instanceof SandboxRefused) throw new Error(error.message);
                throw error;
            }
        },
    };
}
