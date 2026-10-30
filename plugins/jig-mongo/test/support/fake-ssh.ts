// A fake `ssh` in a temporary folder: a program that behaves as ssh does for a local forward. It records its argument list and what
// it found in the key file when it started, then (as `ssh -N -L` does) listens on the local port of the forward until it is killed.
// A `mode` file in its folder makes it fail as ssh fails.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type SshMode = "ok" | "denied" | "hostkey" | "unreachable" | "badkey" | "silent";

export interface RunRecord {
    argv: string[];
    key: { mode: string; dirMode: string; content: string } | null;
}

export interface FakeSsh {
    /** The folder to put first on PATH. */
    bin: string;
    mode(mode: SshMode): void;
    /** The runs so far. */
    runs(): RunRecord[];
    remove(): void;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const argv = process.argv.slice(2);
let key = null;
try {
    const file = argv[argv.indexOf("-i") + 1];
    key = {
        mode: (fs.statSync(file).mode & 0o777).toString(8),
        dirMode: (fs.statSync(path.dirname(file)).mode & 0o777).toString(8),
        content: fs.readFileSync(file, "utf8"),
    };
} catch {}
fs.appendFileSync(path.join(__dirname, "runs.jsonl"), JSON.stringify({ argv, key }) + "\\n");
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim();
const fail = (text, code) => { process.stderr.write(text + "\\n"); process.exit(code); };
if (mode === "denied") fail("agent@bastion.example.com: Permission denied (publickey).", 255);
if (mode === "hostkey") fail("Host key verification failed.", 255);
if (mode === "unreachable") fail("ssh: connect to host bastion.example.com port 22: Connection timed out", 255);
if (mode === "badkey") fail('Load key "/tmp/x": invalid format', 255);
if (mode === "silent") { setInterval(() => {}, 1000); }
else {
    const port = Number(argv[argv.indexOf("-L") + 1].split(":")[1]);
    net.createServer((socket) => socket.end()).listen(port, "127.0.0.1");
}
process.on("SIGTERM", () => process.exit(0));
`;

export function fakeSsh(): FakeSsh {
    const bin = mkdtempSync(path.join(tmpdir(), "jig-mongo-bin-"));
    const program = path.join(bin, "ssh");
    writeFileSync(program, SCRIPT);
    chmodSync(program, 0o755);
    writeFileSync(path.join(bin, "mode"), "ok");
    writeFileSync(path.join(bin, "runs.jsonl"), "");
    return {
        bin,
        mode: (mode) => writeFileSync(path.join(bin, "mode"), mode),
        runs: () =>
            readFileSync(path.join(bin, "runs.jsonl"), "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as RunRecord),
        remove: () => rmSync(bin, { recursive: true, force: true }),
    };
}
