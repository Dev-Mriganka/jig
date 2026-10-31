// The rules as data: for a given machine, which paths are hidden, locked, ask-first or writable, and what the sandbox
// runtime is told. The machines are made in memory, so WSL, a Mac and links that loop are as easy to try as a plain home.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canWritePath, computeRules, ruleFor, runtimeFilesystem, secretFilesIn } from "../src/rules.ts";
import type { RuleKind, RulesInput, RuleSet } from "../src/rules.ts";
import { fakeMachine } from "./support/fake-files.ts";
import type { FakeMachine, MachineSpec } from "./support/fake-files.ts";

import { CWD, HOME, SESSION, input, linux, rules } from "./support/fixture.ts";

const of = (set: RuleSet, kind: RuleKind): string[] =>
    set.rules.filter((rule) => rule.kind === kind).map((rule) => rule.path);

describe("hidden paths", () => {
    test("a credential folder that exists is hidden, and one that does not exist adds nothing", () => {
        const set = rules(linux({ dirs: [`${HOME}/.ssh`, `${HOME}/.aws`] }));
        assert.deepEqual(
            of(set, "hidden").filter((place) => place.startsWith(HOME)),
            [`${HOME}/.aws`, `${HOME}/.ssh`],
        );
        assert.equal(
            runtimeFilesystem(set).denyRead.some((entry) => entry.path.endsWith(".kube")),
            false,
        );
    });

    test("the home folder is the one given, not $HOME", () => {
        const files = linux({ dirs: [`${HOME}/.ssh`, "/tmp/fake-home/.ssh"] });
        const set = rules(files, { env: { HOME: "/tmp/fake-home", PATH: "/usr/bin" } });
        assert.ok(of(set, "hidden").includes(`${HOME}/.ssh`));
        assert.ok(!of(set, "hidden").includes("/tmp/fake-home/.ssh"));
    });

    test("a link is followed: the real place is hidden, and the rule still answers to the link's name", () => {
        const files = linux({ dirs: ["/data/ssh"], links: { [`${HOME}/.ssh`]: "/data/ssh" } });
        const set = rules(files);
        assert.deepEqual(
            of(set, "hidden").filter((place) => place.includes("ssh")),
            ["/data/ssh"],
        );
        assert.equal(ruleFor(set, `${HOME}/.ssh/id_test`)?.path, "/data/ssh");
        assert.equal(ruleFor(set, "/data/ssh/id_test")?.path, "/data/ssh");
        assert.equal(set.rules.find((rule) => rule.path === "/data/ssh")?.shown, "/data/ssh");
    });

    test("a link that points nowhere hides nothing", () => {
        const set = rules(linux({ links: { [`${HOME}/.kube`]: "/nowhere" } }));
        assert.ok(!of(set, "hidden").some((place) => place.includes("kube")));
    });

    test("a link in the path to a credential is followed too", () => {
        const files = linux({ dirs: ["/vault/secrets/aws"], links: { [`${HOME}/.aws`]: "/vault/secrets/aws" } });
        assert.ok(of(rules(files), "hidden").includes("/vault/secrets/aws"));
    });

    test("build and package credentials are hidden", () => {
        const files = linux({
            files: {
                [`${HOME}/.gradle/gradle.properties`]: "",
                [`${HOME}/.npmrc`]: "",
                [`${HOME}/.m2/settings.xml`]: "",
                [`${HOME}/.cargo/credentials.toml`]: "",
            },
        });
        const hidden = of(rules(files), "hidden");
        for (const name of [".gradle/gradle.properties", ".npmrc", ".m2/settings.xml", ".cargo/credentials.toml"]) {
            assert.ok(hidden.includes(`${HOME}/${name}`), name);
        }
    });

    test("Pi's login files are hidden although jig-core is not asked", () => {
        const files = linux({
            files: { [`${HOME}/.pi/agent/auth.json`]: "", [`${HOME}/.pi/agent/mcp-auth.json`]: "" },
        });
        const hidden = of(rules(files), "hidden");
        assert.ok(hidden.includes(`${HOME}/.pi/agent/auth.json`));
        assert.ok(hidden.includes(`${HOME}/.pi/agent/mcp-auth.json`));
    });

    test("Pi's agent folder is locked even when jig-core is not asked", () => {
        const set = rules(linux({ dirs: [`${HOME}/.pi/agent`] }));
        assert.ok(of(set, "locked").includes(`${HOME}/.pi/agent`));
        assert.equal(canWritePath(set, `${HOME}/.pi/agent/settings.json`), false);
    });

    test("another agent's login is hidden", () => {
        const files = linux({ files: { [`${HOME}/.claude/.credentials.json`]: "", [`${HOME}/.codex/auth.json`]: "" } });
        const hidden = of(rules(files), "hidden");
        assert.ok(hidden.includes(`${HOME}/.claude/.credentials.json`));
        assert.ok(hidden.includes(`${HOME}/.codex/auth.json`));
    });

    test("the desktop's sockets, the SSH agent's folder and the Docker socket are hidden", () => {
        const files = linux({
            dirs: ["/run/user/1000", "/tmp/ssh-AbCd", "/tmp/gpg-xyz", "/tmp/not-ssh-folder"],
            files: { "/var/run/docker.sock": "", "/run/docker.sock": "" },
        });
        const hidden = of(rules(files), "hidden");
        for (const place of [
            "/run/user/1000",
            "/tmp/ssh-AbCd",
            "/tmp/gpg-xyz",
            "/var/run/docker.sock",
            "/run/docker.sock",
        ]) {
            assert.ok(hidden.includes(place), place);
        }
        assert.ok(!hidden.includes("/tmp/not-ssh-folder"));
    });

    test("a runtime directory named by XDG_RUNTIME_DIR is hidden as well", () => {
        const files = linux({ dirs: ["/custom/run"] });
        assert.ok(
            of(rules(files, { env: { XDG_RUNTIME_DIR: "/custom/run", PATH: "" } }), "hidden").includes("/custom/run"),
        );
    });

    test("your own `hide` is added, as ~/ or absolute, and a relative path is ignored", () => {
        const files = linux({ dirs: [`${HOME}/private-notes`, "/srv/secrets"] });
        const set = rules(files, {
            settings: { share: [], hide: ["~/private-notes", "/srv/secrets", "notes"], lock: [] },
        });
        const hidden = of(set, "hidden");
        assert.ok(hidden.includes(`${HOME}/private-notes`));
        assert.ok(hidden.includes("/srv/secrets"));
        assert.equal(hidden.length, 2);
        assert.equal(ruleFor(set, `${HOME}/private-notes/a.txt`)?.source, "your sandbox section (hide)");
    });
});

