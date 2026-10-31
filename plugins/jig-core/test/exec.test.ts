// Running programs: argument lists only, a minimal environment, timeouts and output caps, and the hardened git runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { ExecError, git, GIT_FIXED_FLAGS, run, TIMEOUT_CODE } from "../src/exec.ts";
import { forgetCheckedConfigs } from "../src/git-config-guard.ts";

const node = process.execPath;

describe("run", () => {
    test("runs a program and returns its exit code and output", async () => {
        const result = await run(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
        assert.deepEqual(result, { code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
    });

    test("passes arguments as they are: there is no shell", async () => {
        const nasty = "$(echo injected); `id` | cat > /dev/null && 'quoted' \"double\"";
        const result = await run(node, ["-e", "console.log(process.argv[1])", nasty]);
        assert.equal(result.stdout, `${nasty}\n`);
    });

    test("writes the input to the program's standard input", async () => {
        const result = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "from input" });
        assert.equal(result.stdout, "from input");
    });

    test("a program that never reads its input does not break the call", async () => {
        const result = await run(node, ["-e", "console.log('done')"], { input: "x".repeat(1_000_000) });
        assert.equal(result.stdout, "done\n");
    });

    test("runs in the working folder it is given", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jig-exec-"));
        try {
            const result = await run(node, ["-e", "console.log(process.cwd())"], { cwd: dir });
            assert.equal(result.stdout.trim(), execFileSync("realpath", [dir], { encoding: "utf8" }).trim());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    describe("the environment", () => {
        const saved = process.env.JIG_TEST_SECRET;
        before(() => {
            process.env.JIG_TEST_SECRET = "must-not-reach-the-child";
            process.env.GITHUB_TOKEN = "also-not";
        });
        after(() => {
            if (saved === undefined) delete process.env.JIG_TEST_SECRET;
            else process.env.JIG_TEST_SECRET = saved;
            delete process.env.GITHUB_TOKEN;
        });

        const printEnv = ["-e", "console.log(JSON.stringify(process.env))"];

        test("is a short allow-list, not Pi's whole environment", async () => {
            const env = JSON.parse((await run(node, printEnv)).stdout) as Record<string, string>;
            assert.ok(env.PATH !== undefined && env.HOME !== undefined);
            assert.equal(env.JIG_TEST_SECRET, undefined);
            assert.equal(env.GITHUB_TOKEN, undefined);
        });

        test("holds the variables the caller adds", async () => {
            const env = JSON.parse(
                (await run(node, printEnv, { env: { EXTRA: "1", HOME: "/elsewhere" } })).stdout,
            ) as Record<string, string>;
            assert.equal(env.EXTRA, "1");
            assert.equal(env.HOME, "/elsewhere", "the caller's value wins");
        });
    });

    describe("limits", () => {
        test("a program that takes too long is stopped, and the result says so", async () => {
            const started = Date.now();
            const result = await run(node, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 300 });
            assert.equal(result.timedOut, true);
            assert.equal(result.code, TIMEOUT_CODE);
            assert.ok(Date.now() - started < 5000);
        });

        test("the whole process group is stopped, not only the program", async () => {
            const result = await run("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 400 });
            assert.equal(result.timedOut, true);
            const pid = Number(result.stdout.trim());
            assert.ok(pid > 0, result.stdout);
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.throws(
                () => process.kill(pid, 0),
                (error: NodeJS.ErrnoException) => error.code === "ESRCH",
                "the grandchild is gone",
            );
        });

        test("output beyond the cap is cut, with a marker that says so", async () => {
            const result = await run(
                node,
                ["-e", "process.stdout.write('a'.repeat(10000)); process.stderr.write('b'.repeat(10000))"],
                { maxOutputBytes: 100 },
            );
            assert.equal(result.code, 0);
            assert.ok(result.stdout.startsWith("a".repeat(100)));
            assert.ok(result.stdout.length < 200);
            assert.match(result.stdout, /\[output cut at 100 bytes\]/);
            assert.match(result.stderr, /\[output cut at 100 bytes\]/);
        });

        test("output within the cap is not marked", async () => {
            const result = await run(node, ["-e", "process.stdout.write('a'.repeat(50))"], { maxOutputBytes: 100 });
            assert.equal(result.stdout, "a".repeat(50));
        });

        test("an aborted call is stopped and rejects", async () => {
            const controller = new AbortController();
            const pending = run(node, ["-e", "setTimeout(() => {}, 20000)"], { signal: controller.signal });
            setTimeout(() => controller.abort(), 150);
            await assert.rejects(
                pending,
                (error: Error) => error instanceof ExecError && /was aborted/.test(error.message),
            );
        });

        test("a call whose signal is already aborted does not start", async () => {
            const dir = mkdtempSync(path.join(tmpdir(), "jig-aborted-"));
            const marker = path.join(dir, "ran");
            try {
                const controller = new AbortController();
                controller.abort();
                await assert.rejects(
                    run(node, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], {
                        signal: controller.signal,
                    }),
                    ExecError,
                );
                await new Promise((resolve) => setTimeout(resolve, 200));
                assert.equal(existsSync(marker), false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe("what cannot run", () => {
        test("a program that is not installed", async () => {
            await assert.rejects(
                run("jig-no-such-program", []),
                (error: Error) => error instanceof ExecError && /not installed or not on PATH/.test(error.message),
            );
        });

        test("a relative path with a folder in it", async () => {
            await assert.rejects(run("./bin/tool", []), /program name or an absolute path/);
            await assert.rejects(run("bin/tool", []), /program name or an absolute path/);
        });

        test("a working folder that does not exist", async () => {
            await assert.rejects(
                run(node, ["-e", "1"], { cwd: "/nonexistent/folder/for/jig" }),
                /working folder \/nonexistent\/folder\/for\/jig does not exist/,
            );
        });
    });

    describe("a program planted where the agent can write", () => {
        let repo: string;
        const savedPath = process.env.PATH;
        before(() => {
            repo = mkdtempSync(path.join(tmpdir(), "jig-planted-"));
            mkdirSync(path.join(repo, "bin"));
            writeFileSync(path.join(repo, "bin", "planted-tool"), "#!/bin/sh\necho planted\n");
            chmodSync(path.join(repo, "bin", "planted-tool"), 0o755);
            process.env.PATH = `${path.join(repo, "bin")}${path.delimiter}${savedPath}${path.delimiter}relative/bin`;
        });
        after(() => {
            process.env.PATH = savedPath;
            rmSync(repo, { recursive: true, force: true });
        });

        test("is not run: a PATH folder inside the working folder is skipped", async () => {
            await assert.rejects(
                run("planted-tool", [], { cwd: repo }),
                (error: Error) =>
                    error instanceof ExecError && /only in .*bin, a folder the agent can write to/.test(error.message),
            );
        });

        test("is not on the child's PATH either, nor is a relative entry", async () => {
            const result = await run(node, ["-e", "console.log(process.env.PATH)"], { cwd: repo });
            assert.ok(!result.stdout.includes(path.join(repo, "bin")), result.stdout);
            assert.ok(!result.stdout.includes("relative/bin"), result.stdout);
        });
    });
});

describe("git", () => {
    const isolated = {
        HOME: "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const plain = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            env: { ...process.env, ...isolated, HOME: process.env.HOME ?? "" },
        });
    let root: string;
    let counter = 0;
    let options: { env: Record<string, string> };
    before(() => {
        root = mkdtempSync(path.join(tmpdir(), "jig-git-"));
        options = { env: { ...isolated, HOME: root } };
    });
    after(() => rmSync(root, { recursive: true, force: true }));
    beforeEach(() => forgetCheckedConfigs());

    function repository(): string {
        const dir = path.join(root, `repo${counter++}`);
        mkdirSync(dir, { recursive: true });
        plain(dir, "init", "-q", "-b", "main");
        return dir;
    }

    test("runs git in the repository", async () => {
        const repo = repository();
        const result = await git(repo, ["rev-parse", "--is-inside-work-tree"], options);
        assert.deepEqual([result.code, result.stdout.trim()], [0, "true"]);
    });

    test("puts the fixed flags before the subcommand: no fsmonitor, no hooks path, no colour", async () => {
        const repo = repository();
        assert.equal((await git(repo, ["config", "--get", "core.hooksPath"], options)).stdout.trim(), "/dev/null");
        assert.equal((await git(repo, ["config", "--get", "core.fsmonitor"], options)).stdout.trim(), "false");
        assert.equal((await git(repo, ["config", "--get", "color.ui"], options)).stdout.trim(), "false");
        assert.deepEqual(GIT_FIXED_FLAGS, [
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "color.ui=false",
        ]);
    });

    test("a hook in the repository does not run", async () => {
        const repo = repository();
        const marker = path.join(root, `hook-ran-${counter}`);
        mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
        writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
        chmodSync(path.join(repo, ".git", "hooks", "pre-commit"), 0o755);
        const result = await git(repo, ["commit", "--allow-empty", "-q", "-m", "x"], options);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(existsSync(marker), false, "the pre-commit hook ran");
    });

    test("never waits for a person, and runs with a short environment", async () => {
        const repo = repository();
        process.env.JIG_TEST_SECRET = "must-not-reach-git";
        try {
            const result = await git(repo, ["-c", "alias.printenv=!env", "printenv"], options);
            assert.match(result.stdout, /^GIT_TERMINAL_PROMPT=0$/m);
            assert.match(result.stdout, /^GIT_PAGER=cat$/m);
            assert.match(result.stdout, /^LC_ALL=C$/m);
            assert.match(result.stdout, /^GIT_ALLOW_PROTOCOL=file:git:https:ssh$/m);
            assert.ok(!result.stdout.includes("must-not-reach-git"));
        } finally {
            delete process.env.JIG_TEST_SECRET;
        }
    });

    test("a failing git command is a result with its exit code, not an error", async () => {
        const result = await git(repository(), ["rev-parse", "--verify", "no-such-ref"], options);
        assert.notEqual(result.code, 0);
        assert.equal(result.timedOut, false);
    });

    test("outside a repository it runs and fails the way git does", async () => {
        const plainFolder = path.join(root, `plain${counter++}`);
        mkdirSync(plainFolder);
        const result = await git(plainFolder, ["rev-parse", "--git-dir"], {
            env: { ...options.env, GIT_CEILING_DIRECTORIES: root },
        });
        assert.equal(result.code, 128);
    });

    describe("the repository's own configuration", () => {
        const plant = (repo: string, header: string, variable: string, value: string) =>
            appendFileSync(path.join(repo, ".git", "config"), `${header}\n\t${variable} = ${value}\n`);

        test("a command planted in .git/config refuses the call before git runs", async () => {
            const repo = repository();
            plant(repo, "[core]", "sshCommand", "evil");
            const refusal = await git(repo, ["fetch"], options).catch((error: unknown) => error);
            assert.ok(refusal instanceof ExecError, String(refusal));
            assert.match(
                (refusal as Error).message,
                /\.git\/config sets core\.sshcommand, which would run with your credentials/,
            );
        });

        for (const [header, variable, value, key] of [
            ["[core]", "hooksPath", "/tmp/evil", "core.hookspath"],
            ["[core]", "fsmonitor", "evil-hook", "core.fsmonitor"],
            ["[credential]", "helper", "!evil", "credential.helper"],
            [
                '[url "https://evil.example/"]',
                "insteadOf",
                "https://github.com/",
                "url.https://evil.example/.insteadof",
            ],
            ['[filter "lfs"]', "clean", "evil", "filter.lfs.clean"],
        ] as const) {
            test(`${key} is refused`, async () => {
                const repo = repository();
                plant(repo, header, variable, value);
                await assert.rejects(git(repo, ["status"], options), new RegExp(key.replace(/[.\\/]/g, "\\$&")));
            });
        }

        test("run('git') goes through the same guard", async () => {
            const repo = repository();
            plant(repo, "[core]", "sshCommand", "evil");
            await assert.rejects(run("git", ["status"], { ...options, cwd: repo }), /core\.sshcommand/);
        });

        test("run() with the absolute path of a git uses that program, with the same checks", async () => {
            const folder = path.join(root, `chosen${counter++}`);
            mkdirSync(folder);
            const chosen = path.join(folder, "git");
            writeFileSync(chosen, '#!/bin/sh\necho "chosen git: $*"\n');
            chmodSync(chosen, 0o755);
            const repo = repository();
            const result = await run(chosen, ["status"], { ...options, cwd: repo });
            assert.match(
                result.stdout,
                /^chosen git: -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null -c color\.ui=false status/,
            );
            plant(repo, "[core]", "sshCommand", "evil");
            await assert.rejects(run(chosen, ["status"], { ...options, cwd: repo }), /core\.sshcommand/);
        });

        test("so does run('gh'), which starts git", async () => {
            const repo = repository();
            plant(repo, "[core]", "sshCommand", "evil");
            await assert.rejects(run("gh", ["--version"], { ...options, cwd: repo }), /core\.sshcommand/);
        });

        test("and so does run('glab'), which starts git as well", async () => {
            const repo = repository();
            plant(repo, "[core]", "sshCommand", "evil");
            await assert.rejects(run("glab", ["--version"], { ...options, cwd: repo }), /core\.sshcommand/);
        });

        test("glab runs in a repository with a normal configuration, with git's and glab's fixed environment", async () => {
            const folder = path.join(root, `glab-bin${counter++}`);
            mkdirSync(folder);
            const fake = path.join(folder, "glab");
            writeFileSync(fake, `#!${node}\nconsole.log(JSON.stringify(process.env));\n`);
            chmodSync(fake, 0o755);
            const repo = repository();
            plant(repo, '[remote "origin"]', "url", "git@gitlab.example.com:team/project.git");
            const env = JSON.parse((await run(fake, ["api", "user"], { ...options, cwd: repo })).stdout) as Record<
                string,
                string
            >;
            for (const [name, value] of Object.entries({
                GLAB_NO_PROMPT: "1",
                GLAB_CHECK_UPDATE: "false",
                GLAB_SEND_TELEMETRY: "false",
                GLAB_NOTIFY_SKILL_UPDATES: "false",
                GLAB_SHOW_WHATS_NEW: "false",
                GLAB_COLOR: "never",
                GLAB_PAGER: "cat",
                GLAB_DISPLAY_HYPERLINKS: "false",
                GIT_TERMINAL_PROMPT: "0",
                GIT_EDITOR: "true",
                NO_COLOR: "1",
            })) {
                assert.equal(env[name], value, name);
            }
            assert.equal(env.GH_PROMPT_DISABLED, undefined, "gh's variables are gh's");
            assert.equal(
                Object.keys(env).some((name) => /TOKEN|SECRET|PASSWORD/i.test(name)),
                false,
                "no credential is passed on",
            );
        });

        test("a normal configuration passes", async () => {
            const repo = repository();
            plant(repo, '[remote "origin"]', "url", "git@example.com:team/project.git");
            plant(repo, "[alias]", "st", "status");
            plant(repo, "[core]", "fsmonitor", "false");
            assert.equal((await git(repo, ["status", "--short"], options)).code, 0);
        });

        test("`git clone` reads no configuration of the folder it runs in, so it is not refused", async () => {
            const source = repository();
            plain(source, "commit", "--allow-empty", "-q", "-m", "first");
            const elsewhere = repository();
            plant(elsewhere, "[core]", "sshCommand", "evil");
            const result = await git(elsewhere, ["clone", "-q", source, "copy"], options);
            assert.equal(result.code, 0, result.stderr);
            assert.ok(existsSync(path.join(elsewhere, "copy", ".git")));
        });

        test("fixing the configuration lets the next call through", async () => {
            const repo = repository();
            plant(repo, "[core]", "sshCommand", "evil");
            await assert.rejects(git(repo, ["status"], options), ExecError);
            writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n");
            assert.equal((await git(repo, ["status"], options)).code, 0);
        });
    });
});
