// What jig-core gains for a sandbox around `bash`: the protected paths as a list, a place to register the sandbox, a line in
// `/jig` and at session start that says whether bash is sandboxed, and a refusal to run a program the sandbox lets bash write.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SandboxProvider } from "../src/contract.ts";
import { ExecError, resolveProgram } from "../src/exec.ts";
import { start } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { tempState } from "./support/state.ts";

const state = tempState();
beforeEach(() => state.start());
afterEach(() => state.stop());

let h: Harness | undefined;
afterEach(async () => {
    await h?.shutdown();
    h = undefined;
});

/** A sandbox that lets bash write inside one folder (or nowhere), and says what it is told to. */
function provider(over: Partial<SandboxProvider> & { writes?: string } = {}): SandboxProvider {
    const { writes, ...rest } = over;
    return {
        active: true,
        mode: "open",
        canWrite: (place) => writes !== undefined && (place === writes || place.startsWith(`${writes}${path.sep}`)),
        ...rest,
    };
}

async function statusText(harness: Harness): Promise<string> {
    const before = harness.ui.notifications.length;
    await harness.host.commands.get("jig")?.handler("", harness.ctx as never);
    return harness.ui.notifications
        .slice(before)
        .map((item) => item.message)
        .join("\n");
}

describe("protectedPaths.list", () => {
    test("every entry with its kind and where it came from", async () => {
        h = await start({ config: { protectedPaths: { secret: ["~/.my-vault"], guarded: ["/opt/shared-config"] } } });
        h.api.config.addProtectedPaths({ secret: ["/opt/company-tokens"] });
        const entries = h.api.protectedPaths.list();
        const find = (shown: string) => entries.find((entry) => entry.shown === shown || entry.path === shown);
        assert.equal(find("~/.ssh")?.kind, "secret");
        assert.equal(find("~/.ssh")?.source, "default");
        assert.equal(find("~/.my-vault")?.source, "personal");
        assert.equal(find("/opt/shared-config")?.kind, "guarded");
        assert.equal(find("/opt/shared-config")?.source, "personal");
        assert.equal(find("/opt/company-tokens")?.source, "company");
        assert.ok(
            entries.some((entry) => entry.kind === "guarded" && entry.path === h?.agentDir),
            "the agent folder is guarded",
        );
        assert.ok(entries.every((entry) => path.isAbsolute(entry.path) && entry.shown !== ""));
    });

    test("changing the list that comes back changes nothing inside jig-core", async () => {
        h = await start();
        const first = h.api.protectedPaths.list();
        (first as unknown as Array<{ path: string }>)[0] = { path: "/changed" };
        assert.notEqual(h.api.protectedPaths.list()[0]?.path, "/changed");
    });
});

describe("saying whether bash is sandboxed", () => {
    test("without a sandbox, /jig says so plainly, and so does session start", async () => {
        h = await start();
        assert.match(
            await statusText(h),
            /bash: NOT sandboxed\. No sandbox is registered, so a shell command can read your credentials/,
        );
        const started = h.ui.notifications.find((item) => item.message.startsWith("bash: NOT sandboxed"));
        assert.ok(started, "a notice at session start");
        assert.equal(started.type, "warning");
    });

    test("with a sandbox, /jig names the network mode, and session start says it once the sandbox is ready", async () => {
        h = await start({
            plugins: (api) => api.sandbox.register({ ...provider({ mode: "off" }), whenReady: async () => undefined }),
        });
        assert.match(await statusText(h), /bash: sandboxed, network off/);
        await new Promise((resolve) => setImmediate(resolve));
        const started = h.ui.notifications.find((item) => item.message.startsWith("bash: sandboxed"));
        assert.equal(started?.message, "bash: sandboxed, network off");
        assert.equal(started?.type, "info");
    });

    test("a sandbox that is not active says why", async () => {
        h = await start({
            plugins: (api) =>
                api.sandbox.register(
                    provider({ active: false, note: "switched off for this session with /sandbox off" }),
                ),
        });
        assert.match(await statusText(h), /bash: NOT sandboxed: switched off for this session with \/sandbox off/);
        assert.equal(
            h.ui.notifications.find((item) => item.message.startsWith("bash: NOT sandboxed"))?.type,
            "warning",
        );
    });

    test("the line follows the sandbox as it changes", async () => {
        const live = provider();
        h = await start({ plugins: (api) => api.sandbox.register(live) });
        assert.match(await statusText(h), /bash: sandboxed, network open/);
        (live as { active: boolean }).active = false;
        assert.match(await statusText(h), /bash: NOT sandboxed/);
    });

    test("a provider that throws does not break /jig", async () => {
        const broken = {
            get active(): boolean {
                throw new Error("boom");
            },
            canWrite: () => true,
        };
        h = await start({ plugins: (api) => api.sandbox.register(broken as never) });
        assert.match(await statusText(h), /bash: the sandbox did not say whether it is on/);
    });

    test("without a screen there is nothing to notify", async () => {
        h = await start({ ui: false });
        assert.equal(h.ui.notifications.length, 0);
    });

    test("a provider that cannot write is refused when it registers", async () => {
        h = await start();
        assert.throws(() => h?.api.sandbox.register({ active: true } as never), /canWrite function/);
    });
});

