// Secrets: references, the allowed backends, timeouts, and that no value ever leaks into an error or an output.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type { RunOptions, RunResult } from "../src/contract.ts";
import { createRedactor, REDACTED } from "../src/redact.ts";
import { createSecrets, SecretError } from "../src/secrets.ts";
import type { SecretsOptions } from "../src/secrets.ts";

type FakeRun = NonNullable<SecretsOptions["run"]>;

/** A secrets resolver with the given backends, a fresh redactor and, unless given, the real program runner. */
function setup(backends: string[], extra: Partial<SecretsOptions> = {}) {
    const redactor = createRedactor();
    return { redactor, secrets: createSecrets({ backends: () => backends, redactor, ...extra }) };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof SecretError, String(error));
        return error.code;
    }
    return assert.fail("expected the call to fail");
}

describe("the env backend", () => {
    const env = { MY_SECRET: "env-secret-value", EMPTY: "" };

    test("reads an environment variable of the Pi process, and hides it from output from then on", async () => {
        const { secrets, redactor } = setup(["env"], { env });
        assert.equal(redactor.text("env-secret-value"), "env-secret-value", "not known before it is resolved");
        assert.equal(await secrets.resolve("env:MY_SECRET"), "env-secret-value");
        assert.equal(redactor.text("the value is env-secret-value"), `the value is ${REDACTED}`);
    });

    test("a variable that is missing or empty is an error that does not hold a value", async () => {
        const { secrets } = setup(["env"], { env });
        assert.equal(await code(secrets.resolve("env:NOT_SET")), "missing");
        assert.equal(await code(secrets.resolve("env:EMPTY")), "missing");
    });

    test("a name that is not a variable name is refused", async () => {
        const { secrets } = setup(["env"], { env });
        for (const ref of ["env:BAD NAME", "env:1ABC", "env:A-B", "env:A=B"])
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", ref);
    });
});

describe("the allowed backends", () => {
    test("the default is pass alone, so env is refused with a clear error", async () => {
        const redactor = createRedactor();
        const secrets = createSecrets({ backends: () => ["pass"], redactor, env: { X: "value" } });
        await assert.rejects(
            secrets.resolve("env:X"),
            (error: SecretError) =>
                error.code === "backend_disabled" &&
                /env secret backend is not enabled.*secrets\.backends/.test(error.message),
        );
        assert.equal(redactor.count(), 0);
    });

    test("a backend the user turned off says so, and one that was never on says how to turn it on", async () => {
        const secrets = createSecrets({
            backends: () => ["pass"],
            disabled: () => ["env"],
            redactor: createRedactor(),
            env: { X: "value" },
        });
        await assert.rejects(secrets.resolve("env:X"), /you turned it off in secrets\.disabledBackends in jig\.json/);
        await assert.rejects(secrets.resolve("file:/tmp/x"), /add "file" to secrets\.backends in jig\.json/);
    });

    test("each backend is refused unless it is listed", async () => {
        const { secrets } = setup([], { run: async () => ok("never"), platform: "darwin" });
        for (const ref of [
            "pass:a/b",
            "env:X",
            "keychain:svc/acct",
            "op://vault/item/field",
            "cmd:gh",
            "file:/tmp/x",
        ]) {
            assert.equal(await code(secrets.resolve(ref)), "backend_disabled", ref);
        }
    });

    test("the list is read at every call, so a configuration reload applies", async () => {
        let backends: string[] = [];
        const redactor = createRedactor();
        const secrets = createSecrets({ backends: () => backends, redactor, env: { X: "value" } });
        assert.equal(await code(secrets.resolve("env:X")), "backend_disabled");
        backends = ["env"];
        assert.equal(await secrets.resolve("env:X"), "value");
    });

    test("something that is not a reference is refused, and the error does not repeat it", async () => {
        const { secrets } = setup(["pass", "env"]);
        const pasted = "gh" + "p_PretendThisIsAPastedSecretValue";
        for (const ref of [pasted, "vault:thing", "pass:", "env:", "", "https://example.com"]) {
            await assert.rejects(
                secrets.resolve(ref),
                (error: SecretError) => error.code === "invalid_ref" && !error.message.includes(pasted),
            );
        }
        await assert.rejects(secrets.resolve(42 as unknown as string), SecretError);
    });
});