describe("jig-core's protected paths", () => {
    test("secret paths are hidden and guarded paths are locked, with the source jig-core gave", () => {
        const files = linux({ dirs: ["/opt/company-secrets", `${HOME}/.pi/agent`] });
        const set = rules(files, {
            protectedPaths: [
                { path: "/opt/company-secrets", shown: "/opt/company-secrets", kind: "secret", source: "company" },
                { path: `${HOME}/.pi/agent`, shown: "~/.pi/agent", kind: "guarded", source: "default" },
            ],
        });
        assert.ok(of(set, "hidden").includes("/opt/company-secrets"));
        assert.ok(of(set, "locked").includes(`${HOME}/.pi/agent`));
        assert.match(set.rules.find((rule) => rule.path === "/opt/company-secrets")?.source ?? "", /a company plugin/);
    });

    test("a path both lists name is one rule that keeps both sources", () => {
        const files = linux({ files: { [`${HOME}/.npmrc`]: "" } });
        const set = rules(files, {
            protectedPaths: [{ path: `${HOME}/.npmrc`, shown: "~/.npmrc", kind: "secret", source: "default" }],
        });
        const matching = set.rules.filter((rule) => rule.path === `${HOME}/.npmrc`);
        assert.equal(matching.length, 1);
        assert.match(matching[0]?.source ?? "", /built in/);
        assert.match(matching[0]?.source ?? "", /jig-core/);
        assert.match(matching[0]?.reason ?? "", /package-registry/);
    });
});

