// `/sandbox doctor`: each requirement, then real commands in the real sandbox that prove it works.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatDoctor, runDoctor } from "../src/doctor.ts";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { makeWorld } from "./support/world.ts";

const skip = skipUnlessRealSandbox();

describe("the doctor, with the real sandbox", { skip }, () => {
    test("in open mode every check passes: a write, a hidden read, a locked write, the environment, a lookup, localhost, sockets", async () => {
        const world = await makeWorld();
        try {
            // `localhost` stands in for the name: the doctor is the one place a real name is looked up, and a test must not.
            const lines = await runDoctor(world.sandbox, {
                cwd: world.project,
                platform: "linux",
                lookupName: "localhost",
            });
            const failed = lines.filter((line) => !line.ok);
            assert.deepEqual(failed, [], formatDoctor(lines).join("\n"));
            const checks = lines.map((line) => line.check);
            for (const wanted of [
                "platform",
                "program bwrap",
                "program socat",
                "program rg",
                "start",
                "network mode",
                "a write in the working folder",
                "a hidden file cannot be read",
                "a locked file cannot be written",
                "a credential variable is not passed on",
                "a name lookup (localhost)",
                "a connection to localhost",
                "a Unix socket cannot be made",
                "a new user namespace cannot be made",
            ]) {
                assert.ok(checks.includes(wanted), `${wanted} is checked`);
            }
            assert.deepEqual(formatDoctor(lines).at(-1), "All checks passed: the sandbox works.");
            assert.deepEqual(
                world.sandbox.rulesFor(world.project).rules.filter((rule) => rule.path.includes("hidden-probe")),
                [],
                "the doctor's probe files are not part of the rules",
            );
        } finally {
            await world.cleanup();
        }
    });

    test("a deny list in the open mode is a warning line, not a failed check", async () => {
        const world = await makeWorld({
            settings: (base) => ({ ...base, network: { ...base.network, deny: ["mongo.prod.example.com"] } }),
        });
        try {
            const lines = await runDoctor(world.sandbox, {
                cwd: world.project,
                platform: "linux",
                lookupName: "localhost",
            });
            const warning = lines.find((line) => line.check === "network.deny");
            assert.equal(warning?.ok, true, "it is not a failure");
            assert.match(
                warning?.detail ?? "",
                /^WARNING: sandbox\.network\.deny \(mongo\.prod\.example\.com\) does nothing in the open network mode/,
            );
            assert.deepEqual(formatDoctor(lines).at(-1), "All checks passed: the sandbox works.");
        } finally {
            await world.cleanup();
        }
    });

    test("in off mode the lookup and the connection to localhost must fail, and do", async () => {
        const world = await makeWorld({ settings: (base) => ({ ...base, network: { ...base.network, mode: "off" } }) });
        try {
            const lines = await runDoctor(world.sandbox, {
                cwd: world.project,
                platform: "linux",
                lookupName: "doctor-test.invalid",
            });
            assert.deepEqual(
                lines.filter((line) => !line.ok),
                [],
                formatDoctor(lines).join("\n"),
            );
            assert.match(
                lines.find((line) => line.check.startsWith("a connection to localhost"))?.detail ?? "",
                /refused, as the network is off/,
            );
        } finally {
            await world.cleanup();
        }
    });

    test("it leaves nothing in the working folder", async () => {
        const world = await makeWorld();
        try {
            const { readdirSync } = await import("node:fs");
            const before = readdirSync(world.project).sort();
            await runDoctor(world.sandbox, { cwd: world.project, platform: "linux", lookupName: "localhost" });
            assert.deepEqual(readdirSync(world.project).sort(), before);
        } finally {
            await world.cleanup();
        }
    });
});

describe("the doctor, when the sandbox cannot run", () => {
    test("a platform without a sandbox stops after saying so", async () => {
        const { Sandbox } = await import("../src/sandbox.ts");
        const sandbox = new Sandbox({} as never);
        const lines = await runDoctor(sandbox, { cwd: "/", platform: "win32" });
        assert.equal(lines.length, 1);
        assert.equal(lines[0]?.ok, false);
        assert.match(
            formatDoctor(lines).join("\n"),
            /FAIL platform: win32 is not supported yet; Linux, WSL2 and macOS are\n1 check failed\./,
        );
    });
});