describe("the pass backend, through a fake pass program", () => {
    let bin: string;
    let log: string;
    const savedPath = process.env.PATH;

    before(() => {
        bin = mkdtempSync(path.join(tmpdir(), "jig-pass-"));
        log = path.join(bin, "calls.log");
        const script = `#!/bin/sh
echo "args: $*" >> "${log}"
echo "store: $PASSWORD_STORE_DIR other: $JIG_NOT_FORWARDED" >> "${log}"
echo "start $1 $2" >> "${log}.timing"
case "$2" in
  work/token) printf 'pass-secret-token\\nsecond line\\n' ;;
  crlf/entry) printf 'crlf-secret\\r\\nnotes\\r\\n' ;;
  empty/entry) printf '\\n' ;;
  slow/entry) sleep 0.4; printf 'slow-secret\\n' ;;
  hang/entry) sleep 30 ;;
  missing/entry) echo "Error: missing/entry is not in the password store." >&2; exit 1 ;;
  locked/entry) echo "gpg: decryption failed: No secret key" >&2; echo "pinentry not available: leaked-in-stderr-123" >&2; exit 2 ;;
  broken/entry) echo "something odd with leaked-value-456" >&2; exit 3 ;;
esac
echo "end $1 $2" >> "${log}.timing"
`;
        writeFileSync(path.join(bin, "pass"), script);
        chmodSync(path.join(bin, "pass"), 0o755);
        process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    });
    after(() => {
        process.env.PATH = savedPath;
        rmSync(bin, { recursive: true, force: true });
    });
    afterEach(() => {
        rmSync(log, { force: true });
        rmSync(`${log}.timing`, { force: true });
    });

    const env = { PASSWORD_STORE_DIR: "/the/store", JIG_NOT_FORWARDED: "secret-from-pi-env" };

    test("returns the first line of the entry, and registers it for redaction", async () => {
        const { secrets, redactor } = setup(["pass"], { env });
        assert.equal(await secrets.resolve("pass:work/token"), "pass-secret-token");
        assert.equal(redactor.text("leak: pass-secret-token"), `leak: ${REDACTED}`);
        assert.equal(redactor.text("second line"), "second line", "only the first line is the secret");
    });

    test("runs `pass show <entry>` from an argument list, with the store folder and none of Pi's other variables", async () => {
        const { secrets } = setup(["pass"], { env });
        await secrets.resolve("pass:work/token");
        const calls = readFileSync(log, "utf8");
        assert.match(calls, /^args: show work\/token$/m);
        assert.match(calls, /^store: \/the\/store other: $/m);
    });

    test("a line ending of CR LF is not part of the value", async () => {
        const { secrets } = setup(["pass"], { env });
        assert.equal(await secrets.resolve("pass:crlf/entry"), "crlf-secret");
    });

    test("an empty entry, a missing entry, a locked store and a broken pass each have their own error", async () => {
        const { secrets } = setup(["pass"], { env });
        assert.equal(await code(secrets.resolve("pass:empty/entry")), "missing");
        assert.equal(await code(secrets.resolve("pass:missing/entry")), "missing");
        assert.equal(await code(secrets.resolve("pass:locked/entry")), "locked");
        assert.equal(await code(secrets.resolve("pass:broken/entry")), "unavailable");
    });

    test("an error never repeats what pass printed", async () => {
        const { secrets } = setup(["pass"], { env });
        for (const entry of ["locked/entry", "broken/entry"]) {
            await assert.rejects(
                secrets.resolve(`pass:${entry}`),
                (error: SecretError) => !/leaked/.test(error.message),
            );
        }
    });

    test("an entry name that could be read as an option or a path is refused before pass runs", async () => {
        const { secrets } = setup(["pass"], { env });
        for (const entry of ["../outside", "a/../b", "a//b", "/abs", "-x", "--help", "a b", "a;b", "a\nb", "a/.", ""]) {
            assert.equal(await code(secrets.resolve(`pass:${entry}`)), "invalid_ref", JSON.stringify(entry));
        }
        assert.throws(() => readFileSync(log, "utf8"), "pass never ran");
    });

    test("a pass that takes too long is stopped", async () => {
        const { secrets } = setup(["pass"], { env, timeoutMs: 300 });
        const started = Date.now();
        await assert.rejects(
            secrets.resolve("pass:hang/entry"),
            (error: SecretError) => error.code === "unavailable" && /did not answer/.test(error.message),
        );
        assert.ok(Date.now() - started < 5000);
    });

    test("when pass is not installed the error says so", async () => {
        process.env.PATH = "/nonexistent-folder-for-jig";
        try {
            const { secrets } = setup(["pass"], { env });
            await assert.rejects(
                secrets.resolve("pass:work/token"),
                (error: SecretError) => error.code === "unavailable" && /pass could not run/.test(error.message),
            );
        } finally {
            process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
        }
    });

    test("several lookups at the same moment run one after another, so a locked store is unlocked once", async () => {
        const { secrets } = setup(["pass"], { env });
        await Promise.all([
            secrets.resolve("pass:slow/entry"),
            secrets.resolve("pass:work/token"),
            secrets.resolve("pass:crlf/entry"),
        ]);
        const timing = readFileSync(`${log}.timing`, "utf8").trim().split("\n");
        // Each "start" is followed by its own "end" before the next "start".
        const kinds = timing.map((line) => line.split(" ")[0]);
        assert.deepEqual(kinds, ["start", "end", "start", "end", "start", "end"]);
    });

    test("callers asking for the same reference at the same moment share one lookup", async () => {
        const { secrets } = setup(["pass"], { env });
        const values = await Promise.all([1, 2, 3, 4, 5].map(() => secrets.resolve("pass:slow/entry")));
        assert.deepEqual(new Set(values), new Set(["slow-secret"]));
        assert.equal(
            readFileSync(`${log}.timing`, "utf8")
                .split("\n")
                .filter((line) => line.startsWith("start")).length,
            1,
        );
    });

    test("a failed lookup is not remembered", async () => {
        const { secrets } = setup(["pass"], { env });
        await code(secrets.resolve("pass:missing/entry"));
        await code(secrets.resolve("pass:missing/entry"));
        assert.equal(
            readFileSync(`${log}.timing`, "utf8")
                .split("\n")
                .filter((line) => line.startsWith("start")).length,
            2,
        );
    });
});

