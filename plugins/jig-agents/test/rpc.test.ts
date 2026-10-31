// The RPC client on its own, with pipes made in the test: framing on LF only, responses matched by id, bad lines counted, long lines
// dropped, and every way a command can fail to be answered.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { fakeClock } from "../../jig-core/test/support/clock.ts";
import { RpcChannel } from "../src/rpc.ts";
import type { RpcOptions, Wire } from "../src/rpc.ts";

function rig(options: Partial<RpcOptions> = {}) {
    const clock = fakeClock();
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    const seen = { events: [] as Wire[], ui: [] as Wire[], unreadable: [] as string[], closed: 0 };
    const channel = new RpcChannel(
        stdout,
        stdin,
        {
            event: (event) => seen.events.push(event),
            ui: (request) => seen.ui.push(request),
            unreadable: (reason) => seen.unreadable.push(reason),
            closed: () => void seen.closed++,
        },
        { timers: clock.timers, ...options },
    );
    const lines = () =>
        written
            .join("")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { clock, stdout, stdin, channel, seen, lines, written };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("reading", () => {
    test("splits records on LF only, however the bytes arrive", async () => {
        const { stdout, seen } = rig();
        stdout.write('{"type":"a"}\n{"type":"b"');
        stdout.write('}\n{"type":"c"}');
        stdout.write("\n");
        await settle();
        assert.deepEqual(
            seen.events.map((e) => e.type),
            ["a", "b", "c"],
        );
    });

    test("keeps a multi-byte character that is split across two chunks whole", async () => {
        const { stdout, seen } = rig();
        const bytes = Buffer.from('{"type":"a","text":"żółć 日本語"}\n', "utf8");
        stdout.write(bytes.subarray(0, 18));
        stdout.write(bytes.subarray(18));
        await settle();
        assert.equal(seen.events[0]?.text, "żółć 日本語");
    });

    test("does not split on the Unicode line and paragraph separators inside a string, and strips a carriage return", async () => {
        const { stdout, seen } = rig();
        stdout.write(
            `{"type":"a","text":"one${String.fromCharCode(0x2028)}two${String.fromCharCode(0x2029)}three"}\r\n`,
        );
        await settle();
        assert.equal(seen.events.length, 1);
        assert.equal(seen.events[0]?.text, `one${String.fromCharCode(0x2028)}two${String.fromCharCode(0x2029)}three`);
    });

    test("hands extension UI requests apart from events, and ignores blank lines", async () => {
        const { stdout, seen } = rig();
        stdout.write('\n\n{"type":"extension_ui_request","id":"x","method":"select"}\n{"type":"turn_end"}\n');
        await settle();
        assert.deepEqual(
            seen.ui.map((r) => r.id),
            ["x"],
        );
        assert.deepEqual(
            seen.events.map((e) => e.type),
            ["turn_end"],
        );
    });

    test("counts lines that are not records, tolerates a few and gives up once, past the limit", async () => {
        const { stdout, seen, channel } = rig({ maxBadLines: 3 });
        stdout.write('not json\n[1]\n42\n{"type":7}\n');
        await settle();
        assert.equal(channel.badLines, 4);
        assert.equal(seen.unreadable.length, 1);
        assert.match(seen.unreadable[0] ?? "", /more than 3 unreadable lines/);
        stdout.write('{"type":"after"}\n{"x\n{"y\n');
        await settle();
        assert.equal(seen.unreadable.length, 1, "told once");
        assert.deepEqual(seen.events, [], "nothing is read after giving up");
    });

    test("drops a line longer than the limit and carries on after it", async () => {
        const { stdout, seen, channel } = rig({ maxLineChars: 100 });
        stdout.write(`{"type":"big","text":"${"x".repeat(500)}"}\n{"type":"small"}\n`);
        await settle();
        assert.deepEqual(
            seen.events.map((e) => e.type),
            ["small"],
        );
        assert.equal(channel.badLines, 1);
    });

    test("drops a line that never ends, without keeping it in memory, and reads the line after it", async () => {
        const { stdout, seen, channel } = rig({ maxLineChars: 100 });
        for (let i = 0; i < 20; i++) stdout.write("y".repeat(50));
        stdout.write('rest of it\n{"type":"next"}\n');
        await settle();
        assert.deepEqual(
            seen.events.map((e) => e.type),
            ["next"],
        );
        assert.equal(channel.badLines, 1, "one bad line, however long");
    });

    test("a handler that throws does not stop the reader", async () => {
        const stdout = new PassThrough();
        const stdin = new PassThrough();
        const clock = fakeClock();
        let n = 0;
        new RpcChannel(
            stdout,
            stdin,
            {
                event: () => {
                    if (n++ === 0) throw new Error("bug");
                },
                ui: () => undefined,
                unreadable: () => undefined,
                closed: () => undefined,
            },
            { timers: clock.timers },
        );
        stdout.write('{"type":"a"}\n{"type":"b"}\n');
        await settle();
        assert.equal(n, 2);
    });

    test("tells the owner when the output ends, and reads a last line that has no LF", async () => {
        const { stdout, seen } = rig();
        stdout.write('{"type":"last"}');
        stdout.end();
        await settle();
        assert.deepEqual(
            seen.events.map((e) => e.type),
            ["last"],
        );
        assert.equal(seen.closed, 1);
    });
});

describe("commands", () => {
    test("a command is written as one line with its own id, and the response with that id answers it", async () => {
        const { channel, stdout, lines } = rig();
        const pending = channel.request({ type: "get_state" });
        await settle();
        const sent = lines()[0] as { id: string; type: string };
        assert.equal(sent.type, "get_state");
        assert.match(sent.id, /^jig-\d+$/);
        stdout.write(
            `{"id":"${sent.id}","type":"response","command":"get_state","success":true,"data":{"model":"m"}}\n`,
        );
        assert.deepEqual(await pending, { model: "m" });
    });

    test("responses are matched by id, not by order, and one with an unknown id is ignored", async () => {
        const { channel, stdout, lines } = rig();
        const first = channel.request({ type: "get_state" });
        const second = channel.request({ type: "get_commands" });
        await settle();
        const [a, b] = lines() as Array<{ id: string }>;
        stdout.write('{"id":"stranger","type":"response","command":"x","success":true,"data":"no"}\n');
        stdout.write(`{"id":"${b?.id}","type":"response","command":"get_commands","success":true,"data":"second"}\n`);
        stdout.write(`{"id":"${a?.id}","type":"response","command":"get_state","success":true,"data":"first"}\n`);
        assert.equal(await first, "first");
        assert.equal(await second, "second");
    });

    test("a failed response rejects with the child's reason, cut", async () => {
        const { channel, stdout, lines } = rig();
        const pending = channel.request({ type: "prompt" });
        await settle();
        const id = (lines()[0] as { id: string }).id;
        stdout.write(
            `{"id":"${id}","type":"response","command":"prompt","success":false,"error":"${"e".repeat(500)}"}\n`,
        );
        await assert.rejects(
            pending,
            (error: Error) => error.message.startsWith("prompt failed: eeee") && error.message.length < 260,
        );
    });

    test("a command that is not answered in time rejects, and a late answer is ignored", async () => {
        const { channel, stdout, lines, clock } = rig();
        const pending = channel.request({ type: "get_state" }, 5000);
        await settle();
        const rejected = assert.rejects(pending, /get_state was not answered within 5 s/);
        await clock.advance(5000);
        await rejected;
        stdout.write(
            `{"id":"${(lines()[0] as { id: string }).id}","type":"response","command":"get_state","success":true}\n`,
        );
        await settle();
    });

    test("commands that are waiting fail when the output closes, and none can be sent after", async () => {
        const { channel, stdout } = rig();
        const pending = channel.request({ type: "get_state" });
        await settle();
        stdout.end();
        await assert.rejects(pending, /the child's output closed/);
        await assert.rejects(channel.request({ type: "get_state" }), /the child is not listening/);
        assert.equal(channel.send({ type: "extension_ui_response", id: "x" }), false);
    });

    test("commands that are waiting fail when the channel gives up on garbage", async () => {
        const { channel, stdout } = rig({ maxBadLines: 1 });
        const pending = channel.request({ type: "get_state" });
        await settle();
        stdout.write("a\nb\n");
        await assert.rejects(pending, /could not be read/);
    });

    test("ending the input stops writes, and a closed pipe is a false, not a throw", async () => {
        const { channel, stdin } = rig();
        assert.equal(channel.send({ type: "steer", message: "x" }), true);
        channel.endInput();
        assert.equal(channel.send({ type: "steer", message: "y" }), false);
        stdin.destroy();
        assert.equal(channel.writable, false);
        channel.endInput();
    });

    test("a response to an extension UI request is written without an id of its own, and as the same line the child expects", async () => {
        const { channel, lines } = rig();
        channel.send({ type: "extension_ui_response", id: "uuid-1", value: "Allow" });
        await settle();
        assert.deepEqual(lines(), [{ type: "extension_ui_response", id: "uuid-1", value: "Allow" }]);
    });
});
