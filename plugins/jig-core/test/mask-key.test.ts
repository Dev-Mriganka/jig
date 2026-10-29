// The daily masking key: one per UTC day, private on disk, shared by processes, and gone after two days.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dailyMaskKey, MaskError } from "../src/mask/index.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;
const at = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

describe("daily mask key", () => {
    let root: string;
    let counter = 0;
    before(() => {
        root = mkdtempSync(join(tmpdir(), "jig-mask-key-"));
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    /** A state folder of its own for each test, so none depends on what another left behind. */
    const freshState = (): string => join(root, `state-${counter++}`);
    const keyFiles = (state: string): string[] => readdirSync(join(state, "mask")).sort();

    it("creates 32 random bytes, kept private, and gives the same key all day", () => {
        const state = freshState();
        const a = dailyMaskKey(state, at("2026-03-01"));
        const b = dailyMaskKey(state, new Date("2026-03-01T23:59:59Z"));
        assert.equal(a.length, 32);
        assert.deepEqual(a, b);
        const file = join(state, "mask", "2026-03-01.key");
        assert.deepEqual(new Uint8Array(readFileSync(file)), a);
        assert.equal(mode(file), 0o600);
        assert.equal(mode(join(state, "mask")), 0o700);
        assert.notDeepEqual(a, new Uint8Array(32), "not all zeros");
    });

    it("gives a different key on a different UTC day, and the day changes at UTC midnight", () => {
        const state = freshState();
        const lastSecond = dailyMaskKey(state, new Date("2026-04-01T23:59:59Z"));
        const midnight = dailyMaskKey(state, new Date("2026-04-02T00:00:00Z"));
        assert.notDeepEqual(lastSecond, midnight);
        assert.deepEqual(lastSecond, dailyMaskKey(state, new Date("2026-04-01T00:00:00Z")));
        assert.deepEqual(midnight, dailyMaskKey(state, new Date("2026-04-02T23:59:59.999Z")));
    });

    it("defaults to today", () => {
        const state = freshState();
        assert.deepEqual(dailyMaskKey(state), dailyMaskKey(state, new Date()));
        assert.deepEqual(keyFiles(state), [`${new Date().toISOString().slice(0, 10)}.key`]);
    });

    it("hands out a copy, so a caller changing it cannot change the key", () => {
        const state = freshState();
        const key = dailyMaskKey(state, at("2026-03-05"));
        const original = new Uint8Array(key);
        key.fill(0);
        assert.deepEqual(dailyMaskKey(state, at("2026-03-05")), original);
        dailyMaskKey(state, at("2026-03-05")).fill(1);
        assert.deepEqual(dailyMaskKey(state, at("2026-03-05")), original);
    });

    it("creates the state folder when it is missing, with private folders", () => {
        const state = join(freshState(), "deeper", "state");
        dailyMaskKey(state, at("2026-03-02"));
        assert.equal(mode(state), 0o700);
        assert.equal(mode(join(state, "mask")), 0o700);
    });

    it("makes a mask folder that was left open private again", () => {
        const state = freshState();
        mkdirSync(join(state, "mask"), { recursive: true, mode: 0o755 });
        dailyMaskKey(state, at("2026-03-03"));
        assert.equal(mode(join(state, "mask")), 0o700);
    });

    it("replaces a damaged key file, and keeps the replacement", () => {
        const state = freshState();
        dailyMaskKey(state, at("2026-05-01"));
        const file = join(state, "mask", "2026-05-01.key");
        writeFileSync(file, "short");
        const key = dailyMaskKey(state, at("2026-05-01"));
        assert.equal(key.length, 32);
        assert.deepEqual(new Uint8Array(readFileSync(file)), key);
        assert.deepEqual(dailyMaskKey(state, at("2026-05-01")), key);
        assert.deepEqual(keyFiles(state), ["2026-05-01.key"], "no temporary file is left behind");
    });

    it("lets processes that start the day together agree on one key", async () => {
        const state = freshState();
        const rounds = 25;
        // The window in which two processes can collide is microseconds, far less than their start-up jitter, so the
        // children wait for a shared moment, and race over a new folder in each round.
        const code = `
            import { dailyMaskKey } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/mask/key.ts", import.meta.url))).href)};
            const [state, firstTick, rounds] = process.argv.slice(1);
            const keys = [];
            for (let round = 0; round < Number(rounds); round++) {
                while (Date.now() < Number(firstTick) + round * 10) { /* spin until the shared moment */ }
                keys.push(Buffer.from(dailyMaskKey(state + "/round-" + round, new Date("2026-06-01T12:00:00Z"))).toString("hex"));
            }
            process.stdout.write(keys.join(" "));
        `;
        const firstTick = String(Date.now() + 1_500);
        const run = (): Promise<string[]> => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", code, state, firstTick, String(rounds)]);
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
            child.on("error", reject);
            child.on("close", (status) => (status === 0 ? resolve(out.split(" ")) : reject(new Error(`child exited with ${status}`))));
        });
        const children = await Promise.all(Array.from({ length: 6 }, run));
        for (let round = 0; round < rounds; round++) {
            const keys = children.map((keysOfChild) => keysOfChild[round]);
            assert.equal(keys[0]?.length, 64);
            assert.equal(new Set(keys).size, 1, `round ${round}: every process used the same key`);
            const folder = join(state, `round-${round}`);
            assert.equal(Buffer.from(dailyMaskKey(folder, at("2026-06-01"))).toString("hex"), keys[0]);
            assert.deepEqual(keyFiles(folder), ["2026-06-01.key"], "no temporary file is left behind");
        }
    });

    describe("old keys", () => {
        const writeKey = (state: string, name: string): void => {
            mkdirSync(join(state, "mask"), { recursive: true, mode: 0o700 });
            writeFileSync(join(state, "mask", name), new Uint8Array(32).fill(9), { mode: 0o600 });
        };

        it("are deleted once they are more than two days old, and nothing newer is", () => {
            const state = freshState();
            const days = ["2026-10-20", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-31"];
            for (const day of days) writeKey(state, `${day}.key`);
            dailyMaskKey(state, new Date("2026-10-30T12:00:00Z"));
            // 10-27 is three days back and goes; 10-28 is two days back and stays. 10-31 is ahead of this clock and stays.
            assert.deepEqual(keyFiles(state), ["2026-10-28.key", "2026-10-29.key", "2026-10-30.key", "2026-10-31.key"]);
        });

        it("are measured in UTC days, not in hours", () => {
            const state = freshState();
            writeKey(state, "2026-10-27.key");
            dailyMaskKey(state, new Date("2026-10-29T23:59:59Z"));
            assert.ok(existsSync(join(state, "mask", "2026-10-27.key")), "two days back until the day ends");
            dailyMaskKey(state, new Date("2026-10-30T00:00:00Z"));
            assert.ok(!existsSync(join(state, "mask", "2026-10-27.key")), "three days back from midnight");
        });

        it("take the temporary files of a crashed writer with them, because those hold key bytes too", () => {
            const state = freshState();
            writeKey(state, "2026-10-01.key.4242.deadbeef.tmp");
            writeKey(state, "2026-10-29.key.4242.deadbeef.tmp");
            dailyMaskKey(state, new Date("2026-10-30T12:00:00Z"));
            assert.deepEqual(keyFiles(state), ["2026-10-29.key.4242.deadbeef.tmp", "2026-10-30.key"]);
        });

        it("leave every other file in the folder alone", () => {
            const state = freshState();
            const others = ["notes.txt", "2026-10-01.keys", "key-2026-10-01.key", "2026-13-45.key", "2026-10-1.key", "README"];
            for (const name of others) writeKey(state, name);
            dailyMaskKey(state, new Date("2026-10-30T12:00:00Z"));
            assert.deepEqual(keyFiles(state), [...others, "2026-10-30.key"].sort());
        });
    });

    it("refuses an empty state folder, rather than writing a key into the working directory", () => {
        assert.throws(() => dailyMaskKey(""), MaskError);
        assert.ok(!existsSync(join(process.cwd(), "mask")), "nothing was created");
    });
});
