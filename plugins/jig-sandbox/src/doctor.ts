// `/sandbox doctor`: checks each requirement and then proves the sandbox works by running real commands in it: a write, a
// hidden read, a locked write, a name lookup, a connection to `localhost`, a Unix socket, a new user namespace and the
// environment. A check that fails says what to do. The proofs use files of their own in the session's private folder, so
// they touch nothing of the user's, and the name looked up and the server connected to are named by the caller.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { installCommand } from "./programs.ts";
import type { Sandbox } from "./sandbox.ts";

export interface DoctorLine {
    ok: boolean;
    /** What was checked. */
    check: string;
    /** What was found, or what to do. */
    detail?: string;
}

export interface DoctorOptions {
    /** The working folder commands run in. */
    cwd: string;
    /** The name to look up. Default `example.com`: the doctor is the one place a name is looked up for real. */
    lookupName?: string;
    platform: NodeJS.Platform;
}

const mark = (line: DoctorLine): string =>
    `${line.ok ? "ok  " : "FAIL"} ${line.check}${line.detail === undefined ? "" : `: ${line.detail}`}`;

/** The doctor's report as lines to show. */
export function formatDoctor(lines: readonly DoctorLine[]): string[] {
    const failed = lines.filter((line) => !line.ok).length;
    return [
        ...lines.map(mark),
        failed === 0 ? "All checks passed: the sandbox works." : `${failed} check${failed === 1 ? "" : "s"} failed.`,
    ];
}

/** Runs the checks. Never throws: a check that cannot run is a failed check. */
export async function runDoctor(sandbox: Sandbox, options: DoctorOptions): Promise<DoctorLine[]> {
    const lines: DoctorLine[] = [];
    const add = (ok: boolean, check: string, detail?: string): void => {
        lines.push({ ok, check, ...(detail === undefined ? {} : { detail }) });
    };

    const supported = options.platform === "linux" || options.platform === "darwin";
    add(
        supported,
        "platform",
        supported ? options.platform : `${options.platform} is not supported yet; Linux, WSL2 and macOS are`,
    );
    if (!supported) return lines;

    await sandbox.whenReady();
    const platform = options.platform === "darwin" ? "darwin" : "linux";
    if (platform === "linux") {
        for (const [name, command] of [
            ["bwrap", "bwrap"],
            ["socat", "socat"],
            ["ripgrep", "rg"],
        ] as const) {
            const found = sandbox.programs.found[name];
            add(
                found !== undefined,
                `program ${command}`,
                found ??
                    `not found; install it with: ${installCommand("linux", [{ name }])}, or give its path in sandbox.programs.${name} in jig.json`,
            );
        }
    } else {
        add(true, "programs", "the sandbox is part of macOS; nothing to install");
    }
    const problem = sandbox.problem;
    add(problem === undefined, "start", problem ?? "the sandbox broker is running");
    if (problem !== undefined || sandbox.sessionDir === undefined) return lines;
    add(true, "network mode", `${sandbox.mode}${sandbox.modeNote === undefined ? "" : ` (${sandbox.modeNote})`}`);

    const folder = path.join(sandbox.sessionDir, "doctor");
    mkdirSync(folder, { recursive: true });
    const marker = ["doctor", randomBytes(6).toString("hex")].join("-");

    // A write in the working folder, which is removed again.
    const scratch = `.jig-sandbox-doctor-${randomBytes(3).toString("hex")}`;
    const write = await sandbox.capture(`echo ${marker} > ${scratch} && cat ${scratch}; rm -f ${scratch}`, options.cwd);
    add(
        write.output.includes(marker),
        "a write in the working folder",
        write.output.includes(marker) ? undefined : firstLine(write.output) || "the file was not written",
    );

    // A hidden read: a file with a marker that the rules are told to hide for this one command.
    const secret = path.join(folder, "hidden-probe");
    writeFileSync(secret, `${marker}\n`);
    const hidden = await sandbox.capture(`cat ${secret} 2>&1; echo "--"; ls -A ${folder} 2>&1`, options.cwd, (fs) => ({
        ...fs,
        denyRead: [...fs.denyRead, { path: secret, literal: true }],
    }));
    add(
        !hidden.output.includes(marker) && hidden.exitCode === 0,
        "a hidden file cannot be read",
        hidden.output.includes(marker) ? "the probe file's text was readable" : undefined,
    );

    // A locked write: a file the rules are told to lock for this one command.
    const locked = path.join(folder, "locked-probe");
    writeFileSync(locked, "unchanged\n");
    await sandbox.capture(`echo changed >> ${locked} 2>&1; cat ${locked}`, options.cwd, (fs) => ({
        ...fs,
        allowWrite: [...fs.allowWrite, { path: folder, literal: true }],
        denyWrite: [...fs.denyWrite, { path: locked, literal: true }],
    }));
    const stayed = readFileSync(locked, "utf8") === "unchanged\n";
    add(stayed, "a locked file cannot be written", stayed ? undefined : "the probe file was changed");

    // The environment: a credential variable is not passed on.
    const environment = await sandbox.capture('echo "[$JIG_DOCTOR_PASSWORD]"', options.cwd, undefined, 30, {
        ...process.env,
        JIG_DOCTOR_PASSWORD: marker,
    });
    add(
        !environment.output.includes(marker),
        "a credential variable is not passed on",
        environment.output.includes(marker) ? "the variable reached the command" : undefined,
    );

    // A name lookup and a connection to localhost: they work in `open` mode, and must not in `off`. In `filtered` and `ask`
    // a command has a network of its own: names resolve only in the proxy and its `localhost` is empty.
    const open = sandbox.mode === "open";
    const proxied = sandbox.mode === "filtered" || sandbox.mode === "ask";
    const lookup = options.lookupName ?? "example.com";
    const resolved = await sandbox.capture(
        `getent hosts ${lookup} >/dev/null 2>&1 && echo resolved || echo not-resolved`,
        options.cwd,
    );
    const didResolve = resolved.output.includes("resolved") && !resolved.output.includes("not-resolved");
    add(
        didResolve === open,
        `a name lookup (${lookup})`,
        open
            ? didResolve
                ? "resolved"
                : "did not resolve; the network or /etc/resolv.conf is not reachable from the sandbox"
            : didResolve
              ? "resolved, but the network should be off or filtered"
              : proxied
                ? "refused, as names resolve only in the proxy in this mode"
                : "refused, as the network is off",
    );

    const connected = await connectsToLocalhost(sandbox, options.cwd);
    add(
        connected === open,
        "a connection to localhost",
        open
            ? connected
                ? "connected"
                : "the sandbox cannot reach servers on localhost"
            : connected
              ? "connected, but the command should have a network of its own"
              : proxied
                ? "refused, as a command's localhost is its own in this mode"
                : "refused, as the network is off",
    );

    if (proxied) {
        // Through the proxy, as a program that honours the proxy settings would go: the callback decides.
        const metadata = await proxyStatus(sandbox, options.cwd, "169.254.169.254", 80);
        add(
            /^HTTP\/1\.[01] 403/.test(metadata),
            "the proxy refuses a cloud metadata address",
            /^HTTP\/1\.[01] 403/.test(metadata) ? undefined : metadata || "no answer from the proxy",
        );
        const loopback = await proxyStatus(sandbox, options.cwd, "127.0.0.1", 1);
        add(
            /^HTTP\/1\.[01] 403/.test(loopback),
            "the proxy refuses this machine's own address",
            /^HTTP\/1\.[01] 403/.test(loopback) ? undefined : loopback || "no answer from the proxy",
        );
        if (sandbox.mode === "filtered") {
            // The callback's answer is the point: 403 is its refusal. 200 is a connection; a 5xx is the proxy allowed it and the
            // host did not answer, which says something about the network and nothing about the sandbox.
            const through = await proxyStatus(sandbox, options.cwd, lookup, 443);
            const allowed = /^HTTP\/1\.[01] (200|50\d)/.test(through);
            add(
                allowed,
                `the proxy lets ${lookup} through`,
                !allowed
                    ? through || "no answer from the proxy"
                    : /^HTTP\/1\.[01] 200/.test(through)
                      ? "connected"
                      : `allowed, but ${lookup} did not answer (${through})`,
            );
        } else {
            add(true, "a new host", "not tried: in the ask network mode it would ask you");
        }
        const problem = sandbox.bridge.problem;
        add(
            problem === undefined,
            "the localhost bridge",
            problem ?? "ready: ports of background tasks and of network.localhost are carried into each command",
        );
    }

    // Closed doors: a Unix socket cannot be made, and neither can a user namespace.
    if (platform === "linux") {
        const socket = await sandbox.capture(
            `python3 -c "import socket; socket.socket(socket.AF_UNIX)" 2>&1 | tail -1; echo "exit=$?"`,
            options.cwd,
        );
        const refused =
            /not permitted|permission|EPERM|Errno 1/i.test(socket.output) ||
            /python3: (command )?not found/.test(socket.output);
        add(refused, "a Unix socket cannot be made", refused ? undefined : firstLine(socket.output));
        const namespace = await sandbox.capture('unshare -U true 2>&1; echo "exit=$?"', options.cwd);
        add(
            !namespace.output.includes("exit=0"),
            "a new user namespace cannot be made",
            namespace.output.includes("exit=0") ? "it was made" : undefined,
        );
    }
    return lines;
}