describe("the keychain backend (macOS)", () => {
    function fake(stdout = "kc-secret\n", code = 0) {
        const calls: Array<{ file: string; args: readonly string[]; options?: RunOptions }> = [];
        const run: FakeRun = async (file, args, options) => {
            calls.push({ file, args, ...(options === undefined ? {} : { options }) });
            return { code, stdout, stderr: "", timedOut: false };
        };
        return { calls, run };
    }

    test("asks the security command for the service and account, and strips the final newline", async () => {
        const { calls, run } = fake();
        const { secrets, redactor } = setup(["keychain"], { run, platform: "darwin" });
        assert.equal(await secrets.resolve("keychain:my.service/me@example.com"), "kc-secret");
        assert.deepEqual(
            calls.map((c) => [c.file, ...c.args]),
            [["security", "find-generic-password", "-s", "my.service", "-a", "me@example.com", "-w"]],
        );
        assert.equal(redactor.text("kc-secret"), REDACTED);
    });

    test("the part before the first slash is the service, and the rest is the account", async () => {
        const { calls, run } = fake();
        const { secrets } = setup(["keychain"], { run, platform: "darwin" });
        await secrets.resolve("keychain:svc/team/user");
        assert.deepEqual(calls[0]?.args.slice(2, 6), ["svc", "-a", "team/user", "-w"].slice(0, 4));
    });

    test("is refused on another system", async () => {
        const { calls, run } = fake();
        const { secrets } = setup(["keychain"], { run, platform: "linux" });
        await assert.rejects(
            secrets.resolve("keychain:svc/acct"),
            (error: SecretError) => error.code === "unavailable" && /needs macOS/.test(error.message),
        );
        assert.equal(calls.length, 0);
    });

    test("a reference without both parts, with a leading dash or a control character, is refused", async () => {
        const { calls, run } = fake();
        const { secrets } = setup(["keychain"], { run, platform: "darwin" });
        for (const ref of [
            "keychain:service-only",
            "keychain:/acct",
            "keychain:svc/",
            "keychain:-s/acct",
            "keychain:svc/-a",
            "keychain:svc/a\u0007b",
        ]) {
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", JSON.stringify(ref));
        }
        assert.equal(calls.length, 0);
    });

    test("an item that is not there, or a locked keychain, is an error without text from the command", async () => {
        const { run } = fake("leaked-keychain-output\n", 44);
        const { secrets } = setup(["keychain"], { run, platform: "darwin" });
        await assert.rejects(
            secrets.resolve("keychain:svc/acct"),
            (error: SecretError) => error.code === "missing" && !error.message.includes("leaked"),
        );
    });
});

