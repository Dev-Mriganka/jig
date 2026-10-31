// A task's log and what the agent reads of it: rotation with offsets that stay valid, paging, the last lines, a filter, and
// what a read does to the unread position.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TaskLog } from "../src/background/logfile.ts";
import { readOutput, tailText } from "../src/background/output.ts";
import type { Task } from "../src/background/types.ts";

let folder: string;
beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "jig-bg-log-"));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function taskWith(log: TaskLog, over: Partial<Task> = {}): Task {
    return {
        id: "bg-1",
        name: "dev server",
        command: "npm run dev",
        cwd: "/work",
        pid: 1,
        startedAt: 0,
        state: "exited",
        exitCode: 0,
        endedAt: 3_000,
        deadline: 0,
        timeoutMs: 0,
        notifyOn: { ready: [], error: [] },
        cursor: 0,
        ready: false,
        errorMatches: 0,
        streamBytes: log.size,
        log,
        sandboxLines: [],
        ports: [],
        notes: [],
        settled: Promise.resolve(),
        markSettled: () => undefined,
        ...over,
    };
}

const lines = (from: number, to: number): string =>
    Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`).join("\n");

describe("the log on disk", () => {
    test("is a private file, written once and read back by offsets", () => {
        const log = new TaskLog(folder, "bg-1", 1_000);
        log.append(Buffer.from("hello\nworld\n"));
        assert.equal(log.size, 12);
        assert.equal(log.read(0, 5).toString(), "hello");
        assert.equal(log.read(6, 100).toString(), "world\n");
        assert.equal(statSync(path.join(folder, "bg-1.log")).mode & 0o777, 0o600);
        assert.throws(
            () => new TaskLog(folder, "bg-1", 1_000),
            { code: "EEXIST" },
            "an existing log is never written over",
        );
        log.close();
    });

    test("rotates at the segment size, keeps two files, and offsets stay valid", () => {
        // A row is 8 bytes, so a segment of 96 bytes holds 12 whole rows.
        const log = new TaskLog(folder, "bg-1", 96);
        for (let index = 0; index < 30; index++) log.append(Buffer.from(`row ${String(index).padStart(3, "0")}\n`));
        assert.equal(log.size, 240);
        assert.deepEqual(readdirSync(folder).sort(), ["bg-1.log", "bg-1.log.1"]);
        assert.equal(log.oldest, 96, "the oldest segment was dropped");
        assert.equal(log.read(0, 240).toString().split("\n")[0], "row 012", "reads are cut to what is still there");
        assert.equal(log.read(232, 240).toString(), "row 029\n", "an offset keeps meaning the same byte");
        assert.match(readFileSync(path.join(folder, "bg-1.log"), "utf8"), /^\[output rotated: bytes 0-96 dropped\]/);
        log.close();
    });

    test("a write that fails stops the log and leaves the task alone", () => {
        let calls = 0;
        const log = new TaskLog(folder, "bg-1", 1_000, {
            write: () => {
                if (++calls > 1) throw new Error("no space left on device");
            },
        });
        log.append(Buffer.from("fits"));
        log.append(Buffer.from("does not"));
        assert.equal(log.error, "no space left on device");
        assert.equal(log.size, 4);
        log.remove();
        assert.deepEqual(readdirSync(folder), []);
    });
});

describe("reading output", () => {
    test("by default the lines not read yet, and the next read starts after them", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from(`${lines(1, 3)}\n`));
        const task = taskWith(log);
        const first = readOutput(task, {}, 5_000);
        assert.match(first.text, /^bg-1 "dev server": exited \(code 0\), 3\.0s, 21 B logged/);
        assert.match(first.text, /line 1\nline 2\nline 3/);
        assert.deepEqual(first.range, { start: 0, end: 21 });
        log.append(Buffer.from("line 4\n"));
        const second = readOutput(task, {}, 5_000);
        assert.match(second.text, /\nline 4$/);
        assert.doesNotMatch(second.text, /line 3/);
        assert.match(readOutput(task, {}, 5_000).text, /\(no new output\)/);
        log.close();
    });

    test("tail gives the last lines and counts the unread lines it skipped", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from(`${lines(1, 20)}\n`));
        const task = taskWith(log);
        const result = readOutput(task, { tail: 3 }, 5_000);
        assert.match(result.text, /line 18\nline 19\nline 20/);
        assert.doesNotMatch(result.text, /line 17/);
        assert.match(result.text, /17 unread lines skipped/);
        assert.match(readOutput(task, {}, 5_000).text, /\(no new output\)/, "tail moved the position to the end");
        log.close();
    });

    test("offset reads forward from a byte, and does not move the position", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from(`${lines(1, 5)}\n`));
        const task = taskWith(log);
        const result = readOutput(task, { offset: 14 }, 5_000);
        assert.match(result.text, /line 3\nline 4\nline 5/);
        assert.equal(task.cursor, 0);
        assert.throws(() => readOutput(task, { offset: 999 }, 5_000), /past the end of the log/);
        log.close();
    });

    test("a filter keeps the lines that contain the text, ignoring case, and says how many", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from("starting\nERROR one\nok\nerror two\n"));
        const result = readOutput(taskWith(log), { filter: "Error" }, 5_000);
        assert.match(result.text, /ERROR one\nerror two/);
        assert.doesNotMatch(result.text, /starting/);
        assert.match(result.text, /\[filter: 2 of 4 lines matched\]/);
        assert.match(readOutput(taskWith(log), { filter: "nothing like it" }, 5_000).text, /\(no lines matched\)/);
        log.close();
    });

    test("output that rotation dropped is said so, with the oldest offset", () => {
        const log = new TaskLog(folder, "bg-1", 50);
        for (let index = 0; index < 40; index++) log.append(Buffer.from(`row ${String(index).padStart(3, "0")}\n`));
        const task = taskWith(log);
        const result = readOutput(task, {}, 5_000);
        assert.match(
            result.text,
            new RegExp(`earlier output dropped by log rotation, oldest available offset ${log.oldest}`),
        );
        log.close();
    });

    test("a page is capped, with the offset to go on from", () => {
        const log = new TaskLog(folder, "bg-1", 10_000_000);
        log.append(Buffer.from(`${lines(1, 5_000)}\n`));
        const task = taskWith(log);
        const first = readOutput(task, {}, 5_000);
        const shown = first.text.split("\n").filter((line) => /^line \d+$/.test(line));
        assert.ok(shown.length <= 2_000);
        assert.match(first.text, /\[next offset \d+\]/);
        const second = readOutput(task, {}, 5_000);
        assert.match(second.text, new RegExp(`line ${shown.length + 1}\\n`));
        log.close();
    });

    test("a half-written last line of a running task is held back until it ends or the output is quiet", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from("done line\nhalf wri"), 10_000);
        const task = taskWith(log, { state: "running", exitCode: undefined, endedAt: undefined });
        const early = readOutput(task, {}, 10_100);
        assert.match(early.text, /done line/);
        assert.doesNotMatch(early.text, /half wri/);
        const later = readOutput(task, {}, 12_000);
        assert.match(later.text, /half wri/);
        log.close();
    });

    test("tailText is what a message and the /ps view show: the last lines, capped, and it moves nothing", () => {
        const log = new TaskLog(folder, "bg-1", 1_000_000);
        log.append(Buffer.from(`${lines(1, 50)}\n`));
        const task = taskWith(log);
        const tail = tailText(task, 3, 4_096, 5_000);
        assert.equal(tail.text, "line 48\nline 49\nline 50");
        assert.equal(tail.cut, true);
        assert.equal(task.cursor, 0);
        const small = tailText(task, 100, 20, 5_000);
        assert.ok(Buffer.byteLength(small.text) <= 20);
        assert.equal(tailText(taskWith(new TaskLog(folder, "bg-2", 100)), 5, 100, 0).text, "");
        log.close();
    });

    test("a task with no log reads as no output", () => {
        const task = taskWith(new TaskLog(folder, "bg-3", 100));
        mkdirSync(path.join(folder, "x"));
        const withoutLog = { ...task };
        delete withoutLog.log;
        assert.match(readOutput(withoutLog, {}, 0).text, /\(no output\)/);
    });
});
