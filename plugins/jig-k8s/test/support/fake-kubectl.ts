// A fake `kubectl`: a script in a temporary folder that answers from fixtures and records every call it gets. No test
// touches a real cluster, and nothing here reads a kubeconfig.
//
// The script is the same one for every test. What it answers is written to `world.json` by `answer()`; each call it gets is
// appended to `calls.jsonl` with its argument list, what arrived on standard input, and the one environment variable
// kubectl is given (the kubeconfig).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** What the fake kubectl does for one call. */
export interface Reply {
    /** What it prints. An object or an array is printed as JSON. */
    stdout?: string | object;
    stderr?: string;
    /** The exit code. Default 0. */
    code?: number;
    /** Prints what it received on standard input before `stdout`. */
    echoStdin?: boolean;
    /** Prints this many bytes of `x` after `stdout`, for an answer too big to write out. */
    extraBytes?: number;
    /** Waits this long before answering. */
    delayMs?: number;
}

/** One reply, or a list: the first call gets the first reply, the second the second, and the last one repeats. */
export type Answers = Reply | readonly Reply[];

/** What the cluster answers, by the kind of call. */
export interface World {
    /** `kubectl get pods ...` */
    pods?: Answers;
    /** `kubectl get deployments,statefulsets ...` */
    workloads?: Answers;
    /** `kubectl logs ...` */
    logs?: Answers;
    /** `kubectl exec ...` */
    exec?: Answers;
}

export interface Call {
    argv: string[];
    stdin: string;
    /** The KUBECONFIG kubectl was started with, if any. */
    kubeconfig: string | undefined;
}

export interface FakeKubectl {
    /** The folder that holds the `kubectl` script: what goes first on PATH. */
    bin: string;
    /** Replaces what the cluster answers, and starts every list of replies again from its first reply. */
    answer(world: World): void;
    /** The calls kubectl got so far, in order. */
    calls(): Call[];
    /** The environment a program started on PATH needs for the script to find its files. */
    env: Readonly<Record<string, string>>;
    remove(): void;
}

// The script runs under the node that runs the tests, found by its path, so the test PATH does not matter.
const SCRIPT = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_KUBECTL_DIR;
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, stdin, kubeconfig: process.env.KUBECONFIG }) + "\\n");
    const verb = argv.find((arg) => !arg.startsWith("-"));
    const resource = verb === "get" ? argv[argv.indexOf("get") + 1] : undefined;
    const key = verb === "get" ? (resource === "pods" ? "pods" : "workloads") : verb;
    const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
    const countFile = path.join(dir, "counts.json");
    const counts = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, "utf8")) : {};
    const answers = world[key];
    if (answers === undefined || !["pods", "workloads", "logs", "exec"].includes(key)) {
        process.stderr.write("fake kubectl has no answer for: " + argv.join(" ") + "\\n");
        process.exitCode = 64;
        return;
    }
    const list = Array.isArray(answers) ? answers : [answers];
    const reply = list[Math.min(counts[key] || 0, list.length - 1)];
    counts[key] = (counts[key] || 0) + 1;
    fs.writeFileSync(countFile, JSON.stringify(counts));
    const respond = () => {
        const out = reply.stdout === undefined ? "" : typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout);
        process.stdout.write((reply.echoStdin ? stdin : "") + out + (reply.extraBytes ? "x".repeat(reply.extraBytes) : ""));
        process.stderr.write(reply.stderr || "");
        process.exitCode = reply.code || 0;
    };
    if (reply.delayMs) setTimeout(respond, reply.delayMs);
    else respond();
});
`;

export function installFakeKubectl(): FakeKubectl {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-k8s-fake-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "kubectl"), SCRIPT);
    chmodSync(path.join(bin, "kubectl"), 0o755);
    writeFileSync(path.join(dir, "calls.jsonl"), "");
    writeFileSync(path.join(dir, "world.json"), "{}");

    return {
        bin,
        env: { FAKE_KUBECTL_DIR: dir },
        answer(world) {
            writeFileSync(path.join(dir, "world.json"), JSON.stringify(world));
            rmSync(path.join(dir, "counts.json"), { force: true });
        },
        calls: () =>
            readFileSync(path.join(dir, "calls.jsonl"), "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Call),
        remove: () => rmSync(dir, { recursive: true, force: true }),
    };
}
