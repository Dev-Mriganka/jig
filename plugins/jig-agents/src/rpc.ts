// The RPC client: reads a child Pi's output as strict JSON lines (split on LF only, as Pi's docs say), sends commands and matches their
// responses by id, and hands everything else to the owner. It never trusts what it reads: a line that is too long or is not a record
// is dropped and counted, and a child that sends too many of them is given up on.
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { Timers } from "./host.ts";

export type Wire = { type: string; [key: string]: unknown };

export interface RpcHandlers {
    /** A session event (anything that is not a response or an extension UI request). */
    event(event: Wire): void;
    /** An `extension_ui_request`. */
    ui(request: Wire): void;
    /** The output cannot be read any more: too many bad lines. Called once. */
    unreadable(reason: string): void;
    /** The output ended. */
    closed(): void;
}

export interface RpcOptions {
    /** The longest line kept, in characters. Longer lines are dropped. Default 8 MiB. */
    maxLineChars?: number;
    /** Bad lines tolerated before the output counts as unreadable. Default 20. */
    maxBadLines?: number;
    /** How long a command may wait for its response. Default 30 s. */
    requestTimeoutMs?: number;
    timers: Timers;
}

interface Pending {
    resolve(data: unknown): void;
    reject(error: Error): void;
    timer: unknown;
    command: string;
}

export const MAX_LINE_CHARS = 8 * 1024 * 1024;
export const MAX_BAD_LINES = 20;
export const REQUEST_TIMEOUT_MS = 30_000;

export class RpcChannel {
    private readonly decoder = new StringDecoder("utf8");
    private buffer = "";
    private discarding = false;
    private bad = 0;
    private gaveUp = false;
    private ended = false;
    private counter = 0;
    private readonly pending = new Map<string, Pending>();
    private readonly maxLine: number;
    private readonly maxBad: number;
    private readonly timeoutMs: number;
    private readonly timers: Timers;

    private readonly stdout: Readable;
    private readonly stdin: Writable;
    private readonly handlers: RpcHandlers;

    constructor(stdout: Readable, stdin: Writable, handlers: RpcHandlers, options: RpcOptions) {
        this.stdout = stdout;
        this.stdin = stdin;
        this.handlers = handlers;
        this.maxLine = options.maxLineChars ?? MAX_LINE_CHARS;
        this.maxBad = options.maxBadLines ?? MAX_BAD_LINES;
        this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        this.timers = options.timers;
        stdout.on("data", this.onData);
        stdout.on("end", this.onEnd);
        stdout.on("error", this.onEnd);
        stdin.on("error", this.onStdinError);
    }

    /** Bad lines seen so far. */
    get badLines(): number {
        return this.bad;
    }

    /** True while commands can still be written. */
    get writable(): boolean {
        return !this.ended && !this.stdin.destroyed && !this.stdin.writableEnded;
    }

    /** Sends a command and waits for its response by id. Rejects on a failure response, a timeout or when the output closes. */
    request(command: { type: string; [key: string]: unknown }, timeoutMs: number = this.timeoutMs): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.writable) {
                reject(new Error(`cannot send ${command.type}: the child is not listening`));
                return;
            }
            const id = `jig-${++this.counter}`;
            const timer = this.timers.setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${command.type} was not answered within ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, command: command.type });
            if (!this.write({ ...command, id })) {
                this.settle(id)?.reject(new Error(`cannot send ${command.type}: the child is not listening`));
            }
        });
    }

    /** Sends a record that has no response, such as an `extension_ui_response`. False when it could not be written. */
    send(record: { type: string; [key: string]: unknown }): boolean {
        return this.write(record);
    }

    /** Ends the child's input, which asks Pi to shut down in an orderly way. */
    endInput(): void {
        try {
            if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
        } catch {
            // The pipe is gone already.
        }
    }

    /** Stops reading and fails every command that is waiting. */
    close(reason = "the child's output closed"): void {
        this.stdout.off("data", this.onData);
        this.stdout.off("end", this.onEnd);
        this.stdout.off("error", this.onEnd);
        this.failAll(reason);
        this.ended = true;
    }

    private write(record: unknown): boolean {
        if (!this.writable) return false;
        try {
            this.stdin.write(`${JSON.stringify(record)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    private settle(id: string): Pending | undefined {
        const entry = this.pending.get(id);
        if (entry === undefined) return undefined;
        this.pending.delete(id);
        this.timers.clearTimeout(entry.timer);
        return entry;
    }

    private failAll(reason: string): void {
        for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new Error(reason));
    }

    private readonly onStdinError = (): void => {
        // A write to a child that has gone: the exit handler reports it. Nothing to do here.
    };

    private readonly onEnd = (): void => {
        if (this.ended) return;
        this.buffer += this.decoder.end();
        if (this.buffer.length > 0 && !this.discarding && !this.gaveUp) this.line(this.buffer);
        this.buffer = "";
        this.ended = true;
        this.failAll("the child's output closed");
        this.handlers.closed();
    };

    private readonly onData = (chunk: Buffer | string): void => {
        if (this.gaveUp) return;
        let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        while (text.length > 0 && !this.gaveUp) {
            const lf = text.indexOf("\n");
            if (lf < 0) {
                if (!this.discarding) {
                    this.buffer += text;
                    if (this.buffer.length > this.maxLine) {
                        this.buffer = "";
                        this.discarding = true;
                        this.reject("a line longer than the limit");
                    }
                }
                return;
            }
            const head = text.slice(0, lf);
            text = text.slice(lf + 1);
            if (this.discarding) {
                this.discarding = false;
                continue;
            }
            const whole = this.buffer + head;
            this.buffer = "";
            if (whole.length > this.maxLine) this.reject("a line longer than the limit");
            else this.line(whole.endsWith("\r") ? whole.slice(0, -1) : whole);
        }
    };

    private reject(why: string): void {
        this.bad++;
        if (this.bad > this.maxBad && !this.gaveUp) {
            this.gaveUp = true;
            this.failAll("the child's output could not be read");
            this.handlers.unreadable(`more than ${this.maxBad} unreadable lines (${why})`);
        }
    }

    private line(text: string): void {
        if (text.trim() === "") return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.reject("not JSON");
            return;
        }
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
            this.reject("not a record");
            return;
        }
        const record = parsed as Wire;
        try {
            if (record.type === "response") {
                const id = record.id;
                const entry = typeof id === "string" ? this.settle(id) : undefined;
                if (entry === undefined) return;
                if (record.success === true) entry.resolve(record.data);
                else
                    entry.reject(
                        new Error(
                            `${entry.command} failed: ${String(record.error ?? "no reason given").slice(0, 200)}`,
                        ),
                    );
            } else if (record.type === "extension_ui_request") {
                this.handlers.ui(record);
            } else {
                this.handlers.event(record);
            }
        } catch {
            // A handler's bug must not stop the reader; the owner's own checks report what matters.
        }
    }
}
