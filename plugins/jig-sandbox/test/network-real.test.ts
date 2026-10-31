// The `filtered` and `ask` network modes in the real sandbox. Nothing here depends on the internet: a "public host" is a
// loopback alias (127.0.0.2) that the test tells the policy to treat as public, with a server of the test's own behind it, so the
// whole path runs: the command, the proxy, the callback in the broker, the policy in Pi, and the connection to the server.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { realSession, until } from "./support/session.ts";
import type { Session, SessionOptions } from "./support/session.ts";

const skip = skipUnlessRealSandbox();

/** The alias the tests use as a public host. */
const PUBLIC = "127.0.0.2";
const asPublic = (address: string, real: unknown) => (address === PUBLIC ? undefined : real);

interface Listening {
    port: number;
    hits: string[];
    close(): Promise<void>;
}

/** A server of the test's own: answers every request with its name and records the paths asked for. */
async function serve(host: string, name: string): Promise<Listening> {
    const hits: string[] = [];
    const server = http.createServer((request, response) => {
        hits.push(request.url ?? "");
        response.end(`hello from ${name}\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return {
        port: (server.address() as net.AddressInfo).port,
        hits,
        close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
    };
}

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

/**
 * A command that fetches a URL with Python. `default` is a program that honours the proxy settings and `no_proxy` as it finds
 * them; `proxy` goes through the sandbox's proxy whatever `no_proxy` says (a program that sends everything there); `direct`
 * never uses the proxy.
 */
function fetch(url: string, how: "default" | "proxy" | "direct" = "default"): string {
    const opener =
        how === "direct"
            ? "urllib.request.build_opener(urllib.request.ProxyHandler({}))"
            : how === "proxy"
              ? "urllib.request.build_opener(urllib.request.ProxyHandler({'http': os.environ['HTTP_PROXY']}))"
              : "urllib.request.build_opener()";
    return [
        "python3 - <<'PY'",
        "import os, urllib.request",
        ...(how === "proxy" ? ["os.environ.pop('no_proxy', None)", "os.environ.pop('NO_PROXY', None)"] : []),
        `opener = ${opener}`,
        "try:",
        `    reply = opener.open("${url}", timeout=15)`,
        '    print("status", reply.status, reply.read().decode().strip())',
        "except Exception as error:",
        '    print("failed:", error)',
        "PY",
    ].join("\n");
}

function filtered(
    over: Partial<{ localhost: number[]; deny: string[]; allow: string[] }> = {},
    mode: "filtered" | "ask" = "filtered",
): SessionOptions {
    return {
        settings: (base) => ({ ...base, network: { ...base.network, mode, ...over } }),
        options: { network: { range: asPublic as never } },
    };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

async function begin(over: SessionOptions): Promise<Session> {
    const s = realSession(over);
    closers.push(() => s.cleanup());
    await s.start();
    return s;
}

describe("filtered", { skip }, () => {
    let s: Session;
    before(async () => {
        s = realSession(filtered());
        await s.start();
    });
    after(() => s.cleanup());

    test("a public host is reached through the proxy: the callback allowed it and the connection was made", async () => {
        const server = await serve(PUBLIC, "the public host");
        closers.push(server.close);
        const result = await s.bash(fetch(`http://${PUBLIC}:${server.port}/page`));
        assert.match(result.text, /status 200 hello from the public host/);
        assert.deepEqual(server.hits, ["/page"], "the request reached the server, through the proxy");
    });

    test("the cloud metadata address is refused, with the reason, and nothing was sent", async () => {
        const result = await s.bash(fetch("http://169.254.169.254/latest/meta-data/"));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.match(
            result.text,
            /\[sandbox\] cannot reach 169\.254\.169\.254:80: it is a cloud metadata address, and those are always blocked\./,
        );
    });

    test("this machine's loopback is refused, with the way through, and the server behind it saw nothing", async () => {
        const server = await serve("127.0.0.1", "a service on this machine");
        closers.push(server.close);
        const viaProxy = await s.bash(fetch(`http://127.0.0.1:${server.port}/`, "proxy"));
        assert.match(viaProxy.text, /failed: HTTP Error 403/);
        assert.match(
            viaProxy.text,
            new RegExp(
                `\\[sandbox\\] cannot reach 127\\.0\\.0\\.1:${server.port}: it is this machine's own address; list its port in sandbox\\.network\\.localhost`,
            ),
        );
        const direct = await s.bash(fetch(`http://127.0.0.1:${server.port}/`, "direct"));
        assert.match(direct.text, /failed: .*Connection refused/, "a command's localhost is its own, and empty");
        assert.deepEqual(server.hits, []);
    });

    test("this machine's private and link-local neighbours are refused too", async () => {
        const proxied = (url: string) => fetch(url, "proxy");
        for (const [url, why] of [
            ["http://10.255.255.1/", /private network address/],
            ["http://192.168.254.254/", /private network address/],
            ["http://169.254.1.1/", /link-local address/],
            ["http://100.64.0.1/", /carrier-grade NAT/],
        ] as const) {
            const result = await s.bash(proxied(url));
            assert.match(result.text, /failed: HTTP Error 403/, url);
            assert.match(result.text, why, url);
        }
    });

    test("an address spelled so that a program reads it as 127.0.0.1 is not a way round", async () => {
        const server = await serve("127.0.0.1", "a service on this machine");
        closers.push(server.close);
        const result = await s.bash(fetch(`http://2130706433:${server.port}/`, "proxy"));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.deepEqual(server.hits, []);
    });

    test("a name that resolves to this machine is refused by the proxy's own check, since the callback sees only the name", async (t) => {
        // `ip6-localhost` is in the hosts file of Debian and Ubuntu; a machine without it has no name to try.
        if (!readFileSync("/etc/hosts", "utf8").includes("ip6-localhost"))
            return t.skip("no ip6-localhost in /etc/hosts");
        const server = http.createServer((_request, response) => response.end("reached the host service\n"));
        await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
        closers.push(() => new Promise<void>((resolve) => void server.close(() => resolve())));
        const { port } = server.address() as net.AddressInfo;
        const result = await s.bash(fetch(`http://ip6-localhost:${port}/`, "proxy"));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.match(result.text, /cannot reach ip6-localhost:\d+: resolved to a loopback address/);
    });

    test("a name does not resolve for a program that ignores the proxy, and the output says why", async () => {
        const result = await s.bash("getent hosts example.com; echo exit=$?");
        assert.match(result.text, /exit=2/);
        const unreachable = await s.bash(
            "python3 -c \"import socket; socket.create_connection(('203.0.113.77', 80), 3)\" 2>&1 | tail -1",
        );
        assert.match(unreachable.text, /unreachable|timed out|refused/i);
    });
});

