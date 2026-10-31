// The `/ps` log view, the one part of `/ps` that is a screen of its own: it shows a task's output, follows the end, scrolls, and
// never moves the agent's read position.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TaskLog } from "../src/background/logfile.ts";
import { logView } from "../src/background/ps.ts";
import type { Task } from "../src/background/types.ts";

let folder: string;
beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "jig-bg-ps-"));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const styles = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

let counter = 0;
function view(lines: number, rows = 12, extra = "") {
    const log = new TaskLog(folder, `bg-${++counter}`, 1_000_000);
    log.append(
        Buffer.from(
            `${Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n")}${lines > 0 ? "\n" : ""}${extra}`,
        ),
    );
    const task: Task = {
        id: "bg-1",
        name: "demo",
        command: "npm run dev",
        cwd: "/work",
        pid: 1,
        startedAt: 0,
        state: "exited",
        exitCode: 0,
        endedAt: 1_000,
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
    };
    let renders = 0;
    let closed = 0;
    const component = logView(
        task,
        { requestRender: () => void renders++, terminal: { rows } } as never,
        styles,
        () => void closed++,
    );
    return { component, task, closed: () => closed, renders: () => renders, log };
}

describe("the log view", () => {
    test("shows the task's line, then the end of its output, and where in it you are", () => {
        const { component, log } = view(100);
        const lines = component.render(80);
        assert.match(lines[1] ?? "", /^bg-\d+ \| exited \(code 0\) \| 1\.0s \| demo \| npm run dev/);
        assert.ok(
            lines.some((line) => line === "line 100"),
            "it follows the end",
        );
        assert.match(lines.at(-2) ?? "", /lines \d+-100 of 100/);
        log.close();
    });

    test("scrolls with the arrow keys, and Home and End", () => {
        const { component, log } = view(100);
        component.render(80);
        component.handleInput?.("\u001b[H");
        assert.ok(
            component.render(80).some((line) => line === "line 1"),
            "Home goes to the start",
        );
        component.handleInput?.("\u001b[B");
        assert.equal(
            component.render(80).some((line) => line === "line 1"),
            false,
            "down moves a line",
        );
        component.handleInput?.("\u001b[F");
        assert.ok(
            component.render(80).some((line) => line === "line 100"),
            "End goes back to the end",
        );
        log.close();
    });

    test("a long line is wrapped to the width", () => {
        const { component, log } = view(0, 12, `${"word ".repeat(60)}\n`);
        const lines = component.render(40);
        assert.ok(lines.filter((line) => line.includes("word")).length >= 5);
        log.close();
    });

    test("escape, enter and q close it, and it does not move what the agent has read", () => {
        for (const key of ["\u001b", "\r", "q"]) {
            const { component, task, closed, log } = view(5);
            component.render(80);
            component.handleInput?.(key);
            assert.equal(closed(), 1, JSON.stringify(key));
            assert.equal(task.cursor, 0);
            log.close();
        }
    });

    test("a task with no output says so", () => {
        const { component, task, log } = view(0);
        delete task.log;
        assert.ok(component.render(80).some((line) => line === "(no output)"));
        log.close();
    });
});
