// A stand-in for `pi --mode rpc`: a small Node program that speaks the protocol of Pi's docs/rpc.md, scripted by a JSON file.
// PI_FAKE_SCRIPT names the script and PI_FAKE_LOG a file where it writes, as JSON lines, what it saw: its command line, its
// environment, every command it received and every answer to a question it asked. The plugin's tests start it in place of Pi.
import { appendFileSync, readFileSync } from "node:fs";

const script = JSON.parse(readFileSync(process.env.PI_FAKE_SCRIPT, "utf8"));
const logFile = process.env.PI_FAKE_LOG;
const log = (record) => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`);
};
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const raw = (text) => process.stdout.write(text);

log({ type: "start", argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, pid: process.pid });

if (script.ignoreSigterm) process.on("SIGTERM", () => log({ type: "sigterm-ignored" }));
else
    process.on("SIGTERM", () => {
        log({ type: "sigterm" });
        process.exit(143);
    });

let cost = 0;
let lastText = "";
let aborted = false;
let uiCounter = 0;
const waiting = new Map();
let steerWake;
const steerQueue = [];

const usage = (c) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: c } });

function turn(step) {
    cost += step.cost ?? 0;
    if (step.text !== undefined) lastText = step.text;
    out({ type: "turn_start" });
    const message = {
        role: "assistant",
        content: step.text === undefined ? [] : [{ type: "text", text: step.text }],
        usage: usage(step.cost ?? 0),
        stopReason: step.stopReason ?? "stop",
        ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
    };
    out({ type: "message_end", message });
    out({ type: "turn_end", message, toolResults: [] });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(step) {
    const id = step.id ?? `ui-${++uiCounter}`;
    const request = { type: "extension_ui_request", id, ...step.request };
    out(request);
    if (step.noWait) return;
    await new Promise((resolve) => waiting.set(id, resolve));
}

async function run(steps) {
    for (const step of steps) {
        if (aborted) return;
        if (step.turn) turn(step.turn);
        else if (step.ask) await ask(step.ask);
        else if (step.sleep) await sleep(step.sleep);
        else if (step.raw !== undefined) raw(step.raw);
        else if (step.flood) for (let i = 0; i < step.flood; i++) raw(`garbage ${i}\n`);
        else if (step.bigLine) raw(`${"x".repeat(step.bigLine)}\n`);
        else if (step.noNewline) raw("x".repeat(step.noNewline));
        else if (step.event) out(step.event);
        else if (step.stderr !== undefined) process.stderr.write(step.stderr);
        else if (step.hold) await new Promise((resolve) => (steerWake = resolve));
        else if (step.loop) {
            while (!aborted) {
                turn(step.loop);
                await sleep(step.loop.every ?? 5);
            }
            return;
        } else if (step.settle) {
            if (step.settle.text !== undefined) lastText = step.settle.text;
            out({ type: "agent_end", messages: [], willRetry: false });
            out({ type: "agent_settled", aborted: false });
        } else if (step.exit !== undefined) process.exit(step.exit);
    }
}

function commandsList() {
    return (script.commands ?? ["jig"]).map((name) => ({ name, source: "extension" }));
}

const model = script.model ?? {
    provider: "scripted",
    id: "model-1",
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

function handle(command) {
    log({ type: "command", command });
    const reply = (data, success = true, error) =>
        out({
            id: command.id,
            type: "response",
            command: command.type,
            success,
            ...(data === undefined ? {} : { data }),
            ...(error ? { error } : {}),
        });
    switch (command.type) {
        case "get_commands":
            if (script.slowCommands)
                return void setTimeout(() => reply({ commands: commandsList() }), script.slowCommands);
            return reply({ commands: commandsList() });
        case "get_state":
            return reply({ model, thinkingLevel: "off", isStreaming: false, sessionId: "fake" });
        case "get_session_stats":
            return reply({ cost, tokens: { total: 0 } });
        case "get_last_assistant_text":
            return reply({ text: lastText === "" ? null : lastText });
        case "prompt":
            if (script.rejectPrompt) return reply(undefined, false, "no model");
            reply({ disposition: script.disposition ?? "started" });
            out({ type: "agent_start" });
            void run(script.steps ?? []).then(() => script.onDone && run(script.onDone));
            return undefined;
        case "steer":
            reply({ disposition: "queued" });
            steerQueue.push(command.message);
            if (steerWake) steerWake();
            if (script.onSteer) void run(script.onSteer);
            return undefined;
        case "abort":
            if (script.ignoreAbort) return undefined;
            aborted = true;
            if (steerWake) steerWake();
            reply();
            out({ type: "agent_end", messages: [], willRetry: false });
            out({ type: "agent_settled", aborted: true });
            return undefined;
        default:
            return reply(undefined, false, `Unknown command: ${command.type}`);
    }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() === "") continue;
        const record = JSON.parse(line);
        if (record.type === "extension_ui_response") {
            log({ type: "ui-response", response: record });
            const wake = waiting.get(record.id);
            if (wake) {
                waiting.delete(record.id);
                wake();
            }
        } else handle(record);
    }
});
process.stdin.on("end", () => {
    log({ type: "stdin-end" });
    if (!script.ignoreStdinEnd) process.exit(0);
});
void run(script.startup ?? []);
setInterval(() => {}, 1 << 30);
