// The `bash` tool. It replaces Pi's own, the way Pi's documentation says a tool is replaced (a tool registered under a
// built-in's name wins), and keeps everything of Pi's: its streaming, truncation, time limits and rendering. Only where the
// command runs changes. Pi's `BashSpawnHook` is synchronous and wrapping a command is not, so the tool is built from Pi's
// own definition with its own operations: ask the broker to wrap the command, then hand the wrapped command to Pi's local
// operations with the clean environment.
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Aftermath } from "./aftermath.ts";
import { fingerprintOutside, outsideProblem } from "./outside.ts";
import type { OutsideRun } from "./outside.ts";
import { createOutputCleaner } from "./output.ts";
import { SandboxRefused } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

/** How much of the end of a command's output is kept to explain a block from. */
const TAIL_CHARS = 64 * 1024;

const OUTSIDE_PARAMETER =
    "Set true only when the sandbox blocks something you need and no Jig tool does it (Docker, a script that needs the " +
    "user's credentials, a build that must reach a private repository). The user is asked to approve this one command " +
    "running outside the sandbox, with their credentials and full network. Needs a reason.";
const REASON_PARAMETER =
    "With outside: why the sandbox blocks what you need and no Jig tool does it, in one sentence (at most 300 characters).";

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
    "Only when the sandbox blocks something you need and no Jig tool does it, set outside: true and give a reason (at most 300 characters): the user is asked whether this one command may run outside the sandbox, with their credentials and full network.",
].join("\n");

/** What `jig-core` decided about a call, as it announces it on the event bus. */
export interface Decision {
    tool: string;
    action?: string;
    decision: string;
    source: string;
    answer?: string;
}

/** What `bash` uses of jig-core: the preview the user approved and the facts of a call's record. */
export interface JigCalls {
    approvedPreview(toolCallId: string): { fingerprint?: string } | undefined;
    addFacts(toolCallId: string, facts: Readonly<Record<string, number | boolean | string>>): void;
}

export interface BashDeps {
    sandbox: Sandbox;
    /** jig-core's calls, or undefined when it is not loaded: then nothing can run outside. */
    jig: () => JigCalls | undefined;
    /** The commands that ran outside the sandbox in this session, for `/sandbox`. */
    outsideRuns: OutsideRun[];
    now: () => number;
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

/** Pi's own local operations with the output cleaned of terminal control sequences: for a command that runs outside. */
function cleanedLocalOperations(shell: BashOperations): BashOperations {
    return {
        async exec(command, cwd, { onData, signal, timeout, env }) {
            const cleaner = createOutputCleaner();
            try {
                return await shell.exec(command, cwd, {
                    onData: (data) => {
                        const out = cleaner.push(data);
                        if (out.length > 0) onData(out);
                    },
                    ...(signal === undefined ? {} : { signal }),
                    ...(timeout === undefined ? {} : { timeout }),
                    ...(env === undefined ? {} : { env }),
                });
            } finally {
                const rest = cleaner.end();
                if (rest.length > 0) onData(rest);
            }
        },
    };
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

/** Pi's own parameters for `bash`, and the two that ask to run outside. */
function parametersOf(base: ToolDefinition) {
    const properties = (base.parameters as unknown as { properties: Record<string, never> }).properties;
    return Type.Object({
        ...properties,
        outside: Type.Optional(Type.Boolean({ description: OUTSIDE_PARAMETER })),
        reason: Type.Optional(Type.String({ maxLength: 300, description: REASON_PARAMETER })),
    });
}

/**
 * Runs one command outside the sandbox, with Pi's ordinary local operations, when jig-core has let this call through: it
 * announced an allow for exactly this tool call, as the action `outside`, and what is about to run is what the user was
 * shown. Anything else is refused, so a call that skipped jig-core (or one that jig-core never saw) never runs unwrapped.
 */
async function runOutside(
    deps: BashDeps,
    toolCallId: string,
    params: { command: string; timeout?: number; reason?: string },
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
    ctx: ExtensionContext,
    cwd: string,
) {
    const refuse = (why: string): never => {
        throw new Error(`bash was not run outside the sandbox: ${why}`);
    };
    const calls = deps.jig();
    if (calls === undefined) return refuse("jig-core is not loaded, and it is what asks the user");
    const decision = deps.decisions.get(toolCallId);
    // Allowed by a rule or by the user's earlier answer (`allow`), or asked and answered yes (`ask` with an answer).
    const allowed =
        decision?.decision === "allow" ||
        (decision?.decision === "ask" && (decision.answer === "allow" || decision.answer === "allow-session"));
    if (decision?.tool !== "bash" || decision.action !== "outside" || !allowed) {
        return refuse("jig-core has not allowed this call");
    }
    const problem = outsideProblem(params);
    if (problem !== undefined) return refuse(problem);
    const approved = calls.approvedPreview(toolCallId);
    if (
        approved?.fingerprint !== undefined &&
        approved.fingerprint !== fingerprintOutside(params.command, String(params.reason), cwd)
    ) {
        return refuse("the command or the folder changed after the user was shown it");
    }
    calls.addFacts(toolCallId, { outside: true });
    deps.outsideRuns.push({
        at: new Date(deps.now()),
        command: params.command,
        folder: cwd,
        reason: String(params.reason),
        how:
            decision.source === "rule"
                ? "rule"
                : decision.answer === "allow-session" || decision.source === "session"
                  ? "session"
                  : "once",
    });
    const plain = { command: params.command, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) };
    const definition = createBashToolDefinition(cwd, {
        operations: cleanedLocalOperations(createLocalBashOperations()),
    });
    return definition.execute(toolCallId, plain, signal, onUpdate, ctx as never);
}

/** The tool, ready for `pi.registerTool`. */
export function createBashTool(deps: BashDeps) {
    const base = createBashToolDefinition(process.cwd());
    const parameters = parametersOf(base as unknown as ToolDefinition);

    return {
        ...base,
        parameters,
        description: `${base.description}\n\n${SANDBOX_DESCRIPTION}`,
        async execute(
            toolCallId: string,
            params: { command: string; timeout?: number; outside?: boolean; reason?: string },
            signal: AbortSignal | undefined,
            onUpdate: Parameters<typeof base.execute>[3],
            ctx: ExtensionContext,
        ) {
            const plain = {
                command: params.command,
                ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
            };
            const cwd = ctx.cwd || process.cwd();
            if (params.outside === true) return runOutside(deps, toolCallId, params, signal, onUpdate, ctx, cwd);
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
