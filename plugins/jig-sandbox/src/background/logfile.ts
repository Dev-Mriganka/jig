// A task's output on disk: a rotating writer with offsets that stay valid after old output is dropped. The layout (a private
// folder per session, files made with `wx` and mode 0600, two segments) and the way a read spans them are adapted from
// gvanderclay/pi-bg-bash (MIT, see docs/background.md, "Credit").
import { closeSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

interface Segment {
    path: string;
    /** Where the segment's first byte is in the whole stream. */
    start: number;
    /** Bytes of the stream in the segment (a header line in front of them is not counted). */
    bytes: number;
    /** Bytes of header in front of the stream's bytes. */
    skip: number;
}

export interface LogHooks {
    /** Tests only: replaces the file write, to simulate a full disk. */
    write?(fd: number, data: Buffer): void;
}

function writeAll(fd: number, data: Buffer): void {
    let done = 0;
    while (done < data.length) done += writeSync(fd, data, done, data.length - done);
}

/**
 * One task's output, kept in at most two files: `bg-N.log` (the current one) and `bg-N.log.1` (the one before). Offsets count
 * from the first byte the task wrote, so they stay valid after rotation drops the oldest output.
 */
export class TaskLog {
    /** Bytes written in all. */
    size = 0;
    lastWriteAt = 0;
    /** Set when a write failed: logging stops and the task keeps running. */
    error: string | undefined;
    private readonly dir: string;
    private readonly name: string;
    private readonly segmentBytes: number;
    private readonly hooks: LogHooks;
    private current: Segment;
    private previous: Segment | undefined;
    private fd: number | undefined;

    /** Throws `EEXIST` when the log already exists, and the caller picks another id. */
    constructor(dir: string, id: string, segmentBytes: number, hooks: LogHooks = {}) {
        this.dir = dir;
        this.name = id;
        this.segmentBytes = segmentBytes;
        this.hooks = hooks;
        this.current = { path: path.join(dir, `${id}.log`), start: 0, bytes: 0, skip: 0 };
        this.fd = openSync(this.current.path, "wx", 0o600);
    }

    /** The oldest offset still on disk. */
    get oldest(): number {
        return this.previous ? this.previous.start : this.current.start;
    }

    append(data: Buffer, now = Date.now()): void {
        this.lastWriteAt = now;
        let rest = data;
        while (rest.length > 0 && !this.error) {
            if (this.current.bytes >= this.segmentBytes) this.rotate();
            if (this.error) return;
            const take = rest.subarray(0, this.segmentBytes - this.current.bytes);
            try {
                if (this.fd === undefined) throw new Error("log closed");
                (this.hooks.write ?? writeAll)(this.fd, take);
            } catch (error) {
                this.error = (error as Error).message;
                return;
            }
            this.current.bytes += take.length;
            this.size += take.length;
            rest = rest.subarray(take.length);
        }
    }

    /** Bytes from `start` to `end` of the stream, cut to what is still on disk. */
    read(start: number, end: number): Buffer {
        const from = Math.max(start, this.oldest);
        const to = Math.min(end, this.size);
        if (to <= from) return Buffer.alloc(0);
        const parts: Buffer[] = [];
        for (const segment of [this.previous, this.current]) {
            if (!segment) continue;
            const a = Math.max(from, segment.start);
            const b = Math.min(to, segment.start + segment.bytes);
            if (b > a) parts.push(readRange(segment.path, segment.skip + (a - segment.start), b - a));
        }
        return Buffer.concat(parts);
    }

    close(): void {
        if (this.fd !== undefined) {
            try {
                closeSync(this.fd);
            } catch {
                // Already closed.
            }
            this.fd = undefined;
        }
    }

    remove(): void {
        this.close();
        for (const file of [this.current.path, this.previous?.path]) {
            if (file === undefined) continue;
            try {
                unlinkSync(file);
            } catch {
                // Gone already.
            }
        }
    }

    private rotate(): void {
        try {
            this.close();
            const older = `${this.current.path}.1`;
            renameSync(this.current.path, older);
            this.previous = { ...this.current, path: older };
            const start = this.previous.start + this.previous.bytes;
            this.current = { path: path.join(this.dir, `${this.name}.log`), start, bytes: 0, skip: 0 };
            this.fd = openSync(this.current.path, "wx", 0o600);
            // For anyone who opens the file; it is not counted in the offsets.
            if (this.previous.start > 0) {
                const header = Buffer.from(`[output rotated: bytes 0-${this.previous.start} dropped]\n`);
                writeAll(this.fd, header);
                this.current.skip = header.length;
            }
        } catch (error) {
            this.error = (error as Error).message;
        }
    }
}

function readRange(file: string, position: number, length: number): Buffer {
    const fd = openSync(file, "r");
    try {
        const buffer = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
            const count = readSync(fd, buffer, done, length - done, position + done);
            if (count === 0) break;
            done += count;
        }
        return buffer.subarray(0, done);
    } finally {
        closeSync(fd);
    }
}

/** Counts the line feeds from `start` to `end`, reading a megabyte at a time. */
export function countLines(log: TaskLog, start: number, end: number): number {
    let count = 0;
    for (let at = Math.max(start, log.oldest); at < end; at += 1 << 20) {
        for (const byte of log.read(at, Math.min(end, at + (1 << 20)))) if (byte === 0x0a) count++;
    }
    return count;
}