function firstLine(text: string): string {
    return (
        text
            .trim()
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.slice(0, 200) ?? ""
    );
}

/**
 * Asks the sandbox's proxy, from inside a command, to open a tunnel to a host, and returns its first answer line (`HTTP/1.1 403
 * ...`). The proxy's name and password are in the command's environment, where the runtime put them for its own clients.
 */
async function proxyStatus(sandbox: Sandbox, cwd: string, host: string, port: number): Promise<string> {
    const result = await sandbox.capture(
        [
            "exec 3<>/dev/tcp/127.0.0.1/3128 2>/dev/null || { echo 'the proxy is not reachable'; exit 0; }",
            'auth=$(printf %s "$CLOUDSDK_PROXY_USERNAME:$CLOUDSDK_PROXY_PASSWORD" | base64 -w0)',
            `printf 'CONNECT ${host}:${port} HTTP/1.1\\r\\nHost: ${host}:${port}\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n' "$auth" >&3`,
            'read -t 15 -r line <&3; printf "%s\\n" "$line"',
        ].join("; "),
        cwd,
    );
    return firstLine(result.output.replace(/\r/g, ""));
}

/** Starts a server of our own on 127.0.0.1 and has a command in the sandbox connect to it with bash's /dev/tcp. */
async function connectsToLocalhost(sandbox: Sandbox, cwd: string): Promise<boolean> {
    const token = randomBytes(6).toString("hex");
    const server = net.createServer((socket) => socket.end(`${token}\n`));
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const port = (server.address() as net.AddressInfo).port;
        const result = await sandbox.capture(
            `exec 3<>/dev/tcp/127.0.0.1/${port} 2>/dev/null && read -t 5 line <&3 && echo "got:$line"`,
            cwd,
        );
        return result.output.includes(`got:${token}`);
    } catch {
        return false;
    } finally {
        server.close();
    }
}