describe("the op backend (1Password)", () => {
    test("reads the reference with `op read`, and passes the OP_ variables and no others", async () => {
        const calls: Array<{ file: string; args: readonly string[]; options?: RunOptions }> = [];
        const run: FakeRun = async (file, args, options) => {
            calls.push({ file, args, ...(options === undefined ? {} : { options }) });
            return ok("op-secret\n");
        };
        const { secrets, redactor } = setup(["op"], {
            run,
            env: { OP_SERVICE_ACCOUNT_TOKEN: "service-token", UNRELATED: "x" },
        });
        assert.equal(await secrets.resolve("op://Private/GitHub/token"), "op-secret");
        assert.deepEqual([calls[0]?.file, ...(calls[0]?.args ?? [])], ["op", "read", "op://Private/GitHub/token"]);
        assert.deepEqual(calls[0]?.options?.env, { OP_SERVICE_ACCOUNT_TOKEN: "service-token" });
        assert.equal(redactor.text("op-secret"), REDACTED);
    });

    test("a section in the reference is fine", async () => {
        const run: FakeRun = async () => ok("v\n");
        const { secrets } = setup(["op"], { run });
        assert.equal(await secrets.resolve("op://vault/item/section/field"), "v");
    });

    test("a reference that is not vault, item and field is refused", async () => {
        const run: FakeRun = async () => ok("never\n");
        const { secrets } = setup(["op"], { run });
        for (const ref of [
            "op://",
            "op://vault",
            "op://vault/item",
            "op://vault/item/a b",
            "op://vault//field",
            "op://a/b/c/d/e",
        ]) {
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", ref);
        }
    });

    test("a failed read is an error without text from the command", async () => {
        const run: FakeRun = async () => ({ code: 1, stdout: "", stderr: "[ERROR] leaked-op-output", timedOut: false });
        const { secrets } = setup(["op"], { run });
        await assert.rejects(
            secrets.resolve("op://vault/item/field"),
            (error: SecretError) => error.code === "missing" && !error.message.includes("leaked"),
        );
    });

    test("a program that cannot start, or takes too long, is unavailable", async () => {
        const missing: FakeRun = async () => {
            throw new Error("op is not installed or not on PATH");
        };
        await assert.rejects(
            setup(["op"], { run: missing }).secrets.resolve("op://vault/item/field"),
            (error: SecretError) => error.code === "unavailable" && /op could not run/.test(error.message),
        );
        const slow: FakeRun = async () => ({ code: 124, stdout: "", stderr: "", timedOut: true });
        await assert.rejects(
            setup(["op"], { run: slow, timeoutMs: 5000 }).secrets.resolve("op://vault/item/field"),
            (error: SecretError) => error.code === "unavailable" && /did not answer in 5 s/.test(error.message),
        );
    });
});

