// The sandbox broker: the only place Anthropic's sandbox runtime runs.
//
// jig-sandbox starts one broker per Pi session, with the Node that runs Pi and with this folder's session
// directory as its working folder. Pi asks it over the IPC pipe to wrap a command; Pi then spawns the wrapped
// command itself, in the project, so streaming, time limits and cancelling stay Pi's.
//
// Why a process of its own (a spike on a real machine showed all three):
//   - The runtime puts empty placeholder files (`.bashrc`, `.gitconfig`, `.vscode`, ...) into the working folder of
//     the process it runs in, until it cleans up. In Pi that would be the project, where `git add -A` could commit
//     them. Here it is the session's private folder.
//   - The runtime installs SIGINT and SIGTERM handlers that keep the process alive. That is harmless here, and in
//     Pi it could keep a closed session running.
//   - A failure stays contained: if the runtime throws or hangs, Pi restarts this process and refuses the command.
//
// This file is plain JavaScript on purpose: Pi loads the plugin's TypeScript through its own loader, but a plain
// `node` child cannot strip types from files under `node_modules`, where Pi installs packages. The broker holds no
// credentials: Pi starts it with a short environment.
//
// The protocol is one JSON message each way. A request is `{ id, type, ...fields }`; the answer is `{ id, ok: true,
// result }` or `{ id, ok: false, error }`. Messages with no `id` are events: `{ event: "ready" }` once at start.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/** @typedef {{ id: number, type: string } & Record<string, any>} Request */

/** How long the runtime gets to clean up once Pi has gone, before this process leaves anyway. */
const SHUTDOWN_GRACE_MS = 3000;

let initialized = false;
let stopping = false;
/** Wrapped commands that have not finished yet. The runtime's placeholder files are removed only when none is. */
let inFlight = 0;

/** @param {unknown} message */
function send(message) {
    if (process.connected) process.send?.(message);
}

/**
 * Wraps `command` for the sandbox. The result is a shell string that Pi spawns with a shell, in the project.
 * @param {Request} request
 */
async function wrap(request) {
    if (!initialized) throw new Error("the sandbox runtime is not started");
    if (typeof request.command !== "string") throw new Error("wrap needs a command");
    const commandId = String(request.commandId);
    inFlight++;
    try {
        const wrapped = await SandboxManager.wrapWithSandbox(
            request.command,
            undefined,
            request.customConfig,
            undefined,
            {
                commandId,
                commandText: request.command,
            },
        );
        return { wrapped };
    } catch (error) {
        inFlight--;
        throw error;
    }
}

/**
 * Ends one wrapped command: what the runtime recorded as refused (network only: it records no file refusals), and
 * the cleanup of its placeholder files once nothing else is between its wrap and its start.
 * @param {Request} request
 */
function finish(request) {
    const commandId = String(request.commandId);
    inFlight = Math.max(0, inFlight - 1);
    let violations = [];
    try {
        violations = SandboxManager.getSandboxViolationStore()
            .getViolationsForCommand(commandId)
            .map((violation) => ({ line: String(violation.line ?? "") }));
    } catch {
        // No record is not a failure: the command already ran.
    }
    if (inFlight === 0) {
        try {
            SandboxManager.cleanupAfterCommand();
        } catch {
            // The next idle moment tries again, and the session's reset removes what is left.
        }
    }
    return { violations };
}

/** @type {Record<string, (request: Request) => unknown>} */
const handlers = {
    hello: () => ({ pid: process.pid, cwd: process.cwd(), node: process.version }),

    async init(request) {
        if (initialized) await SandboxManager.reset();
        initialized = false;
        await SandboxManager.initialize(request.config, undefined, false);
        initialized = true;
        const { warnings } = SandboxManager.checkDependencies();
        return { warnings };
    },

    wrap,
    finish,

    async reset() {
        await SandboxManager.reset();
        initialized = false;
        inFlight = 0;
        return {};
    },
};

process.on("message", async (/** @type {Request} */ request) => {
    const id = request?.id;
    try {
        const handler = Object.hasOwn(handlers, request?.type) ? handlers[request.type] : undefined;
        if (handler === undefined) throw new Error(`unknown request: ${String(request?.type)}`);
        send({ id, ok: true, result: await handler(request) });
    } catch (error) {
        send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});

/** @param {number} code */
async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
    try {
        await SandboxManager.reset();
    } catch {
        // Leaving is what matters.
    }
    process.exit(code);
}

// Pi closed the pipe, on purpose or by dying: the broker has nothing left to serve.
process.on("disconnect", () => void shutdown(0));
// A fault in the runtime must not leave a half-working broker: Pi sees it exit and starts a new one.
process.on("uncaughtException", (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    void shutdown(1);
});
process.on("unhandledRejection", (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    void shutdown(1);
});

send({ event: "ready" });