describe("network.localhost", { skip }, () => {
    test("a listed port on this machine is reachable from a command, by number and by name; an unlisted one is not", async () => {
        const listed = await serve("127.0.0.1", "the database");
        const unlisted = await serve("127.0.0.1", "a tunnel");
        closers.push(listed.close, unlisted.close);
        const s = await begin(filtered({ localhost: [listed.port] }));
        const byNumber = await s.bash(fetch(`http://127.0.0.1:${listed.port}/`, "direct"));
        assert.match(byNumber.text, /status 200 hello from the database/);
        const byName = await s.bash(fetch(`http://localhost:${listed.port}/`, "direct"));
        assert.match(byName.text, /status 200 hello from the database/);
        const other = await s.bash(fetch(`http://127.0.0.1:${unlisted.port}/`, "direct"));
        assert.match(other.text, /failed: .*Connection refused/);
        assert.deepEqual(unlisted.hits, [], "a port jig-core opened for a tunnel is not reachable unless it is listed");
        const proxied = await s.bash(fetch(`http://127.0.0.1:${unlisted.port}/`, "proxy"));
        assert.match(proxied.text, /failed: HTTP Error 403/);
        assert.deepEqual(unlisted.hits, []);
    });

    test("it works for a program that is not HTTP: a plain TCP exchange through the forwarder", async () => {
        const echo = net.createServer((socket) => socket.on("data", (data) => socket.end(`echo:${data}`)));
        await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
        closers.push(() => new Promise<void>((resolve) => void echo.close(() => resolve())));
        const port = (echo.address() as net.AddressInfo).port;
        const s = await begin(filtered({ localhost: [port] }));
        const result = await s.bash(
            `exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'ping' >&3; read -t 5 -r line <&3; echo "got:$line"`,
        );
        assert.match(result.text, /got:echo:ping/);
    });

    test("every command starts with its forwarders in about the time of a process, and the cost is measured", async () => {
        const echo = net.createServer((socket) => socket.end("x"));
        await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
        closers.push(() => new Promise<void>((resolve) => void echo.close(() => resolve())));
        const port = (echo.address() as net.AddressInfo).port;
        const plain = await begin(filtered());
        const bridged = await begin(filtered({ localhost: [port, port + 1, port + 2] }));
        const time = async (s: Session): Promise<number> => {
            const times: number[] = [];
            for (let index = 0; index < 12; index++) {
                const started = performance.now();
                await s.bash("true");
                times.push(performance.now() - started);
            }
            times.sort((a, b) => a - b);
            return times[Math.floor(times.length / 2)] as number;
        };
        const without = await time(plain);
        const withThree = await time(bridged);
        console.log(
            `    a command in filtered mode: median ${without.toFixed(0)} ms with no bridged port, ${withThree.toFixed(0)} ms with three`,
        );
        assert.ok(withThree < without + 1500, `three forwarders cost ${(withThree - without).toFixed(0)} ms`);
    });
});