describe("a project's secret files", () => {
    test("`.env` and its variants are hidden, templates and ordinary files are not", () => {
        const files = linux({
            files: Object.fromEntries(
                [
                    ".env",
                    ".env.local",
                    ".env.production",
                    ".env.example",
                    ".env.sample",
                    ".env.template",
                    ".env.dist",
                    "README.md",
                    "app.pem",
                    "id.key",
                    "store.p12",
                    "x.pfx",
                    "k.jks",
                    "k.keystore",
                    "monkey.txt",
                ].map((name) => [`${CWD}/${name}`, ""]),
            ),
        });
        const hidden = of(rules(files), "hidden").filter((place) => place.startsWith(CWD));
        assert.deepEqual(hidden.map((place) => place.slice(CWD.length + 1)).sort(), [
            ".env",
            ".env.local",
            ".env.production",
            "app.pem",
            "id.key",
            "k.jks",
            "k.keystore",
            "store.p12",
            "x.pfx",
        ]);
    });

    test("repositories one and two levels below the working folder are searched, a third level is not", () => {
        const files = linux({
            dirs: [`${CWD}/svc-a/.git`, `${CWD}/group/svc-b/.git`, `${CWD}/a/b/svc-c/.git`],
            files: {
                [`${CWD}/svc-a/.env`]: "",
                [`${CWD}/group/svc-b/.env`]: "",
                [`${CWD}/a/b/svc-c/.env`]: "",
                [`${CWD}/plain/.env`]: "",
            },
        });
        const hidden = of(rules(files), "hidden");
        assert.ok(hidden.includes(`${CWD}/svc-a/.env`));
        assert.ok(hidden.includes(`${CWD}/group/svc-b/.env`));
        assert.ok(!hidden.includes(`${CWD}/a/b/svc-c/.env`));
        assert.ok(!hidden.includes(`${CWD}/plain/.env`), "a folder that is no repository is not searched");
    });

    test("the repository around the working folder is searched too", () => {
        const files = linux({ dirs: [`${HOME}/work/.git`, `${CWD}/src`], files: { [`${HOME}/work/.env`]: "" } });
        const set = rules(files, { cwd: `${CWD}/src` });
        assert.ok(of(set, "hidden").includes(`${HOME}/work/.env`));
    });

    test("a secret file the agent made in this session is its own", () => {
        const files = linux({ files: { [`${CWD}/.env`]: "", [`${CWD}/.env.local`]: "" } });
        const set = rules(files, { createdByAgent: new Set([`${CWD}/.env`]) });
        const hidden = of(set, "hidden");
        assert.ok(!hidden.includes(`${CWD}/.env`));
        assert.ok(hidden.includes(`${CWD}/.env.local`));
    });

    test("a secret file that is a link to a real file hides the real file", () => {
        const files = linux({ files: { "/vault/prod.env": "" }, links: { [`${CWD}/.env`]: "/vault/prod.env" } });
        assert.ok(of(rules(files), "hidden").includes("/vault/prod.env"));
    });

    test("a folder called .env is not a secret file", () => {
        assert.deepEqual(secretFilesIn(linux({ dirs: [`${CWD}/.env`] }), CWD), []);
    });
});

