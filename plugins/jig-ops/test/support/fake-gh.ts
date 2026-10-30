// A fake `gh`: an executable script first on PATH that answers from fixtures and logs every call. Nothing here reaches
// GitHub. A fixture names the leading words of a call (`pr view`, `api`) and substrings that must appear among its
// other arguments or its standard input (`commits/abc/check-runs`, `resolveReviewThread`; a leading `=` means an
// argument that is exactly that), and gives one reply, or a list of replies that are used in turn (the last one
// repeats). For `gh api -i` the script prints a status line and headers like the real gh does, and a request whose
// `If-None-Match` header equals the fixture's `etag` gets the `304` answer the real gh gives: the headers, then `gh:
// HTTP 304` on standard error and exit code 1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GhReply {
    /** Exit code. Default 0. */
    code?: number;
    stdout?: string;
    stderr?: string;
    /** Standard output as JSON. */
    json?: unknown;
    /** `gh api -i` only: the HTTP status. Default 200. */
    status?: number;
    /** `gh api -i` only: the Etag header. A request with the same `If-None-Match` gets a 304. */
    etag?: string;
    /** `gh api -i` only: more response headers. */
    headers?: Record<string, string>;
    /** Wait this long before answering, so a caller's timeout can fire. */
    sleepMs?: number;
}

export interface GhCall {
    args: string[];
    /** What was written to standard input, when the call passed `-`. */
    stdin?: string;
}

export interface FakeGh {
    /** The folder that holds the `gh` script: what goes first on PATH. */
    bin: string;
    /** Every call so far, in order. */
    calls(): GhCall[];
    /** The calls whose leading words are `cmd`, such as "pr create". */
    callsOf(cmd: string): GhCall[];
    /** Sets the reply for calls whose leading words are `cmd`. Later fixtures win over earlier ones. */
    on(cmd: string, reply: GhReply | GhReply[], has?: string[]): void;
    /** Forgets all fixtures and calls. */
    reset(): void;
    remove(): void;
}

const SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
const stdin = args.includes("-") ? fs.readFileSync(0, "utf8") : undefined;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, stdin }) + "\\n");
const fixtures = JSON.parse(fs.readFileSync(path.join(dir, "fixtures.json"), "utf8"));
const found = fixtures.findIndex((f) => {
    const words = f.cmd.split(" ");
    if (!words.every((word, i) => args[i] === word)) return false;
    const rest = args.slice(words.length);
    const haystack = rest.join("\\n") + "\\n" + (stdin ?? "");
    return f.has.every((needle) => (needle.startsWith("=") ? rest.includes(needle.slice(1)) : haystack.includes(needle)));
});
if (found < 0) {
    process.stderr.write("fake gh: no reply for " + args.join(" ") + "\\n");
    process.exit(2);
}
const counter = path.join(dir, "used-" + fixtures[found].id);
const used = fs.existsSync(counter) ? fs.statSync(counter).size : 0;
fs.appendFileSync(counter, "x");
const replies = fixtures[found].replies;
const reply = replies[Math.min(used, replies.length - 1)];
const finish = () => {
    const include = args.includes("-i") || args.includes("--include");
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : reply.stdout ?? "";
    if (!include) {
        if (body) process.stdout.write(body);
        if (reply.stderr) process.stderr.write(reply.stderr);
        process.exit(reply.code ?? 0);
    }
    // A call that failed before any response (the network, the sign-in) prints no status line.
    if (reply.status === undefined && (reply.code ?? 0) !== 0) {
        if (reply.stdout) process.stdout.write(reply.stdout);
        process.stderr.write(reply.stderr ?? "");
        process.exit(reply.code);
    }
    const sent = args.filter((arg, i) => args[i - 1] === "-H" && /^if-none-match:/i.test(arg)).map((arg) => arg.replace(/^[^:]*:\\s*/, ""));
    if (reply.etag && sent.includes(reply.etag)) {
        process.stdout.write("HTTP/2.0 304 Not Modified\\nEtag: " + reply.etag + "\\n" + Object.entries(reply.headers ?? {}).map(([k, v]) => k + ": " + v + "\\n").join("") + "\\n");
        process.stderr.write("gh: HTTP 304\\n");
        process.exit(1);
    }
    const status = reply.status ?? 200;
    const headers = { "Content-Type": "application/json; charset=utf-8", ...(reply.etag ? { Etag: reply.etag } : {}), ...(reply.headers ?? {}) };
    process.stdout.write("HTTP/2.0 " + status + " " + (status < 300 ? "OK" : "Error") + "\\n" + Object.entries(headers).map(([k, v]) => k + ": " + v + "\\n").join("") + "\\n" + body);
    if (status >= 300) {
        process.stderr.write("gh: " + (reply.stderr ?? "Error") + " (HTTP " + status + ")\\n");
        process.exit(1);
    }
    process.exit(reply.code ?? 0);
};
if (reply.sleepMs) setTimeout(finish, reply.sleepMs);
else finish();
`;

interface Fixture {
    id: number;
    cmd: string;
    has: string[];
    replies: GhReply[];
}

/** A fake `gh` in a folder of its own. The fake jig-core puts that folder first on the PATH of the programs it starts. */
export function installFakeGh(): FakeGh {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-ops-gh-"));
    fs.writeFileSync(path.join(dir, "gh"), `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
    const fixtures = path.join(dir, "fixtures.json");
    const log = path.join(dir, "calls.jsonl");
    const read = (): Fixture[] => JSON.parse(fs.readFileSync(fixtures, "utf8")) as Fixture[];
    const reset = () => {
        fs.writeFileSync(fixtures, "[]");
        fs.rmSync(log, { force: true });
        for (const name of fs.readdirSync(dir)) if (name.startsWith("used-")) fs.rmSync(path.join(dir, name));
    };
    reset();
    const calls = (): GhCall[] =>
        fs.existsSync(log)
            ? fs
                  .readFileSync(log, "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as GhCall)
            : [];
    return {
        bin: dir,
        calls,
        callsOf: (cmd) => {
            const words = cmd.split(" ");
            return calls().filter((call) => words.every((word, index) => call.args[index] === word));
        },
        on(cmd, reply, has = []) {
            const all = read();
            const id = all.reduce((highest, fixture) => Math.max(highest, fixture.id), 0) + 1;
            fs.writeFileSync(
                fixtures,
                JSON.stringify([{ id, cmd, has, replies: Array.isArray(reply) ? reply : [reply] }, ...all]),
            );
        },
        reset,
        remove: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}