describe("a program the sandbox lets bash write is not one to run", () => {
    let dir: string;
    let writable: string;
    let system: string;
    let work: string;
    const saved = process.env.PATH;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-sandbox-exec-")));
        writable = path.join(dir, "home-bin");
        system = path.join(dir, "system-bin");
        for (const folder of [writable, system]) {
            mkdirSync(folder);
            writeFileSync(path.join(folder, "tool"), "#!/bin/sh\necho ran-$(basename $(dirname $0))\n");
            chmodSync(path.join(folder, "tool"), 0o755);
        }
        work = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-sandbox-work-")));
        process.env.PATH = `${writable}:${system}:${saved}`;
    });
    afterEach(() => {
        process.env.PATH = saved;
        rmSync(dir, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
    });

    test("a name found first in a folder the sandbox can write is skipped for the one in a folder it cannot", () => {
        assert.equal(
            resolveProgram("tool", work, { writable: (real) => real.startsWith(writable) }),
            path.join(system, "tool"),
        );
    });

    test("a program only in a writable folder is refused, and the message says where", () => {
        rmSync(path.join(system, "tool"));
        assert.throws(
            () => resolveProgram("tool", work, { writable: (real) => real.startsWith(writable) }),
            (error: unknown) => error instanceof ExecError && error.message.includes(writable),
        );
    });

    test("an absolute path in a writable place is refused", () => {
        assert.throws(
            () => resolveProgram(path.join(writable, "tool"), work, { writable: (real) => real.startsWith(writable) }),
            /a place the sandbox lets bash write/,
        );
        assert.equal(
            resolveProgram(path.join(system, "tool"), work, { writable: (real) => real.startsWith(writable) }),
            path.join(system, "tool"),
        );
    });

    test("a link in a system folder to a program in a writable place is refused by its real path", () => {
        symlinkSync(path.join(writable, "tool"), path.join(system, "linked"));
        assert.throws(
            () => resolveProgram("linked", work, { writable: (real) => real.startsWith(writable) }),
            ExecError,
        );
    });

    test("without a guard nothing changes", () => {
        assert.equal(resolveProgram("tool", work), path.join(writable, "tool"));
    });

    test("through the API, with a sandbox registered, the program in the writable folder does not run", async () => {
        h = await start({ plugins: (api) => api.sandbox.register(provider({ writes: writable })) });
        const result = await h.api.exec.run("tool", [], { cwd: work });
        assert.equal(result.stdout.trim(), "ran-system-bin");
    });

    test("the PATH the program gets has no folder the sandbox can write", async () => {
        h = await start({ plugins: (api) => api.sandbox.register(provider({ writes: writable })) });
        const result = await h.api.exec.run(process.execPath, ["-e", "console.log(process.env.PATH)"], { cwd: work });
        assert.ok(!result.stdout.split(path.delimiter).includes(writable), result.stdout);
        assert.ok(result.stdout.split(path.delimiter).includes(system));
    });

    test("a sandbox that is switched off does not refuse anything", async () => {
        h = await start({ plugins: (api) => api.sandbox.register(provider({ writes: writable, active: false })) });
        const result = await h.api.exec.run("tool", [], { cwd: work });
        assert.equal(result.stdout.trim(), "ran-home-bin");
    });

    test("a sandbox that cannot answer counts as one that lets bash write", async () => {
        const failing = provider({
            canWrite: () => {
                throw new Error("boom");
            },
        });
        h = await start({ plugins: (api) => api.sandbox.register(failing) });
        await assert.rejects(h.api.exec.run("tool", [], { cwd: work }), ExecError);
    });
});