describe("locked paths", () => {
    test("start-up files that exist are locked, and those that do not are listed for the audit", () => {
        const files = linux({ files: { [`${HOME}/.bashrc`]: "", [`${HOME}/.gitconfig`]: "" } });
        const set = rules(files);
        assert.ok(of(set, "locked").includes(`${HOME}/.bashrc`));
        assert.ok(of(set, "locked").includes(`${HOME}/.gitconfig`));
        assert.ok(!of(set, "locked").includes(`${HOME}/.zshrc`));
        assert.ok(set.missing.some((rule) => rule.path === `${HOME}/.zshrc`));
        assert.ok(!runtimeFilesystem(set).denyWrite.some((entry) => entry.path === `${HOME}/.zshrc`));
    });

    test("Gradle's init scripts are locked and its caches stay writable", () => {
        const files = linux({
            dirs: [`${HOME}/.gradle/init.d`, `${HOME}/.gradle/caches`, `${HOME}/.m2/repository`, `${HOME}/.npm`],
        });
        const set = rules(files);
        assert.ok(of(set, "locked").includes(`${HOME}/.gradle/init.d`));
        for (const cache of [`${HOME}/.gradle/caches`, `${HOME}/.m2/repository`, `${HOME}/.npm`]) {
            assert.equal(ruleFor(set, cache), undefined, cache);
            assert.equal(canWritePath(set, `${cache}/x`), true, cache);
        }
    });

    test("what Pi loads from the project and from every folder above it below the home folder is locked", () => {
        const files = linux({
            dirs: [`${CWD}/.pi/extensions`, `${CWD}/.pi/docs`, `${HOME}/work/.pi/skills`, `${HOME}/.pi/skills`],
            files: { [`${CWD}/.pi/settings.json`]: "{}", [`${CWD}/.pi/notes.md`]: "" },
        });
        const locked = of(rules(files), "locked");
        assert.ok(locked.includes(`${CWD}/.pi/extensions`));
        assert.ok(locked.includes(`${CWD}/.pi/settings.json`));
        assert.ok(locked.includes(`${HOME}/work/.pi/skills`));
        assert.ok(!locked.includes(`${CWD}/.pi/docs`), ".pi/docs stays writable");
        assert.ok(!locked.includes(`${CWD}/.pi/notes.md`));
        assert.ok(!locked.includes(`${HOME}/.pi/skills`), "the home folder's own .pi is not a project's");
    });

    test("a missing project folder is listed for the audit", () => {
        const set = rules(linux());
        assert.ok(set.missing.some((rule) => rule.path === `${CWD}/.pi/extensions`));
    });

    test("git hooks of the working folder's repository and of the ones below are locked, git config is not", () => {
        const files = linux({
            dirs: [`${CWD}/.git/hooks`, `${CWD}/svc/.git/hooks`],
            files: { [`${CWD}/.git/config`]: "" },
        });
        const set = rules(files);
        assert.ok(of(set, "locked").includes(`${CWD}/.git/hooks`));
        assert.ok(of(set, "locked").includes(`${CWD}/svc/.git/hooks`));
        assert.ok(!of(set, "locked").includes(`${CWD}/.git/config`));
        assert.equal(canWritePath(set, `${CWD}/.git/config`), true);
        assert.equal(canWritePath(set, `${CWD}/.git/hooks/pre-commit`), false);
        assert.equal(runtimeFilesystem(set).allowGitConfig, true);
    });

    test("a linked worktree's hooks are the main repository's", () => {
        const files = linux({
            dirs: ["/repos/main/.git/hooks", "/repos/main/.git/worktrees/wt"],
            files: {
                [`${CWD}/.git`]: "gitdir: /repos/main/.git/worktrees/wt\n",
                "/repos/main/.git/worktrees/wt/commondir": "../..\n",
            },
        });
        const set = rules(files);
        assert.ok(of(set, "locked").includes("/repos/main/.git/hooks"));
    });

    test("the folder core.hooksPath names is locked", () => {
        const files = linux({
            dirs: [`${CWD}/.git/hooks`, `${CWD}/.githooks`],
            files: { [`${CWD}/.git/config`]: "[core]\n\thooksPath = .githooks\n" },
        });
        assert.ok(of(rules(files), "locked").includes(`${CWD}/.githooks`));
    });

    test("editor and build settings that start programs are locked in the project", () => {
        const files = linux({
            files: {
                [`${CWD}/.vscode/tasks.json`]: "",
                [`${CWD}/.vscode/settings.json`]: "",
                [`${CWD}/.vscode/launch.json`]: "",
                [`${CWD}/.idea/workspace.xml`]: "",
                [`${CWD}/.mvn/jvm.config`]: "",
                [`${CWD}/.claude/settings.local.json`]: "",
            },
            dirs: [`${CWD}/.idea/runConfigurations`],
        });
        const locked = of(rules(files), "locked");
        for (const name of [
            ".vscode/tasks.json",
            ".vscode/settings.json",
            ".idea/workspace.xml",
            ".idea/runConfigurations",
            ".mvn/jvm.config",
            ".claude/settings.local.json",
        ]) {
            assert.ok(locked.includes(`${CWD}/${name}`), name);
        }
        assert.ok(!locked.includes(`${CWD}/.vscode/launch.json`));
    });

    test("python start-up hooks (.pth) in the user's site-packages are locked", () => {
        const files = linux({
            files: {
                [`${HOME}/.local/lib/python3.12/site-packages/evil.pth`]: "",
                [`${HOME}/.local/lib/python3.12/site-packages/module.py`]: "",
            },
        });
        const set = rules(files);
        assert.ok(of(set, "locked").includes(`${HOME}/.local/lib/python3.12/site-packages/evil.pth`));
        assert.ok(!of(set, "locked").some((place) => place.endsWith("module.py")));
        assert.deepEqual(set.pthFolders, [`${HOME}/.local/lib/python3.12/site-packages`]);
    });

    test("PATH folders in the home folder are locked, toolchain managers ask first instead, and the project's are left", () => {
        const files = linux({
            dirs: [
                `${HOME}/.local/bin`,
                `${HOME}/.nvm/versions/node/v24/bin`,
                `${HOME}/.sdkman/candidates/java/21/bin`,
                `${CWD}/node_modules/.bin`,
                "/usr/bin",
            ],
            links: { [`${HOME}/.sdkman/candidates/java/current`]: `${HOME}/.sdkman/candidates/java/21` },
        });
        const set = rules(files, {
            env: {
                PATH: [
                    `${HOME}/.local/bin`,
                    `${HOME}/.nvm/versions/node/v24/bin`,
                    `${HOME}/.sdkman/candidates/java/current/bin`,
                    `${CWD}/node_modules/.bin`,
                    "/usr/bin",
                    "relative/bin",
                    `${HOME}/bin`,
                ].join(":"),
            },
        });
        const locked = of(set, "locked");
        assert.ok(locked.includes(`${HOME}/.local/bin`));
        assert.ok(!locked.some((place) => place.includes(".nvm") || place.includes(".sdkman")));
        assert.ok(!locked.includes(`${CWD}/node_modules/.bin`));
        assert.ok(!locked.includes("/usr/bin"));
        assert.ok(
            set.missing.some((rule) => rule.path === `${HOME}/bin`),
            "a PATH folder that is not there yet is listed for the audit",
        );
    });

    test("the Node.js and Pi that run Pi are locked", () => {
        const files = linux({
            dirs: [`${HOME}/.nvm/versions/node/v24`, `${HOME}/.nvm/versions/node/v24/lib/node_modules/pi`],
        });
        const set = rules(files, {
            runtimePaths: [`${HOME}/.nvm/versions/node/v24`, `${HOME}/.nvm/versions/node/v24/lib/node_modules/pi`],
        });
        assert.ok(of(set, "locked").includes(`${HOME}/.nvm/versions/node/v24`));
        assert.equal(canWritePath(set, `${HOME}/.nvm/versions/node/v24/lib/node_modules/other`), false);
    });

    test("your own `lock` is added", () => {
        const files = linux({ files: { [`${HOME}/bin/deploy.sh`]: "" } });
        const set = rules(files, { settings: { share: [], hide: [], lock: ["~/bin/deploy.sh"] } });
        assert.ok(of(set, "locked").includes(`${HOME}/bin/deploy.sh`));
        assert.equal(canWritePath(set, `${HOME}/bin/deploy.sh`), false);
        assert.equal(canWritePath(set, `${HOME}/bin/other.sh`), true);
    });
});

