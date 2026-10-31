// The jump host the routes go through: a real SSH server, found by environment variables. These helpers do what a person does
// before using an SSH route (trust the server's host key) and what a company plugin's tunnel provider does for a SOCKS proxy
// (run `ssh -D`), with the real `ssh` program.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TunnelProvider } from "../../../jig-core/src/contract.ts";
import { must } from "../../../../test/support/it.ts";
import { freePort, probe } from "../../src/route.ts";

export interface Jump {
    host: string;
    port: number;
    user: string;
    /** The private key's file. The tests read it into the fake secret store and give ssh the path. */
    keyFile: string;
}

export function jump(): Jump {
    return {
        host: must("JIG_IT_SSH_HOST"),
        port: Number(must("JIG_IT_SSH_PORT")),
        user: must("JIG_IT_SSH_USER"),
        keyFile: must("JIG_IT_SSH_KEY_FILE"),
    };
}

export const privateKey = (server: Jump): string => readFileSync(server.keyFile, "utf8");

/** A folder for one test file's files, removed at the end. */
export function scratch(): { dir: string; remove(): void } {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-mongo-it-"));
    return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The server's host keys in a known_hosts file, as `ssh-keyscan` gets them: what a person adds by connecting once. */
export function trustHostKeys(server: Jump, file: string): void {
    const keys = execFileSync("ssh-keyscan", ["-p", String(server.port), server.host], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (keys.trim() === "") throw new Error("ssh-keyscan found no host key: is the SSH server up?");
    writeFileSync(file, keys);
}

/**
 * A folder that holds an `ssh` that is the real one with a known_hosts file of the test's choice. The plugin starts `ssh` with
 * `-F /dev/null`, so it reads the user's own ~/.ssh/known_hosts, which a test must not change. Put the folder first on the PATH
 * of the programs the plugin starts (`useProgramsIn`).
 */
export function sshWithKnownHosts(dir: string, knownHosts: string): string {
    const real = execFileSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" }).trim();
    const bin = path.join(dir, `bin-${path.basename(knownHosts)}`);
    mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "ssh");
    writeFileSync(
        script,
        `#!/bin/sh\nexec ${JSON.stringify(real)} -o UserKnownHostsFile=${JSON.stringify(knownHosts)} "$@"\n`,
    );
    chmodSync(script, 0o755);
    return bin;
}

/** A new key pair that the server does not know, written without a passphrase. Returns the private key's file. */
export function strangerKey(dir: string): string {
    const file = path.join(dir, "stranger");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "jig-it-stranger", "-f", file]);
    return file;
}

/**
 * A tunnel provider as a company plugin would write one: `ssh -N -D` to the jump host, which makes a SOCKS5 proxy on a local
 * port that reaches whatever the jump host can reach, by name. `opened` collects the ports it handed out.
 */
export function socksProvider(
    server: Jump,
    knownHosts: string,
    opened: Array<{ port: number; closed: boolean }> = [],
): TunnelProvider {
    return {
        async open() {
            const port = await freePort();
            const child = spawn(
                "ssh",
                [
                    "-N",
                    "-D",
                    `127.0.0.1:${port}`,
                    "-i",
                    server.keyFile,
                    "-F",
                    "/dev/null",
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    `UserKnownHostsFile=${knownHosts}`,
                    "-o",
                    "ConnectTimeout=10",
                    "-p",
                    String(server.port),
                    `${server.user}@${server.host}`,
                ],
                { stdio: ["ignore", "ignore", "pipe"] },
            );
            let failure = "";
            child.stderr.on("data", (chunk: Buffer) => void (failure += chunk.toString()));
            let ended = false;
            child.once("exit", () => void (ended = true));
            const record = { port, closed: false };
            opened.push(record);
            for (let attempt = 0; attempt < 150; attempt++) {
                if (ended) throw new Error(`ssh -D ended: ${failure.trim().split("\n")[0] ?? ""}`);
                if (await probe(port)) {
                    return {
                        kind: "socks",
                        port,
                        close() {
                            record.closed = true;
                            child.kill();
                        },
                    };
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            child.kill();
            throw new Error("ssh -D did not open its port in time");
        },
    };
}