describe("the cmd backend: a command declared by name", () => {
    const commands = { gh: ["gh", "auth", "token"], cloud: ["/usr/local/bin/cloud-token", "--audience", "orders-api"] };
    const calls: Array<{ file: string; args: readonly string[]; options: RunOptions | undefined }> = [];
    const runs =
        (result: Partial<RunResult> | (() => Promise<RunResult>)): FakeRun =>
        async (file, args, options) => {
            calls.push({ file, args, options });
            if (typeof result === "function") return result();
            return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
        };
    afterEach(() => {
        calls.length = 0;
    });

    test("runs the declared command with its arguments and no shell, and uses the trimmed output", async () => {
        const { secrets, redactor } = setup(["cmd"], {
            commands: () => commands,
            run: runs({ stdout: "  cmd-token-value\n\n" }),
        });
        assert.equal(await secrets.resolve("cmd:gh"), "cmd-token-value");
        assert.deepEqual([calls[0]?.file, calls[0]?.args], ["gh", ["auth", "token"]]);
        assert.equal(redactor.text("seen cmd-token-value"), `seen ${REDACTED}`, "hidden from output from then on");
        await secrets.resolve("cmd:cloud");
        assert.deepEqual(
            [calls[1]?.file, calls[1]?.args],
            ["/usr/local/bin/cloud-token", ["--audience", "orders-api"]],
        );
    });

    test("is off unless `cmd` is in secrets.backends", async () => {
        const { secrets } = setup(["pass", "env"], { commands: () => commands, run: runs({ stdout: "x" }) });
        await assert.rejects(
            secrets.resolve("cmd:gh"),
            (error: SecretError) =>
                error.code === "backend_disabled" && /add "cmd" to secrets\.backends/.test(error.message),
        );
        assert.equal(calls.length, 0);
    });

    test("a name that is not declared is refused, and its name is not repeated, so a model cannot slip in a command", async () => {
        const { secrets } = setup(["cmd"], { commands: () => commands, run: runs({ stdout: "x" }) });
        const pasted = "gh" + "p_PretendThisIsAPastedSecretValue";
        for (const ref of [
            "cmd:rm",
            "cmd:gh auth token",
            `cmd:${pasted}`,
            "cmd:../gh",
            "cmd:__proto__",
            "cmd:constructor",
            "cmd:GH",
        ]) {
            await assert.rejects(
                secrets.resolve(ref),
                (error: SecretError) =>
                    error.code === "invalid_ref" &&
                    /names no declared command \(declared: gh, cloud\)/.test(error.message) &&
                    !error.message.includes(pasted) &&
                    !error.message.includes("rm"),
                ref,
            );
        }
        assert.equal(calls.length, 0, "nothing ran");
    });

    test("with nothing declared, the error says so", async () => {
        const { secrets } = setup(["cmd"], { run: runs({ stdout: "x" }) });
        await assert.rejects(secrets.resolve("cmd:gh"), /none is declared/);
    });

    test("the list is read at every call", async () => {
        let declared: Record<string, string[]> = {};
        const { secrets } = setup(["cmd"], { commands: () => declared, run: runs({ stdout: "x-value" }) });
        assert.equal(await code(secrets.resolve("cmd:gh")), "invalid_ref");
        declared = { gh: ["gh", "auth", "token"] };
        assert.equal(await secrets.resolve("cmd:gh"), "x-value");
    });

    test("a failing command is an error with its exit code only: its error output is never shown", async () => {
        const { secrets } = setup(["cmd"], {
            commands: () => commands,
            run: runs({ code: 4, stdout: "partial-token-value", stderr: "error: token is cmd-leaked-value" }),
        });
        await assert.rejects(secrets.resolve("cmd:gh"), (error: SecretError) => {
            assert.equal(error.code, "unavailable");
            assert.equal(error.message, 'the command "gh" failed with exit code 4');
            assert.ok(!/leaked|partial/.test(error.message));
            return true;
        });
    });

    test("an empty output, and an output over 16 KiB, are refused", async () => {
        const empty = setup(["cmd"], { commands: () => commands, run: runs({ stdout: " \n" }) });
        assert.equal(await code(empty.secrets.resolve("cmd:gh")), "missing");
        const exact = setup(["cmd"], { commands: () => commands, run: runs({ stdout: `${"a".repeat(16 * 1024)}\n` }) });
        assert.equal((await exact.secrets.resolve("cmd:gh")).length, 16 * 1024, "16 KiB, trimmed, is fine");
        const big = setup(["cmd"], { commands: () => commands, run: runs({ stdout: "a".repeat(16 * 1024 + 1) }) });
        await assert.rejects(big.secrets.resolve("cmd:gh"), (error: SecretError) => {
            assert.equal(error.code, "invalid_ref");
            assert.ok(!error.message.includes("aaaa"));
            return true;
        });
    });

    test("asks the runner to stop reading after 16 KiB, with the same timeout as the other backends", async () => {
        const { secrets } = setup(["cmd"], {
            commands: () => commands,
            run: runs({ stdout: "token-value" }),
            timeoutMs: 5000,
        });
        await secrets.resolve("cmd:gh");
        assert.equal(calls[0]?.options?.maxOutputBytes, 16 * 1024 + 1);
        assert.equal(calls[0]?.options?.timeoutMs, 5000);
        const defaults = setup(["cmd"], { commands: () => commands, run: runs({ stdout: "token-value" }) });
        await defaults.secrets.resolve("cmd:gh");
        assert.equal(calls[1]?.options?.timeoutMs, 60_000);
    });

    test("a command that does not answer in time, and one that cannot start, are errors that name the command only", async () => {
        const slow = setup(["cmd"], {
            commands: () => commands,
            run: runs({ timedOut: true, code: 124 }),
            timeoutMs: 3000,
        });
        await assert.rejects(
            slow.secrets.resolve("cmd:gh"),
            /^SecretError: gh did not answer in 3 s$|gh did not answer in 3 s/,
        );
        const missing = setup(["cmd"], {
            commands: () => commands,
            run: async () => {
                throw new Error("gh is not installed or not on PATH");
            },
        });
        await assert.rejects(
            missing.secrets.resolve("cmd:gh"),
            (error: SecretError) => error.code === "unavailable" && /gh could not run/.test(error.message),
        );
    });

    test("passes a short environment: where a keyring shows its prompt and where tools keep their configuration, not tokens", async () => {
        const env = {
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
            GH_CONFIG_DIR: "/home/u/gh",
            GH_TOKEN: "must-not-pass",
            PATH: "/usr/bin",
        };
        const { secrets } = setup(["cmd"], { commands: () => commands, run: runs({ stdout: "token-value" }), env });
        await secrets.resolve("cmd:gh");
        assert.deepEqual(calls[0]?.options?.env, {
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
            GH_CONFIG_DIR: "/home/u/gh",
        });
    });

    test("callers that ask at once share one run", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { secrets } = setup(["cmd"], {
            commands: () => commands,
            run: runs(async () => {
                await gate;
                return ok("shared-value");
            }),
        });
        const both = Promise.all([secrets.resolve("cmd:gh"), secrets.resolve("cmd:gh")]);
        release();
        assert.deepEqual(await both, ["shared-value", "shared-value"]);
        assert.equal(calls.length, 1);
    });
});

