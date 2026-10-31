// Fake command-line programs for the tests to put first on PATH, so that nothing real is ever run: a fake `ssh` that listens on the
// port it was asked to forward, and a fake `acme` that prints a token. Each is a small script in a folder of its own. The folder
// is outside the working folder, as jig-core's `exec.run` requires of a program it will start.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeSshCall {
    args: string[];
    /** The names of the variables the program was started with, never their values. */
    env: string[];
    agent: string | undefined;
    pid: number;
}

export type SshMode = "ok" | "denied" | "hostkey" | "unreachable" | "hang";

export interface FakePrograms {
    /** The folder to put first on PATH. */
    bin: string;
    /** Chooses what the fake ssh does next. */
    ssh(mode: SshMode): void;
    /** What the fake ssh was started with, in order. */
    sshCalls(): FakeSshCall[];
    close(): void;
}

// A script, so that it needs no compiling: it runs under the same Node as the tests.
const SSH = `#!${process.execPath}
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const dir = __dirname;
const mode = fs.readFileSync(path.join(dir, "ssh-mode"), "utf8").trim();
fs.appendFileSync(
    path.join(dir, "ssh-calls.jsonl"),
    JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env), agent: process.env.SSH_AUTH_SOCK, pid: process.pid }) + "\\n",
);
const fail = (text) => {
    console.error(text);
    process.exit(255);
};
if (mode === "denied") fail("jdoe@bastion.acme.example: Permission denied (publickey).");
if (mode === "hostkey") fail("Host key verification failed.");
if (mode === "unreachable") fail("ssh: Could not resolve hostname bastion.acme.example: Name or service not known");
if (mode === "hang") {
    setInterval(() => {}, 1000);
} else {
    // -L 127.0.0.1:<local>:<host>:<port>
    const spec = process.argv[process.argv.indexOf("-L") + 1].split(":");
    net.createServer((socket) => socket.end("fake-db " + spec[2] + ":" + spec[3] + "\\n")).listen(Number(spec[1]), "127.0.0.1");
}
`;

const ACME = `#!/bin/sh
echo "acme-cli-token-value-0123456789"
`;

export function fakePrograms(): FakePrograms {
    const bin = mkdtempSync(path.join(tmpdir(), "jig-acme-bin-"));
    mkdirSync(bin, { recursive: true });
    for (const [name, source] of [
        ["ssh", SSH],
        ["acme", ACME],
    ] as const) {
        writeFileSync(path.join(bin, name), source);
        chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(path.join(bin, "ssh-mode"), "ok");
    writeFileSync(path.join(bin, "ssh-calls.jsonl"), "");
    return {
        bin,
        ssh: (mode) => writeFileSync(path.join(bin, "ssh-mode"), mode),
        sshCalls: () =>
            readFileSync(path.join(bin, "ssh-calls.jsonl"), "utf8")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as FakeSshCall),
        close: () => rmSync(bin, { recursive: true, force: true }),
    };
}