describe("ask-first paths", () => {
    const managers = linux({
        dirs: [`${HOME}/.sdkman`, `${HOME}/.nvm`, `${HOME}/go/bin`, `${HOME}/.cargo/bin`, `${HOME}/.cargo/registry`],
    });

    test("toolchain managers ask first, and the rest of ~/.cargo does not", () => {
        const set = rules(managers);
        assert.deepEqual(of(set, "ask-first"), [
            `${HOME}/.cargo/bin`,
            `${HOME}/.nvm`,
            `${HOME}/.sdkman`,
            `${HOME}/go/bin`,
        ]);
        assert.equal(canWritePath(set, `${HOME}/.cargo/registry/x`), true);
    });

    test("they are not writable until the user allowed them", () => {
        assert.equal(canWritePath(rules(managers), `${HOME}/.sdkman/candidates/java`), false);
        const set = rules(managers, { approved: [`${HOME}/.sdkman`] });
        assert.equal(canWritePath(set, `${HOME}/.sdkman/candidates/java`), true);
        assert.ok(!of(set, "ask-first").includes(`${HOME}/.sdkman`));
        assert.equal(canWritePath(set, `${HOME}/.nvm/x`), false, "an answer for one folder is for that folder");
    });

    test("a locked folder inside an allowed toolchain folder stays locked", () => {
        const files = linux({ dirs: [`${HOME}/.nvm/versions/node/v24`] });
        const set = rules(files, { approved: [`${HOME}/.nvm`], runtimePaths: [`${HOME}/.nvm/versions/node/v24`] });
        assert.equal(canWritePath(set, `${HOME}/.nvm/versions/node/v25/bin/node`), true);
        assert.equal(canWritePath(set, `${HOME}/.nvm/versions/node/v24/bin/node`), false);
    });

    test("a manager moved by its own variable asks first where it now is", () => {
        const files = linux({ dirs: ["/opt/sdkman"] });
        const set = rules(files, { env: { SDKMAN_DIR: "/opt/sdkman", PATH: "" } });
        assert.ok(of(set, "ask-first").includes("/opt/sdkman"));
        assert.equal(set.rules.find((rule) => rule.path === "/opt/sdkman")?.source, "environment (SDKMAN_DIR)");
    });

    test("the rule answers a question about a path below it", () => {
        const set = rules(managers);
        const rule = ruleFor(set, `${HOME}/.sdkman/candidates/java/21`);
        assert.equal(rule?.kind, "ask-first");
        assert.equal(rule?.shown, "~/.sdkman");
    });
});

describe("what the runtime is given", () => {
    const files = linux({
        dirs: [`${HOME}/.ssh`, `${HOME}/.sdkman`, `${CWD}/.git/hooks`],
        files: { [`${HOME}/.bashrc`]: "", [`${CWD}/.env`]: "" },
    });

    test("every path is literal, absolute and exists", () => {
        const given = runtimeFilesystem(rules(files));
        for (const list of [given.denyRead, given.allowRead, given.allowWrite, given.denyWrite]) {
            for (const entry of list) {
                assert.equal(entry.literal, true);
                assert.ok(entry.path.startsWith("/"));
                assert.notEqual(files.real(entry.path), undefined, entry.path);
            }
        }
    });

    test("the home folder, the working folder, /tmp and the session's temporary folder are writable", () => {
        const given = runtimeFilesystem(rules(files));
        assert.deepEqual(
            given.allowWrite.map((entry) => entry.path),
            [HOME, CWD, "/tmp", `${SESSION}/tmp`],
        );
    });

    test("locked and ask-first paths are denied for writing, hidden ones for reading", () => {
        const given = runtimeFilesystem(rules(files));
        const write = given.denyWrite.map((entry) => entry.path);
        assert.ok(write.includes(`${HOME}/.bashrc`));
        assert.ok(write.includes(`${HOME}/.sdkman`));
        assert.ok(write.includes(`${CWD}/.git/hooks`));
        assert.ok(write.includes(`${SESSION}/broker`), "the broker's folder is not writable");
        assert.ok(!write.includes(`${HOME}/.ssh`));
        const read = given.denyRead.map((entry) => entry.path);
        assert.ok(read.includes(`${HOME}/.ssh`));
        assert.ok(read.includes(`${CWD}/.env`));
    });

    test("a working folder outside the home folder is writable, links followed", () => {
        const outside = linux({ dirs: ["/srv/app"], links: { "/work": "/srv/app" } });
        const set = rules(outside, { cwd: "/work" });
        assert.ok(runtimeFilesystem(set).allowWrite.some((entry) => entry.path === "/srv/app"));
        assert.equal(set.cwd, "/srv/app");
    });

    test("a path outside every writable folder is not mounted as a rule, since it is read-only already", () => {
        const set = rules(linux({ dirs: ["/opt/tool"] }), { runtimePaths: ["/opt/tool"] });
        assert.ok(of(set, "locked").includes("/opt/tool"));
        assert.ok(!runtimeFilesystem(set).denyWrite.some((entry) => entry.path === "/opt/tool"));
    });
});