describe("running a command in the sandbox for a plugin", () => {
    const here = { cwd: tmpdir() };
    const done = { code: 0, output: "ok\n", timedOut: false, truncated: false };

    test("canRun is false with no sandbox, with one that cannot run, and with one that is off", async () => {
        h = await start();
        assert.equal(h.api.sandbox.canRun, false);
        h.api.sandbox.register(provider());
        assert.equal(h.api.sandbox.canRun, false, "a provider without run is a sandbox for bash only");
        h.api.sandbox.register(provider({ run: async () => done, active: false }));
        assert.equal(h.api.sandbox.canRun, false);
        h.api.sandbox.register(provider({ run: async () => done }));
        assert.equal(h.api.sandbox.canRun, true);
    });

    test("a provider that cannot say whether it is active cannot run", async () => {
        const broken = provider({ run: async () => done });
        Object.defineProperty(broken, "active", {
            get() {
                throw new Error("boom");
            },
        });
        h = await start({ plugins: (api) => api.sandbox.register(broken) });
        assert.equal(h.api.sandbox.canRun, false);
    });

    test("run asks the provider, and gives back what it says", async () => {
        const asked: Array<{ command: string; cwd: string; timeoutMs?: number }> = [];
        h = await start({
            plugins: (api) =>
                api.sandbox.register(
                    provider({
                        run: async (command, options) => {
                            asked.push({
                                command,
                                cwd: options.cwd,
                                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                            });
                            return done;
                        },
                    }),
                ),
        });
        assert.deepEqual(await h.api.sandbox.run("npm test", { ...here, timeoutMs: 5000 }), done);
        assert.deepEqual(asked, [{ command: "npm test", cwd: here.cwd, timeoutMs: 5000 }]);
    });

    test("without a sandbox that can run, nothing runs anywhere: the call is refused", async () => {
        let asked = false;
        h = await start({
            plugins: (api) =>
                api.sandbox.register(
                    provider({
                        active: false,
                        run: async () => {
                            asked = true;
                            return done;
                        },
                    }),
                ),
        });
        await assert.rejects(h.api.sandbox.run("npm test", here), /no sandbox can run this command/);
        assert.equal(asked, false, "the provider is not asked when it is off");
        const bare = await start();
        await assert.rejects(bare.api.sandbox.run("npm test", here), /no sandbox can run this command/);
        await bare.shutdown();
    });

    test("the command, the folder and the time limit are checked before the provider is asked", async () => {
        let asked = 0;
        h = await start({
            plugins: (api) =>
                api.sandbox.register(
                    provider({
                        run: async () => {
                            asked++;
                            return done;
                        },
                    }),
                ),
        });
        const api = h.api.sandbox;
        await assert.rejects(api.run("", here), TypeError);
        await assert.rejects(api.run("a\0b", here), TypeError);
        await assert.rejects(api.run("true", { cwd: "relative/dir" }), /absolute/);
        await assert.rejects(api.run("true", { ...here, timeoutMs: 0 }), /timeoutMs/);
        await assert.rejects(api.run("true", { ...here, timeoutMs: 3 * 60 * 60 * 1000 }), /timeoutMs/);
        assert.equal(asked, 0);
    });
});
