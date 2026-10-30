// Pi's side of the broker (broker/broker.mjs): starts it, sends requests over its pipe, and stops it.
//
// The broker is started with the Node that runs Pi (`process.execPath`), from the plugin's own files, with no loader
// options and a short environment. Its only link to Pi is the pipe `fork` makes, so no other process can talk to it.
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** How to start the broker. */
export interface BrokerLaunch {
    /** The broker's script. */
    script: string;
    /** The working folder of the broker: the session's private folder, never the project. */
    cwd: string;
    /** The whole environment of the broker. */
    env: Record<string, string>;
    /** Default: the Node that runs Pi. */
    execPath?: string;
    /** How long a start may take. Default 10 s. */
    startTimeoutMs?: number;
    /** After the pipe is closed the broker cleans up and leaves by itself; this is how long it gets before it is killed. Default 3.5 s. */
    stopGraceMs?: number;
}

/** A running broker. */
export interface Broker {
    readonly pid: number | undefined;
    /** False once the process has exited or the pipe is closed. */
    readonly alive: boolean;
    /** Sends one request and returns its result. Rejects with a `BrokerError` when the broker fails, stops or is too slow. */
    request<T>(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    /** Closes the pipe, which makes the broker leave, and kills it if it does not. Safe to call twice. */
    stop(): Promise<void>;
    /** Runs once when the process ends, however it ends. */
    onExit(listener: (code: number | null) => void): void;
    /** The last lines the broker wrote to its error output, for a message when it fails. */
    stderrTail(): string;
}

/** The broker could not do what was asked. `timedOut` means it did not answer in time. */
export class BrokerError extends Error {
    readonly timedOut: boolean;
    constructor(message: string, timedOut = false) {
        super(message);
        this.timedOut = timedOut;
    }
}

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_500;
const STDERR_KEEP = 4_000;

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

type Answer = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

function isAnswer(message: unknown): message is Answer {
    return typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "number";
}

/** Starts the broker and waits until it says it is ready. */
export async function startBroker(launch: BrokerLaunch): Promise<Broker> {
    const child = fork(launch.script, [], {
        cwd: launch.cwd,
        env: launch.env,
        execPath: launch.execPath ?? process.execPath,
        // Not Pi's own options: a test runner's loader or a debugger flag must not reach the broker.
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
    });
    return new Promise<Broker>((resolve, reject) => {
        const pending = new Map<number, Pending>();
        const exitListeners: Array<(code: number | null) => void> = [];
        let stderr = "";
        let exited = false;
        let ready = false;
        let nextId = 1;
        let stopping: Promise<void> | undefined;

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (text: string) => {
            stderr = (stderr + text).slice(-STDERR_KEEP);
        });

        const startTimer = setTimeout(() => {
            killNow(child);
            reject(new BrokerError("the sandbox broker did not start in time", true));
        }, launch.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);

        const failAll = (message: string): void => {
            for (const [id, entry] of pending) {
                clearTimeout(entry.timer);
                pending.delete(id);
                entry.reject(new BrokerError(message));
            }
        };

        child.on("message", (message: unknown) => {
            if (!ready && typeof message === "object" && (message as { event?: unknown } | null)?.event === "ready") {
                ready = true;
                clearTimeout(startTimer);
                resolve(broker);
                return;
            }
            if (!isAnswer(message)) return;
            const entry = pending.get(message.id);
            if (entry === undefined) return;
            clearTimeout(entry.timer);
            pending.delete(message.id);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new BrokerError(message.error));
        });

        child.once("error", (error) => {
            clearTimeout(startTimer);
            if (!ready) reject(new BrokerError(`the sandbox broker could not start: ${error.message}`));
            failAll(`the sandbox broker failed: ${error.message}`);
        });

        child.once("exit", (code) => {
            exited = true;
            clearTimeout(startTimer);
            if (!ready)
                reject(new BrokerError(`the sandbox broker exited at start (${code ?? "signal"}): ${stderr.trim()}`));
            failAll("the sandbox broker stopped");
            for (const listener of exitListeners) listener(code);
        });

        const broker: Broker = {
            get pid() {
                return child.pid;
            },
            get alive() {
                return !exited && child.connected;
            },
            request<T>(type: string, fields: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
                return new Promise<T>((resolveRequest, rejectRequest) => {
                    if (exited || !child.connected) {
                        rejectRequest(new BrokerError("the sandbox broker is not running"));
                        return;
                    }
                    const id = nextId++;
                    const timer = setTimeout(() => {
                        pending.delete(id);
                        rejectRequest(new BrokerError(`the sandbox broker did not answer ${type} in time`, true));
                    }, timeoutMs);
                    pending.set(id, {
                        resolve: resolveRequest as (value: unknown) => void,
                        reject: rejectRequest,
                        timer,
                    });
                    child.send({ ...fields, id, type }, (error) => {
                        if (error === null) return;
                        clearTimeout(timer);
                        pending.delete(id);
                        rejectRequest(new BrokerError(`the sandbox broker could not be reached: ${error.message}`));
                    });
                });
            },
            stop() {
                stopping ??= new Promise<void>((done) => {
                    if (exited) return done();
                    exitListeners.push(() => done());
                    const grace = setTimeout(() => killNow(child), launch.stopGraceMs ?? STOP_GRACE_MS);
                    grace.unref();
                    if (child.connected) child.disconnect();
                    else killNow(child);
                });
                return stopping;
            },
            onExit(listener) {
                if (exited) listener(child.exitCode);
                else exitListeners.push(listener);
            },
            stderrTail: () => stderr,
        };
    });
}

/** SIGKILL: the runtime keeps a process alive through SIGTERM, so only this ends a broker that does not answer. */
function killNow(child: ChildProcess): void {
    try {
        child.kill("SIGKILL");
    } catch {
        // Already gone.
    }
}
