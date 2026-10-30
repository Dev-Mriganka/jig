// Everything else keeps working, run for real: the sandbox must stay out of the way of builds, git, installs and local
// servers, or nobody leaves it on.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { onPath } from "../src/programs.ts";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { makeWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

const skip = skipUnlessRealSandbox();

describe("the sandbox starts and stays out of the way", { skip }, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
    });
    after(() => world.cleanup());

    test("it is ready, with a broker of its own", () => {
        assert.deepEqual(world.sandbox.state, { kind: "ready" });
        assert.equal(typeof world.sandbox.pid, "number");
        assert.notEqual(world.sandbox.pid, process.pid);
    });

    test("a command runs in the project and writes there", async () => {
        const result = await world.run("pwd; echo hello > made-here.txt; cat made-here.txt");
        assert.equal(result.exitCode, 0);
        assert.equal(result.output, `${world.project}\nhello\n`);
        assert.equal(readFileSync(path.join(world.project, "made-here.txt"), "utf8"), "hello\n");
    });

    test("the exit code, standard error and the shell's own features are as outside", async () => {
        const result = await world.run("echo out; echo err >&2; false || echo recovered; exit 3");
        assert.equal(result.exitCode, 3);
        assert.match(result.output, /out\n/);
        assert.match(result.output, /err\n/);
        assert.match(result.output, /recovered/);
    });

    test("the home folder is writable, and so are /tmp and the temporary folder the command was given", async () => {
        const result = await world.run(
            `mkdir -p ${world.home}/.cache/tool && echo a > ${world.home}/.cache/tool/x && echo a > /tmp/jig-keep-working-$$ && f=$(mktemp) && echo b > $f && echo "tmp=$TMPDIR ok"; rm -f /tmp/jig-keep-working-$$`,
        );
        assert.match(result.output, /tmp=.*\/tmp ok/, result.output);
        assert.equal(readFileSync(`${world.home}/.cache/tool/x`, "utf8"), "a\n");
    });

    test("build caches are writable: Gradle, Maven and npm keep state in the home folder", async () => {
        const result = await world.run(
            `mkdir -p ${world.home}/.gradle/caches/modules-2 ${world.home}/.gradle/wrapper/dists ${world.home}/.m2/repository/org ${world.home}/.npm/_cacache && touch ${world.home}/.gradle/caches/modules-2/lock ${world.home}/.m2/repository/org/a.jar ${world.home}/.npm/_cacache/x && echo ok`,
        );
        assert.equal(result.output.trim(), "ok", result.output);
    });

    test("a file that is locked can still be read", async () => {
        const result = await world.run(`cat ${world.home}/.gitconfig`);
        assert.match(result.output, /name = Test/);
    });

    test("name resolution has what it needs: the resolver's configuration is readable and the hosts file too", async () => {
        const result = await world.run("test -s /etc/resolv.conf && echo resolver-ok; getent hosts localhost");
        assert.match(result.output, /resolver-ok/);
        assert.match(result.output, /localhost/);
    });

    test("twelve commands at once all run, and none sees another's files as its own", async () => {
        const results = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                world.run(`echo ${index} > parallel-${index}.txt && sleep 0.2 && cat parallel-${index}.txt`),
            ),
        );
        results.forEach((result, index) => {
            assert.equal(result.exitCode, 0, result.output);
            assert.equal(result.output.trim(), String(index));
        });
    });

    test("a credential-looking variable is gone, and an ordinary one is kept", async () => {
        const result = await world.run('echo "[$MY_SERVICE_TOKEN] [$LANG] [$HOME]"');
        assert.equal(result.output.trim(), `[] [C.UTF-8] [${world.home}]`);
    });
});

describe("git works, including its configuration", {
    skip: skip || (onPath("git", process.env.PATH) === undefined && "git is not installed"),
}, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
    });
    after(() => world.cleanup());

    test("init, config, add, commit, branch, remote add, all offline, and nothing is left in the project that was not written", async () => {
        const result = await world.run(
            [
                "git init -q",
                "git config user.email test@example.com",
                "git config user.name Test",
                "git config commit.gpgsign false",
                "echo one > a.txt",
                "git add a.txt",
                "git commit -q -m one",
                "git branch feature",
                "git config branch.feature.remote origin",
                "git remote add origin https://example.invalid/orders.git",
                "git remote -v",
                "git log --oneline | wc -l",
            ].join(" && "),
        );
        assert.equal(result.exitCode, 0, result.output);
        assert.match(result.output, /origin\s+https:\/\/example\.invalid\/orders\.git \(fetch\)/);
        assert.match(result.output, /\n1\n$/);
        assert.ok(existsSync(path.join(world.project, ".git", "refs", "heads", "feature")));
        assert.match(readFileSync(path.join(world.project, ".git", "config"), "utf8"), /example\.invalid\/orders/);
        assert.deepEqual(
            readdirSync(world.project).sort(),
            [".env", ".git", "a.txt", "control.txt"]
                .filter((name) => existsSync(path.join(world.project, name)))
                .sort(),
        );
    });

    test("git config --global is the one thing refused, since ~/.gitconfig is locked", async () => {
        const before = readFileSync(`${world.home}/.gitconfig`, "utf8");
        const result = await world.run("git config --global user.name Evil");
        assert.notEqual(result.exitCode, 0);
        assert.equal(readFileSync(`${world.home}/.gitconfig`, "utf8"), before);
    });
});