describe("a background task's server", { skip }, () => {
    test("is reached by a later command and by you on this machine, and goes when the task does", async () => {
        const port = await freePort();
        const s = await begin(filtered());
        writeFileSync(path.join(s.project, "index.html"), "hello from the task\n");
        const started = await s.bash(`python3 -u -m http.server ${port} --bind 127.0.0.1`, {
            background: true,
            name: "files",
            notifyOn: { ready: ["Serving HTTP"] },
        });
        assert.equal(started.isError, false, started.text);
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(
            () => s.pi.messages.some((item) => String(item.message.content).includes('"files": READY')),
            15_000,
            "ready",
        );

        // From a later command: it has its own network, and the server is at the same port in it.
        const fromCommand = await s.bash(fetch(`http://127.0.0.1:${port}/`, "direct"));
        assert.match(fromCommand.text, /status 200 hello from the task/);
        const byName = await s.bash(fetch(`http://localhost:${port}/`, "direct"));
        assert.match(byName.text, /status 200 hello from the task/);

        // From this machine: the same port on its loopback.
        const reply = await new Promise<string>((resolve) => {
            http.get(`http://127.0.0.1:${port}/`, (response) => {
                let body = "";
                response.on("data", (chunk) => {
                    body += chunk;
                });
                response.on("end", () => resolve(body));
            }).on("error", (error) => resolve(`error ${error.message}`));
        });
        assert.equal(reply.trim(), "hello from the task");

        assert.match((await s.call("bg_list", {})).text, new RegExp(`listening on ${port}`));
        await s.call("bg_kill", { id });
        const gone = await s.bash(fetch(`http://127.0.0.1:${port}/`, "direct"));
        assert.match(gone.text, /failed: .*Connection refused/);
        const after = await new Promise<string>((resolve) => {
            http.get(`http://127.0.0.1:${port}/`, () => resolve("answered")).on("error", () => resolve("refused"));
        });
        assert.equal(after, "refused", "the listener on this machine went with the task");
    });

    test("a port that is in use on this machine is not carried, so a tunnel there stays out of reach", async () => {
        const tunnel = await serve("127.0.0.1", "a tunnel to production");
        closers.push(tunnel.close);
        const s = await begin(filtered());
        const started = await s.bash(`python3 -u -m http.server ${tunnel.port} --bind 127.0.0.1`, {
            background: true,
            name: "clash",
            notifyOn: { ready: ["Serving HTTP"] },
        });
        const id = /task (bg-\d+)/.exec(started.text)?.[1] as string;
        await until(
            () => s.pi.messages.some((item) => String(item.message.content).includes('"clash": READY')),
            15_000,
            "ready",
        );
        const direct = await s.bash(fetch(`http://127.0.0.1:${tunnel.port}/`, "direct"));
        assert.match(direct.text, /failed: .*Connection refused/, "no forwarder: the port is not carried");
        const list = await until(
            async () => {
                const text = (await s.call("bg_list", {})).text;
                return /also in use on this machine/.test(text) ? text : undefined;
            },
            5000,
            "the note",
        );
        assert.match(list, new RegExp(`note: port ${tunnel.port} is also in use on this machine`));
        assert.deepEqual(tunnel.hits, [], "nothing the sandbox did reached the tunnel");
        await s.call("bg_kill", { id });
    });
});