describe("the file backend: the first line of a file", () => {
    let root: string;
    let home: string;
    let agent: string;
    before(() => {
        root = mkdtempSync(path.join(tmpdir(), "jig-file-secret-"));
        home = path.join(root, "home");
        agent = path.join(home, ".pi", "agent");
        for (const dir of [path.join(home, ".config", "tool"), agent, path.join(root, "outside")]) {
            mkdirSync(dir, { recursive: true });
        }
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    const file = (name: string, content: string | Buffer, mode?: number) => {
        const target = path.join(root, name);
        writeFileSync(target, content);
        if (mode !== undefined) chmodSync(target, mode);
        return target;
    };

    test("reads the first line, trimmed, from an absolute path, and hides the value from output from then on", async () => {
        const { secrets, redactor } = setup(["file"], { home, agentDir: () => agent });
        const target = file("token.txt", "  file-token-value  \r\nsecond line is ignored\n");
        assert.equal(await secrets.resolve(`file:${target}`), "file-token-value");
        assert.equal(redactor.text("seen file-token-value"), `seen ${REDACTED}`);
    });

    test("a leading ~/ is the home folder", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        writeFileSync(path.join(home, ".config", "tool", "token"), "home-file-token\n");
        assert.equal(await secrets.resolve("file:~/.config/tool/token"), "home-file-token");
    });

    test("is off unless `file` is in secrets.backends", async () => {
        const { secrets } = setup(["pass"], { home, agentDir: () => agent });
        const target = file("off.txt", "off-value");
        await assert.rejects(
            secrets.resolve(`file:${target}`),
            (error: SecretError) =>
                error.code === "backend_disabled" && /add "file" to secrets\.backends/.test(error.message),
        );
    });

    test("does not look at permission bits: a file on a Windows drive under WSL shows 0777", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        assert.equal(await secrets.resolve(`file:${file("open.txt", "wide-open-value", 0o777)}`), "wide-open-value");
        assert.equal(
            await secrets.resolve(`file:${file("closed.txt", "owner-only-value", 0o600)}`),
            "owner-only-value",
        );
    });

    test("a relative path is refused, and so is a path with a control character", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        for (const ref of [
            "file:token.txt",
            "file:./token.txt",
            "file:~other/token",
            "file:../x",
            "file:/tmp/a\u0000b",
            "file:/tmp/a\nb",
        ]) {
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", JSON.stringify(ref));
        }
    });

    test("a file that is missing, a folder, an empty file and a blank first line are refused, without the content", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        assert.equal(await code(secrets.resolve(`file:${path.join(root, "nothing-here")}`)), "missing");
        assert.equal(await code(secrets.resolve(`file:${path.join(root, "outside")}`)), "invalid_ref");
        assert.equal(await code(secrets.resolve(`file:${file("empty.txt", "")}`)), "missing");
        await assert.rejects(
            secrets.resolve(`file:${file("blank.txt", "\n   \nreal-value-on-line-three\n")}`),
            (error: SecretError) => {
                assert.equal(error.code, "missing");
                assert.ok(!error.message.includes("real-value"));
                return true;
            },
        );
    });

    test("a file larger than 64 KiB is refused", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        const exact = file("exact.txt", `exact-value\n${"x".repeat(64 * 1024 - 12)}`);
        assert.equal(await secrets.resolve(`file:${exact}`), "exact-value", "64 KiB is allowed");
        const big = file("big.txt", `big-value\n${"x".repeat(64 * 1024)}`);
        await assert.rejects(secrets.resolve(`file:${big}`), (error: SecretError) => {
            assert.equal(error.code, "invalid_ref");
            assert.ok(!error.message.includes("big-value"));
            return true;
        });
    });

    test("nothing in Pi's agent folder can be read, not by its name, not through ~, not through a link", async () => {
        const { secrets } = setup(["file"], { home, agentDir: () => agent });
        const login = path.join(agent, "auth.json");
        writeFileSync(login, "agent-login-value\n");
        writeFileSync(path.join(agent, "jig.json"), "agent-config-value\n");
        mkdirSync(path.join(agent, "deeper"), { recursive: true });
        writeFileSync(path.join(agent, "deeper", "x"), "agent-deep-value\n");
        const link = path.join(root, "outside", "link-to-login");
        symlinkSync(login, link);
        const folderLink = path.join(root, "outside", "link-to-agent");
        symlinkSync(agent, folderLink);
        for (const ref of [
            `file:${login}`,
            "file:~/.pi/agent/auth.json",
            `file:${path.join(agent, "deeper", "x")}`,
            `file:${path.join(agent, "..", "agent", "jig.json")}`,
            `file:${link}`,
            `file:${folderLink}/auth.json`,
        ]) {
            await assert.rejects(
                secrets.resolve(ref),
                (error: SecretError) =>
                    error.code === "invalid_ref" &&
                    /agent folder/.test(error.message) &&
                    !/agent-(login|config|deep)-value/.test(error.message),
                ref,
            );
        }
    });

    test("with no agent folder known, the other checks still apply", async () => {
        const { secrets } = setup(["file"], { home });
        assert.equal(await secrets.resolve(`file:${file("no-agent.txt", "no-agent-value")}`), "no-agent-value");
    });
});