describe("WSL", () => {
    const wsl = (extra: MachineSpec = {}): FakeMachine =>
        linux({
            dirs: ["/mnt/c/Users/me/work", "/mnt/wsl", "/run/WSL", ...(extra.dirs ?? [])],
            files: { "/mnt/wsl/resolv.conf": "nameserver 10.0.0.1\n" },
            links: { "/etc/resolv.conf": "../mnt/wsl/resolv.conf", ...(extra.links ?? {}) },
        });

    test("the Windows drives and the interop sockets are hidden on WSL, and not on other Linux", () => {
        assert.deepEqual(of(rules(wsl(), { wsl: true }), "hidden"), ["/mnt", "/run/WSL"]);
        assert.deepEqual(of(rules(wsl(), { wsl: false }), "hidden"), []);
    });

    test("the real resolv.conf stays readable, never the link", () => {
        const given = runtimeFilesystem(rules(wsl(), { wsl: true }));
        assert.deepEqual(
            given.allowRead.map((entry) => entry.path),
            ["/mnt/wsl/resolv.conf"],
        );
        assert.ok(given.denyRead.some((entry) => entry.path === "/mnt"));
    });

    test("without WSL nothing is reopened", () => {
        assert.deepEqual(runtimeFilesystem(rules(wsl(), { wsl: false })).allowRead, []);
    });

    test("a shared folder under /mnt is writable and readable again", () => {
        const set = rules(wsl(), { wsl: true, settings: { share: ["/mnt/c/Users/me/work"], hide: [], lock: [] } });
        const given = runtimeFilesystem(set);
        assert.ok(given.allowWrite.some((entry) => entry.path === "/mnt/c/Users/me/work"));
        assert.ok(given.allowRead.some((entry) => entry.path === "/mnt/c/Users/me/work"));
        assert.equal(canWritePath(set, "/mnt/c/Users/me/work/src/a.txt"), true);
        assert.equal(canWritePath(set, "/mnt/c/Users/me/other/a.txt"), false);
        assert.deepEqual(set.problems, []);
    });

    test("a working folder on a Windows drive is usable", () => {
        const set = rules(wsl({ dirs: ["/mnt/c/Users/me/proj"] }), { wsl: true, cwd: "/mnt/c/Users/me/proj" });
        const given = runtimeFilesystem(set);
        assert.ok(given.allowRead.some((entry) => entry.path === "/mnt/c/Users/me/proj"));
        assert.ok(given.allowWrite.some((entry) => entry.path === "/mnt/c/Users/me/proj"));
    });
});

describe("the cost of looking", () => {
    test("the Windows part of PATH on WSL is not resolved at all: it is hidden, and slow to resolve", () => {
        const machine = fakeMachine({
            dirs: [
                HOME,
                CWD,
                "/tmp",
                "/mnt/c/Windows/System32",
                "/mnt/c/Users/me/bin",
                "/run/WSL",
                SESSION,
                `${SESSION}/tmp`,
                `${SESSION}/broker`,
            ],
        });
        const asked: string[] = [];
        const counting = { ...machine, real: (place: string) => (asked.push(place), machine.real(place)) };
        computeRules({
            ...input(machine),
            wsl: true,
            env: { PATH: "/mnt/c/Windows/System32:/mnt/c/Users/me/bin:/usr/bin" },
            files: counting,
        });
        assert.deepEqual(
            asked.filter((place) => place.startsWith("/mnt/c")),
            [],
        );
    });
});

