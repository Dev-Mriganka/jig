// Secrets: references, the allowed backends, timeouts, and that no value ever leaks into an error or an output.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        for (const ref of ["env:BAD NAME", "env:1ABC", "env:A-B", "env:A=B"]) assert.equal(await code(secrets.resolve(ref)), "invalid_ref", ref);
    });
});

describe("the allowed backends", () => {
    test("the default is pass alone, so env is refused with a clear error", async () => {
        const redactor = createRedactor();
        const secrets = createSecrets({ backends: () => ["pass"], redactor, env: { X: "value" } });
        await assert.rejects(secrets.resolve("env:X"), (error: SecretError) => error.code === "backend_disabled" && /env secret backend is not enabled.*secrets\.backends/.test(error.message));
        assert.equal(redactor.count(), 0);
    });

    test("each backend is refused unless it is listed", async () => {
        const { secrets } = setup([], { run: async () => ok("never"), platform: "darwin" });
        for (const ref of ["pass:a/b", "env:X", "keychain:svc/acct", "op://vault/item/field"]) {
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
            await assert.rejects(secrets.resolve(ref), (error: SecretError) => error.code === "invalid_ref" && !error.message.includes(pasted));
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
            await assert.rejects(secrets.resolve(`pass:${entry}`), (error: SecretError) => !/leaked/.test(error.message));
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
        await assert.rejects(secrets.resolve("pass:hang/entry"), (error: SecretError) => error.code === "unavailable" && /did not answer/.test(error.message));
        assert.ok(Date.now() - started < 5000);
    });

    test("when pass is not installed the error says so", async () => {
        process.env.PATH = "/nonexistent-folder-for-jig";
        try {
            const { secrets } = setup(["pass"], { env });
            await assert.rejects(secrets.resolve("pass:work/token"), (error: SecretError) => error.code === "unavailable" && /pass could not run/.test(error.message));
        } finally {
            process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
        }
    });

    test("several lookups at the same moment run one after another, so a locked store is unlocked once", async () => {
        const { secrets } = setup(["pass"], { env });
        await Promise.all([secrets.resolve("pass:slow/entry"), secrets.resolve("pass:work/token"), secrets.resolve("pass:crlf/entry")]);
        const timing = readFileSync(`${log}.timing`, "utf8").trim().split("\n");
        // Each "start" is followed by its own "end" before the next "start".
        const kinds = timing.map((line) => line.split(" ")[0]);
        assert.deepEqual(kinds, ["start", "end", "start", "end", "start", "end"]);
    });

    test("callers asking for the same reference at the same moment share one lookup", async () => {
        const { secrets } = setup(["pass"], { env });
        const values = await Promise.all([1, 2, 3, 4, 5].map(() => secrets.resolve("pass:slow/entry")));
        assert.deepEqual(new Set(values), new Set(["slow-secret"]));
        assert.equal(readFileSync(`${log}.timing`, "utf8").split("\n").filter((line) => line.startsWith("start")).length, 1);
    });

    test("a failed lookup is not remembered", async () => {
        const { secrets } = setup(["pass"], { env });
        await code(secrets.resolve("pass:missing/entry"));
        await code(secrets.resolve("pass:missing/entry"));
        assert.equal(readFileSync(`${log}.timing`, "utf8").split("\n").filter((line) => line.startsWith("start")).length, 2);
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
        assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [["security", "find-generic-password", "-s", "my.service", "-a", "me@example.com", "-w"]]);
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
        await assert.rejects(secrets.resolve("keychain:svc/acct"), (error: SecretError) => error.code === "unavailable" && /needs macOS/.test(error.message));
        assert.equal(calls.length, 0);
    });

    test("a reference without both parts, with a leading dash or a control character, is refused", async () => {
        const { calls, run } = fake();
        const { secrets } = setup(["keychain"], { run, platform: "darwin" });
        for (const ref of ["keychain:service-only", "keychain:/acct", "keychain:svc/", "keychain:-s/acct", "keychain:svc/-a", "keychain:svc/a\u0007b"]) {
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", JSON.stringify(ref));
        }
        assert.equal(calls.length, 0);
    });

    test("an item that is not there, or a locked keychain, is an error without text from the command", async () => {
        const { run } = fake("leaked-keychain-output\n", 44);
        const { secrets } = setup(["keychain"], { run, platform: "darwin" });
        await assert.rejects(secrets.resolve("keychain:svc/acct"), (error: SecretError) => error.code === "missing" && !error.message.includes("leaked"));
    });
});

describe("the op backend (1Password)", () => {
    test("reads the reference with `op read`, and passes the OP_ variables and no others", async () => {
        const calls: Array<{ file: string; args: readonly string[]; options?: RunOptions }> = [];
        const run: FakeRun = async (file, args, options) => {
            calls.push({ file, args, ...(options === undefined ? {} : { options }) });
            return ok("op-secret\n");
        };
        const { secrets, redactor } = setup(["op"], { run, env: { OP_SERVICE_ACCOUNT_TOKEN: "service-token", UNRELATED: "x" } });
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
        for (const ref of ["op://", "op://vault", "op://vault/item", "op://vault/item/a b", "op://vault//field", "op://a/b/c/d/e"]) {
            assert.equal(await code(secrets.resolve(ref)), "invalid_ref", ref);
        }
    });

    test("a failed read is an error without text from the command", async () => {
        const run: FakeRun = async () => ({ code: 1, stdout: "", stderr: "[ERROR] leaked-op-output", timedOut: false });
        const { secrets } = setup(["op"], { run });
        await assert.rejects(secrets.resolve("op://vault/item/field"), (error: SecretError) => error.code === "missing" && !error.message.includes("leaked"));
    });

    test("a program that cannot start, or takes too long, is unavailable", async () => {
        const missing: FakeRun = async () => { throw new Error("op is not installed or not on PATH"); };
        await assert.rejects(setup(["op"], { run: missing }).secrets.resolve("op://vault/item/field"), (error: SecretError) => error.code === "unavailable" && /op could not run/.test(error.message));
        const slow: FakeRun = async () => ({ code: 124, stdout: "", stderr: "", timedOut: true });
        await assert.rejects(setup(["op"], { run: slow, timeoutMs: 5000 }).secrets.resolve("op://vault/item/field"), (error: SecretError) => error.code === "unavailable" && /did not answer in 5 s/.test(error.message));
    });
});
