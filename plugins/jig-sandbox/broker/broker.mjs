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
/** How long Pi gets to decide about a host (it may be asking a person) before the connection is refused. */
const ASK_TIMEOUT_MS = 10 * 60_000;

let initialized = false;
let stopping = false;
/** Connections the proxy waits on Pi to decide, by the number the question was sent with. */
const questions = new Map();
let questionCounter = 0;
/** Wrapped commands that have not finished yet. The runtime's placeholder files are removed only when none is. */
let inFlight = 0;

/** @param {unknown} message */
function send(message) {
    if (process.connected) process.send?.(message);
}

/**
 * The runtime's question about a host no list decided. The decision is Pi's (its rules, and you in `ask` mode), so the question
 * goes over the pipe and the connection waits for the answer. Anything but a clear yes is a no: a closed pipe, a slow answer.
 * @param {{ host: string, port: number | undefined }} target
 */
function askPi(target) {
    return new Promise((resolve) => {
        if (!process.connected) return resolve({ allow: false, reason: "the sandbox could not ask: Pi is gone" });
        const askId = ++questionCounter;
        const timer = setTimeout(() => {
            questions.delete(askId);
            resolve({ allow: false, reason: "nobody answered in time" });
        }, ASK_TIMEOUT_MS);
        questions.set(askId, (answer) => {
            clearTimeout(timer);
            resolve(answer);
        });
        send({ event: "ask-host", askId, host: String(target.host), port: Number(target.port) });
    });
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
                commandText: typeof request.commandText === "string" ? request.commandText : request.command,
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
        let callback;
        if (request.askHosts === true) {
            // Releases before 0.0.78 read any answer that is not false as a yes, so an object with a reason would allow.
            if (SandboxManager.askCallbackDenyReason !== true) {
                throw new Error(
                    "this sandbox runtime cannot give a reason for refusing a host, so filtered and ask are not safe with it",
                );
            }
            callback = async (target) => {
                const answer = await askPi(target);
                return answer.allow === true ? true : { allow: false, reason: String(answer.reason || "refused") };
            };
        }
        await SandboxManager.initialize(request.config, callback, false);
        initialized = true;
        const { warnings } = SandboxManager.checkDependencies();
        return { warnings };
    },

    wrap,
    finish,

    /** Pi's answer to a question about a host. */
    "answer-host"(request) {
        const resolve = questions.get(request.askId);
        if (resolve !== undefined) {
            questions.delete(request.askId);
            resolve({ allow: request.allow === true, reason: String(request.reason ?? "") });
        }
        return {};
    },

    async reset() {
        await SandboxManager.reset();
        initialized = false;
        inFlight = 0;
        for (const resolve of questions.values()) resolve({ allow: false, reason: "the sandbox was reset" });
        questions.clear();
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
