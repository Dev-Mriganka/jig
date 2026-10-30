// A fake `kubectl` and a fake `helm`: scripts in a temporary folder that answer from fixtures and record every call they get.
// No test touches a real cluster, and nothing here reads a kubeconfig.
//
// The script is the same one for both programs. What it answers is written to `world.json` by `answer()`; each call it gets
// is appended to `calls.jsonl` with the program, its argument list, what arrived on standard input, and the one environment
// variable the programs are given (the kubeconfig).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** What a fake program does for one call. */
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

/** What the cluster and helm answer, by the kind of call. */
export interface World {
    /** `kubectl get pods ...` */
    pods?: Answers;
    /** `kubectl get deployments,statefulsets ...` */
    workloads?: Answers;
    /** `kubectl get deployment/<name>` and `statefulset/<name>`: one workload. */
    workload?: Answers;
    /** `kubectl get replicasets ...` */
    replicasets?: Answers;
    /** `kubectl get controllerrevisions ...` */
    controllerrevisions?: Answers;
    /** `kubectl get events ...` */
    events?: Answers;
    /** `kubectl logs ...` */
    logs?: Answers;
    /** `kubectl exec ...` */
    exec?: Answers;
    /** `kubectl set image ...` */
    setImage?: Answers;
    /** `kubectl rollout undo ...` */
    rolloutUndo?: Answers;
    /** `helm upgrade ...` */
    helmUpgrade?: Answers;
    /** `helm rollback ...` */
    helmRollback?: Answers;
    /** `helm history ...` */
    helmHistory?: Answers;
    /** `helm get values ...` */
    helmGetValues?: Answers;
}

export interface Call {
    program: "kubectl" | "helm";
    argv: string[];
    stdin: string;
    /** The KUBECONFIG the program was started with, if any. */
    kubeconfig: string | undefined;
}

export interface FakePrograms {
    /** The folder that holds the `kubectl` and `helm` scripts: what goes first on PATH. */
    bin: string;
    /** Replaces what the programs answer, and starts every list of replies again from its first reply. */
    answer(world: World): void;
    /** The kubectl calls so far, in order. */
    calls(): Call[];
    /** The helm calls so far, in order. */
    helmCalls(): Call[];
    /** The environment a program started on PATH needs for the script to find its files. */
    env: Readonly<Record<string, string>>;
    remove(): void;
}

// The script runs under the node that runs the tests, found by its path, so the test PATH does not matter.
const SCRIPT = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_PROGRAMS_DIR;
const program = path.basename(process.argv[1]);
const argv = process.argv.slice(2);

// The key of the world that answers this call.
function keyOf() {
    if (program === "helm") {
        const sub = argv[0];
        const words = sub === "get" ? [sub, argv[1]] : [sub];
        return "helm" + words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
    }
    const verb = argv.find((arg) => !arg.startsWith("-"));
    const rest = argv.slice(argv.indexOf(verb) + 1);
    if (verb === "get") {
        const resource = rest[0];
        if (["pods", "events", "replicasets", "controllerrevisions"].includes(resource)) return resource;
        if (resource === "deployments,statefulsets") return "workloads";
        if (/^(deployment|statefulset)\\//.test(resource)) return "workload";
        return "get " + resource;
    }
    if (verb === "set") return "setImage";
    if (verb === "rollout") return "rolloutUndo";
    return verb;
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ program, argv, stdin, kubeconfig: process.env.KUBECONFIG }) + "\\n");
    const key = keyOf();
    const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
    const countFile = path.join(dir, "counts.json");
    const counts = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, "utf8")) : {};
    const answers = world[key];
    if (answers === undefined) {
        process.stderr.write("fake " + program + " has no answer for: " + argv.join(" ") + "\\n");
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

export function installFakePrograms(): FakePrograms {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-ops-fake-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    for (const program of ["kubectl", "helm"]) {
        writeFileSync(path.join(bin, program), SCRIPT);
        chmodSync(path.join(bin, program), 0o755);
    }
    writeFileSync(path.join(dir, "calls.jsonl"), "");
    writeFileSync(path.join(dir, "world.json"), "{}");

    const all = (): Call[] =>
        readFileSync(path.join(dir, "calls.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Call);

    return {
        bin,
        env: { FAKE_PROGRAMS_DIR: dir },
        answer(world) {
            writeFileSync(path.join(dir, "world.json"), JSON.stringify(world));
            rmSync(path.join(dir, "counts.json"), { force: true });
        },
        calls: () => all().filter((call) => call.program === "kubectl"),
        helmCalls: () => all().filter((call) => call.program === "helm"),
        remove: () => rmSync(dir, { recursive: true, force: true }),
    };
}