describe("installs work without the network", {
    skip: skip || (onPath("npm", process.env.PATH) === undefined && "npm is not installed"),
}, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
    });
    after(() => world.cleanup());

    test("npm install of a package from a folder, with the cache in the home folder", async () => {
        const fixture = path.join(world.root, "fixture-pkg");
        mkdirSync(fixture, { recursive: true });
        writeFileSync(
            path.join(fixture, "package.json"),
            JSON.stringify({ name: "jig-fixture", version: "1.0.0", main: "index.js" }),
        );
        writeFileSync(path.join(fixture, "index.js"), "module.exports = 'fixture-ok';\n");
        const result = await world.run(
            `echo '{"name":"app","version":"1.0.0"}' > package.json && npm install ${fixture} --offline --no-audit --no-fund --ignore-scripts --loglevel=error 2>&1; node -e "console.log(require('jig-fixture'))"`,
        );
        assert.match(result.output, /fixture-ok/, result.output);
        assert.ok(existsSync(path.join(world.project, "node_modules", "jig-fixture", "index.js")));
    });
});

describe("a Gradle build runs", {
    skip: skip || (onPath("gradle", process.env.PATH) === undefined && "gradle is not installed"),
}, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
    });
    after(() => world.cleanup());

    test("a build with its user home, caches and daemon-free run", { timeout: 180_000 }, async () => {
        writeFileSync(
            path.join(world.project, "build.gradle"),
            "tasks.register('hello') { doLast { println 'gradle-ok' } }\n",
        );
        // Java asks the password database for the home folder and ignores HOME, so the test world, whose home is a fake one,
        // points Gradle and the JVM at it. On a real machine the two are the same folder.
        const result = await world.run(
            `GRADLE_USER_HOME=${world.home}/.gradle JAVA_TOOL_OPTIONS=-Duser.home=${world.home} gradle --offline --no-daemon -q hello 2>&1 | tail -5`,
        );
        assert.match(result.output, /gradle-ok/, result.output);
        assert.ok(existsSync(path.join(world.home, ".gradle")), "Gradle kept its state in the home folder");
    });
});

describe("the network in open mode is the machine's own", { skip }, () => {
    let world: World;
    let server: net.Server;
    let port: number;
    before(async () => {
        world = await makeWorld();
        server = net.createServer((socket) => {
            socket.on("data", () => socket.end("HTTP/1.0 200 OK\r\n\r\nlocal-server-says-hello\n"));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as net.AddressInfo).port;
    });
    after(async () => {
        server.close();
        await world.cleanup();
    });

    const fetchLocal = (): string =>
        `exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3; cat <&3`;

    test("a server on localhost can be reached", async () => {
        const result = await world.run(fetchLocal());
        assert.match(result.output, /local-server-says-hello/, result.output);
    });

    test("a server a command starts is reached by the same command", async () => {
        const result = await world.run(
            `${process.execPath} -e "require('http').createServer((q,r)=>r.end('inner-server')).listen(0,'127.0.0.1',function(){const p=this.address().port;require('http').get({port:p,host:'127.0.0.1'},(res)=>{res.on('data',d=>{console.log(String(d));process.exit(0)})})})"`,
        );
        assert.match(result.output, /inner-server/, result.output);
    });
});

describe("the network in off mode is closed", { skip }, () => {
    let world: World;
    let server: net.Server;
    let port: number;
    let connections = 0;
    before(async () => {
        world = await makeWorld({ settings: (base) => ({ ...base, network: { ...base.network, mode: "off" } }) });
        server = net.createServer((socket) => {
            connections++;
            socket.end("reachable\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as net.AddressInfo).port;
    });
    after(async () => {
        server.close();
        await world.cleanup();
    });

    test("the sandbox is ready in off mode", () => {
        assert.deepEqual(world.sandbox.state, { kind: "ready" });
        assert.equal(world.sandbox.mode, "off");
    });

    test("a server on the machine's localhost cannot be reached, and nothing resolves", async () => {
        const result = await world.run(
            `exec 3<>/dev/tcp/127.0.0.1/${port} 2>&1; echo "connect-exit=$?"; getent hosts example.com; echo "dns-exit=$?"`,
        );
        assert.equal(connections, 0, result.output);
        assert.doesNotMatch(result.output, /reachable/);
        assert.match(result.output, /dns-exit=[12]/);
    });

    test("files still work", async () => {
        const result = await world.run("echo local > off.txt && cat off.txt");
        assert.equal(result.output.trim(), "local");
    });
});