describe("share", () => {
    test("a folder inside a credential path is refused and the reason is said", () => {
        const files = linux({ dirs: [`${HOME}/.ssh/keys`] });
        const set = rules(files, { settings: { share: ["~/.ssh/keys", "~/.ssh"], hide: [], lock: [] } });
        assert.equal(set.problems.length, 2);
        assert.match(set.problems[0] ?? "", /ignored, because ~\/\.ssh is hidden/);
        assert.equal(canWritePath(set, `${HOME}/.ssh/keys/id`), false);
        assert.ok(runtimeFilesystem(set).denyRead.some((entry) => entry.path === `${HOME}/.ssh`));
    });

    test("a folder inside a locked path is refused too: share cannot unlock", () => {
        const files = linux({ dirs: [`${HOME}/.config/fish/conf.d`], files: { [`${HOME}/.bashrc`]: "" } });
        const set = rules(files, { settings: { share: ["~/.config/fish/conf.d", "~/.bashrc"], hide: [], lock: [] } });
        assert.equal(set.problems.length, 2);
        assert.match(set.problems[0] ?? "", /is locked/);
        assert.equal(canWritePath(set, `${HOME}/.bashrc`), false);
    });

    test("a folder that does not exist shares nothing and says so", () => {
        const set = rules(linux(), { settings: { share: ["/nowhere"], hide: [], lock: [] } });
        assert.match(set.problems[0] ?? "", /no such folder/);
    });

    test("a shared toolchain folder counts as the user's answer", () => {
        const files = linux({ dirs: [`${HOME}/.sdkman`] });
        const set = rules(files, { settings: { share: ["~/.sdkman"], hide: [], lock: [] } });
        assert.equal(canWritePath(set, `${HOME}/.sdkman/x`), true);
        assert.ok(!of(set, "ask-first").includes(`${HOME}/.sdkman`));
    });

    test("a folder outside the home folder is writable", () => {
        const files = linux({ dirs: ["/data/shared"] });
        const set = rules(files, { settings: { share: ["/data/shared"], hide: [], lock: [] } });
        assert.equal(canWritePath(set, "/data/shared/a"), true);
    });
});

describe("macOS", () => {
    const MAC_HOME = "/Users/me";
    const mac = fakeMachine({
        dirs: [
            MAC_HOME,
            `${MAC_HOME}/dev/app`,
            `${MAC_HOME}/.ssh`,
            `${MAC_HOME}/Library/Keychains`,
            `${MAC_HOME}/Library/LaunchAgents`,
            "/private/tmp",
            "/mnt",
            "/run/user/501",
            "/tmp-session/tmp",
            "/tmp-session/broker",
        ],
        links: { "/tmp": "private/tmp" },
    });
    const set = computeRules({
        ...input(mac),
        platform: "darwin",
        home: MAC_HOME,
        uid: 501,
        cwd: `${MAC_HOME}/dev/app`,
        agentDir: `${MAC_HOME}/.pi/agent`,
        tmp: ["/tmp"],
        sessionDir: "/tmp-session/broker",
        sessionTmp: "/tmp-session/tmp",
        files: mac,
    });

    test("the keychain is hidden, launch agents are locked, and there are no Linux doors", () => {
        assert.deepEqual(of(set, "hidden"), [`${MAC_HOME}/.ssh`, `${MAC_HOME}/Library/Keychains`]);
        assert.ok(of(set, "locked").includes(`${MAC_HOME}/Library/LaunchAgents`));
        assert.ok(!of(set, "hidden").includes("/mnt"));
        assert.ok(!of(set, "hidden").includes("/run/user/501"));
    });

    test("/tmp is followed to where it really is, and messages write the home folder as ~", () => {
        assert.ok(runtimeFilesystem(set).allowWrite.some((entry) => entry.path === "/private/tmp"));
        assert.equal(set.rules.find((rule) => rule.path === `${MAC_HOME}/.ssh`)?.shown, "~/.ssh");
    });
});