describe("ask", { skip }, () => {
    test("a new host asks once, and each answer is remembered as it was given", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        const questions: string[] = [];
        let answer = "This session";
        const s = await begin({
            ...filtered({}, "ask"),
            select: (title, options) => {
                if (!options.includes("This session")) return undefined;
                questions.push(title);
                return answer;
            },
        });
        const url = `http://${PUBLIC}:${server.port}/`;
        const first = await s.bash(fetch(url));
        assert.match(first.text, /status 200 hello from the new host/);
        assert.equal(questions.length, 1);
        assert.match(
            questions[0] ?? "",
            new RegExp(`^bash wants to reach ${PUBLIC.replaceAll(".", "\\.")}:${server.port}\\.`),
        );
        const second = await s.bash(fetch(url));
        assert.match(second.text, /status 200/);
        assert.equal(questions.length, 1, "this session: not asked again");
        void answer;
        answer = "No";
    });

    test("No refuses with the reason, and asks again next time", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        let asked = 0;
        const s = await begin({
            ...filtered({}, "ask"),
            select: (_title, options) => (options.includes("This session") ? (asked++, "No") : undefined),
        });
        const result = await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.match(
            result.text,
            /\[sandbox\] cannot reach 127\.0\.0\.2:\d+: it was refused: the user said no\. Do not try another way round it\./,
        );
        assert.deepEqual(server.hits, []);
        await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        assert.equal(asked, 2);
    });

    test("Always is kept in the agent folder", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        const s = await begin({
            ...filtered({}, "ask"),
            select: (_title, options) => (options.includes("This session") ? "Always" : undefined),
        });
        await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        const file = path.join(s.agentDir, "jig-sandbox", "allowed.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hosts, [`${PUBLIC}:${server.port}`]);
    });

    test("Once is enough for a command that opens several connections", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        let asked = 0;
        const s = await begin({
            ...filtered({}, "ask"),
            select: (_title, options) => (options.includes("Once") ? (asked++, "Once") : undefined),
        });
        const url = `http://${PUBLIC}:${server.port}/`;
        const result = await s.bash(`${fetch(url)}\n${fetch(url)}\n${fetch(url)}`);
        assert.equal((result.text.match(/status 200/g) ?? []).length, 3);
        assert.equal(asked, 1);
    });

    test("with no screen a new host is refused, and says how a person allows it", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        const s = await begin({ ...filtered({}, "ask"), ui: false });
        // No screen also means no background tasks and a print-mode context, but a command still runs.
        const result = await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.match(
            result.text,
            /no screen to ask on\. A person can allow it with \/sandbox allowed add 127\.0\.0\.2/,
        );
        assert.deepEqual(server.hits, []);
    });

    test("a host from network.allow, and one a person added, pass without a question", async () => {
        const server = await serve(PUBLIC, "the new host");
        closers.push(server.close);
        let asked = 0;
        const s = await begin({
            ...filtered({ allow: [PUBLIC] }, "ask"),
            select: (_title, options) => (options.includes("This session") ? (asked++, "No") : undefined),
        });
        const result = await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        assert.match(result.text, /status 200/);
        assert.equal(asked, 0);
    });
});

