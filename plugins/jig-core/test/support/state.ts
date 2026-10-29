// A temporary state folder that `JIG_STATE_DIR` points at, so a test never touches the real one.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempState {
    start(): string;
    stop(): void;
    readonly dir: string;
}

export function tempState(): TempState {
    let dir = "";
    const saved = process.env.JIG_STATE_DIR;
    return {
        start() {
            dir = mkdtempSync(path.join(tmpdir(), "jig-state-"));
            process.env.JIG_STATE_DIR = dir;
            return dir;
        },
        stop() {
            if (saved === undefined) delete process.env.JIG_STATE_DIR;
            else process.env.JIG_STATE_DIR = saved;
            rmSync(dir, { recursive: true, force: true });
        },
        get dir() {
            return dir;
        },
    };
}

/** Every record line in the state folder, parsed, oldest file first. */
export function readRecords(stateDir: string): Array<Record<string, unknown>> {
    const folder = path.join(stateDir, "records");
    let names: string[];
    try {
        names = readdirSync(folder).sort();
    } catch {
        return [];
    }
    return names.flatMap((name) => readFileSync(path.join(folder, name), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>));
}

/** The raw text of every record file, for tests that look for text that must not be there. */
export function rawRecords(stateDir: string): string {
    const folder = path.join(stateDir, "records");
    try {
        return readdirSync(folder).map((name) => readFileSync(path.join(folder, name), "utf8")).join("\n");
    } catch {
        return "";
    }
}