describe("asking the rules", () => {
    const files = linux({
        dirs: [`${HOME}/.ssh`, `${HOME}/.sdkman`, `${HOME}/.config/fish`],
        files: { [`${HOME}/.bashrc`]: "" },
    });
    const set = rules(files);

    test("the most specific rule answers, and hidden beats the rest", () => {
        assert.equal(ruleFor(set, `${HOME}/.ssh/config`)?.kind, "hidden");
        assert.equal(ruleFor(set, `${HOME}/.bashrc`)?.kind, "locked");
        assert.equal(ruleFor(set, `${HOME}/.config/fish/config.fish`)?.kind, "locked");
        assert.equal(ruleFor(set, `${HOME}/.sdkman/bin`)?.kind, "ask-first");
        assert.equal(ruleFor(set, `${CWD}/src/a.ts`), undefined);
    });

    test("a path that does not exist yet is answered by where a write would land", () => {
        assert.equal(ruleFor(set, `${HOME}/.sdkman/candidates/java/21/bin/java`)?.kind, "ask-first");
        assert.equal(ruleFor(set, `${HOME}/.ssh/new_key`)?.kind, "hidden");
    });

    test("a link in the project that points into a locked file is caught", () => {
        const withLink = linux({ files: { [`${HOME}/.bashrc`]: "" }, links: { [`${CWD}/rc`]: `${HOME}/.bashrc` } });
        const linked = rules(withLink);
        assert.equal(canWritePath(linked, `${CWD}/rc`), false);
        assert.equal(ruleFor(linked, `${CWD}/rc`)?.kind, "locked");
    });

    test("the project, the home folder and /tmp are writable; the rest of the system is not", () => {
        for (const place of [`${CWD}/a.txt`, `${HOME}/notes.txt`, "/tmp/x", `${SESSION}/tmp/y`]) {
            assert.equal(canWritePath(set, place), true, place);
        }
        for (const place of ["/usr/bin/tool", "/etc/hosts", "/opt/x", `${SESSION}/broker/anything`]) {
            assert.equal(canWritePath(set, place), false, place);
        }
    });
});

describe("a child agent whose role may not write", () => {
    const readOnly = (files = linux(), over: Partial<RulesInput["settings"]> = {}) =>
        rules(files, { settings: { share: [], hide: [], lock: [], readOnly: true, ...over } });

    test("the home folder and the working folder are locked, with the role as the source", () => {
        const set = readOnly();
        for (const place of [HOME, CWD]) {
            const rule = set.rules.find((entry) => entry.path === place);
            assert.equal(rule?.kind, "locked", place);
            assert.equal(rule?.source, "the role of this agent (read-only)");
            assert.match(rule?.reason ?? "", /role may not write/);
        }
    });

    test("nothing is writable but /tmp and the session's scratch folder, the build caches in the home folder included", () => {
        const set = readOnly(linux({ dirs: [`${HOME}/.npm`, `${HOME}/.gradle/caches`, `${HOME}/.m2/repository`] }));
        for (const place of [
            `${CWD}/a.txt`,
            `${HOME}/notes.txt`,
            `${HOME}/.npm/_cacache/x`,
            `${HOME}/.gradle/caches/x`,
            `${HOME}/.m2/repository/x`,
        ]) {
            assert.equal(canWritePath(set, place), false, place);
        }
        for (const place of ["/tmp/x", `${SESSION}/tmp/y`]) assert.equal(canWritePath(set, place), true, place);
    });

    test("the runtime is told to deny writing to both folders", () => {
        const denied = runtimeFilesystem(readOnly()).denyWrite.map((entry) => entry.path);
        assert.ok(denied.includes(HOME));
        assert.ok(denied.includes(CWD));
    });

    test("a refusal says what to do instead", () => {
        const rule = ruleFor(readOnly(), `${CWD}/src/a.ts`);
        assert.equal(rule?.kind, "locked");
        assert.match(rule?.way ?? "", /Report the change you would make/);
    });

    test("a folder the user shares stays read-only, and the reason is said", () => {
        const files = linux({ dirs: ["/srv/work"] });
        const set = readOnly(files, { share: ["/srv/work"] });
        assert.equal(canWritePath(set, "/srv/work/a.txt"), false);
        assert.ok(
            set.problems.some((problem) =>
                /share \/srv\/work: ignored, because this agent's role may not write/.test(problem),
            ),
        );
        // The same share works for an agent that may write.
        const writer = rules(files, { settings: { share: ["/srv/work"], hide: [], lock: [] } });
        assert.equal(canWritePath(writer, "/srv/work/a.txt"), true);
    });

    test("an ask-first folder in the home folder is answered by the lock, so nobody is asked to widen it", () => {
        const set = readOnly(linux({ dirs: [`${HOME}/.sdkman`] }));
        assert.equal(ruleFor(set, `${HOME}/.sdkman/bin/sdk`)?.kind, "locked");
        assert.equal(canWritePath(set, `${HOME}/.sdkman/bin/sdk`), false);
    });

    test("the user's own hide still applies, and the credentials stay hidden", () => {
        const set = readOnly(linux({ dirs: [`${HOME}/.ssh`, `${HOME}/private-notes`] }), {
            hide: ["~/private-notes"],
        });
        assert.equal(ruleFor(set, `${HOME}/.ssh/id_test`)?.kind, "hidden");
        assert.equal(ruleFor(set, `${HOME}/private-notes/a`)?.kind, "hidden");
    });

    test("without the flag nothing changes", () => {
        const set = rules(linux(), { settings: { share: [], hide: [], lock: [], readOnly: false } });
        assert.equal(canWritePath(set, `${CWD}/a.txt`), true);
        assert.equal(
            set.rules.some((rule) => rule.source.includes("role")),
            false,
        );
    });
});