describe("deny", { skip }, () => {
    test("refuses a host in filtered mode, with the reason and the entry", async () => {
        const server = await serve(PUBLIC, "the denied host");
        closers.push(server.close);
        const s = await begin(filtered({ deny: [PUBLIC] }));
        const result = await s.bash(fetch(`http://${PUBLIC}:${server.port}/`));
        assert.match(result.text, /failed: HTTP Error 403/);
        assert.match(
            result.text,
            new RegExp(`it is on sandbox\\.network\\.deny \\(${PUBLIC.replaceAll(".", "\\.")}\\)`),
        );
        assert.deepEqual(server.hits, []);
    });
});

describe("the doctor in filtered mode", { skip }, () => {
    test("every check passes, with a stand-in for the name it looks up", async () => {
        const server = await serve(PUBLIC, "the looked-up host");
        closers.push(server.close);
        void server;
        const s = await begin({
            ...filtered(),
            options: { lookupName: PUBLIC, network: { range: asPublic as never } },
        });
        const lines = await s.command("sandbox", "doctor");
        const text = lines.join("\n");
        assert.match(text, /ok   the proxy refuses a cloud metadata address/);
        assert.match(text, /ok   the proxy refuses this machine's own address/);
        assert.match(text, /ok   the localhost bridge/);
        assert.match(text, /All checks passed: the sandbox works\./, text);
        mkdirSync(s.project, { recursive: true });
    });
});

describe("filtered keeps everything else working", { skip }, () => {
    test("twelve commands at once run, and two of them can each start a server on the same port: a command's network is its own", async () => {
        const s = await begin(filtered());
        const results = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                s.bash(
                    index < 2
                        ? `python3 -u -m http.server 18123 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & sleep 1; python3 - <<'PY'\nimport urllib.request\nprint("served", urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:18123/", timeout=5).status)\nPY`
                        : `echo ${index}`,
                ),
            ),
        );
        assert.match(results[0]?.text ?? "", /served 200/);
        assert.match(results[1]?.text ?? "", /served 200/, "the same port in another command's network does not clash");
        for (const [index, result] of results.slice(2).entries()) assert.equal(result.text.trim(), String(index + 2));
    });

    test("git works in the project as it does in open mode, and a Unix socket is still closed", async () => {
        const s = await begin(filtered({ localhost: [5432] }));
        const git = await s.bash(
            "git init -q && git config user.name Test && git config user.email t@example.com && echo hello > f && git add f && git commit -qm first && git log --oneline | wc -l",
        );
        assert.equal(git.text.trim(), "1");
        const socket = await s.bash('python3 -c "import socket; socket.socket(socket.AF_UNIX)" 2>&1 | tail -1');
        assert.match(socket.text, /not permitted|Errno 1/i, "the forwarders do not open the Unix-socket door");
    });

    test("a server and its client in one command work with no bridge at all", async () => {
        const s = await begin(filtered());
        const result = await s.bash(
            `python3 -u -m http.server 18124 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & sleep 1; python3 - <<'PY'\nimport urllib.request\nprint("ok", urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:18124/", timeout=5).status)\nPY`,
        );
        assert.match(result.text, /ok 200/);
    });

    test("the proxy variables are set, and the runtime's Java agent and git command are in the environment", async () => {
        const s = await begin(filtered());
        const result = await s.bash(
            [
                "printf '%s\\n'",
                '"$' + '{HTTP_PROXY:+proxy}"',
                '"$' + '{JAVA_TOOL_OPTIONS:+java}"',
                '"$' + '{GIT_SSH_COMMAND:+git}"',
            ].join(" "),
        );
        assert.equal(result.text.trim().split("\n").join(" "), "proxy java git");
    });
});
