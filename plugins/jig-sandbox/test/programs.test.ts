// The programs the host runs for the sandbox (bubblewrap, socat, ripgrep, python3) are found on PATH only where a command
// in the sandbox cannot write: one in a folder it can write could have been planted there, and would run outside it.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { findPrograms, onPath } from "../src/programs.ts";

let root = "";
beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "jig-sandbox-programs-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function program(folder: string, name: string): string {
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
}

test("a program in a folder the sandbox can write is passed over for the next one on PATH", () => {
    const planted = path.join(root, "project", "bin");
    const system = path.join(root, "usr", "bin");
    program(planted, "socat");
    const real = program(system, "socat");
    const writable = (place: string) => place.startsWith(path.join(root, "project"));
    assert.equal(onPath("socat", `${planted}:${system}`, writable), real);
});

test("a link from a trusted folder into a writable one is passed over too", () => {
    const planted = program(path.join(root, "project", "bin"), "python3");
    const trusted = path.join(root, "usr", "bin");
    mkdirSync(trusted, { recursive: true });
    symlinkSync(planted, path.join(trusted, "python3"));
    const writable = (place: string) => place.startsWith(path.join(root, "project"));
    assert.equal(onPath("python3", trusted, writable), undefined);
});

test("with only planted copies, the program counts as not installed and the sandbox does not start", () => {
    const planted = path.join(root, "project", "bin");
    for (const name of ["bwrap", "socat", "rg"]) program(planted, name);
    const found = findPrograms("linux", {}, planted, (place) => place.startsWith(path.join(root, "project")));
    assert.deepEqual(
        found.missing.map((item) => item.name),
        ["bwrap", "socat", "ripgrep"],
    );
});

test("without a writable check, the first program on PATH is found, as before", () => {
    const first = program(path.join(root, "a"), "rg");
    program(path.join(root, "b"), "rg");
    assert.equal(onPath("rg", `${path.join(root, "a")}:${path.join(root, "b")}`), first);
});
