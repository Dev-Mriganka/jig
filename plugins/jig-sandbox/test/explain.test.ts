// Explaining a block from what the command printed: the lines tools really write, and the sentence each gets.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explainBlocks, explainViolations } from "../src/explain.ts";
import { CWD, HOME, linux, rules } from "./support/fixture.ts";

const machine = linux({
    dirs: [
        `${HOME}/.ssh`,
        `${HOME}/.sdkman`,
        `${HOME}/.config/fish`,
        `${HOME}/.gradle/init.d`,
        `${CWD}/.git/hooks`,
        `${CWD}/.pi/extensions`,
        "/mnt/c/Users",
    ],
    files: { [`${HOME}/.bashrc`]: "", [`${CWD}/.env`]: "", [`${HOME}/.ssh/config`]: "" },
});
const set = rules(machine, { wsl: true });
const explain = (output: string, mode: "open" | "off" = "open") => explainBlocks(output, set, { cwd: CWD, mode });

describe("a write to a locked path", () => {
    test("a shell redirect names the file and says why", () => {
        const { lines, askFirst } = explain(`bash: ${HOME}/.bashrc: Read-only file system`);
        assert.deepEqual(lines, [
            "[sandbox] cannot write ~/.bashrc: your shells run it outside the sandbox. If you need the change, ask the user to make it themselves with !.",
        ]);
        assert.deepEqual(askFirst, []);
    });

    test("the way tools word it: touch, cp, rm, mv, tee, a relative name", () => {
        for (const line of [
            `touch: cannot touch '${HOME}/.bashrc': Read-only file system`,
            `cp: cannot create regular file '${HOME}/.bashrc': Read-only file system`,
            `rm: cannot remove '${HOME}/.bashrc': Device or resource busy`,
            `mv: cannot move 'x' to '${HOME}/.bashrc': Device or resource busy`,
            `tee: ${HOME}/.bashrc: Read-only file system`,
            `sed: couldn't open temporary file ${HOME}/sedXYZ: Permission denied\nsed: ${HOME}/.bashrc: Read-only file system`,
        ]) {
            assert.match(explain(line).lines[0] ?? "", /cannot write ~\/\.bashrc: your shells run it/, line);
        }
        const relative = explainBlocks("bash: .bashrc: Read-only file system", set, { cwd: HOME, mode: "open" });
        assert.match(relative.lines[0] ?? "", /cannot write ~\/\.bashrc/);
    });

    test("other languages: Python, Node, Java", () => {
        for (const line of [
            `PermissionError: [Errno 13] Permission denied: '${HOME}/.bashrc'`,
            `OSError: [Errno 30] Read-only file system: '${HOME}/.bashrc'`,
            `Error: EROFS: read-only file system, open '${HOME}/.bashrc'`,
            `Error: EACCES: permission denied, open '${HOME}/.bashrc'`,
            `java.nio.file.FileSystemException: ${HOME}/.bashrc: Read-only file system`,
            `java.io.FileNotFoundException: ${HOME}/.bashrc (Read-only file system)`,
        ]) {
            assert.match(explain(line).lines[0] ?? "", /cannot write ~\/\.bashrc/, line);
        }
    });

    test("git hooks, Pi's extensions and Gradle's init scripts", () => {
        assert.match(
            explain(`error: could not write ${CWD}/.git/hooks/pre-commit: Read-only file system`).lines[0] ?? "",
            /git runs hooks outside the sandbox/,
        );
        assert.match(
            explain(`bash: ${CWD}/.pi/extensions/x.ts: Read-only file system`).lines[0] ?? "",
            /Pi and Jig load it outside the sandbox/,
        );
        assert.match(
            explain(`bash: ${HOME}/.gradle/init.d/x.gradle: Read-only file system`).lines[0] ?? "",
            /your builds run it/,
        );
    });
});

describe("a read of a hidden path", () => {
    test("a hidden folder looks empty, so a missing file under it is the sandbox's doing, with the way through", () => {
        const { lines } = explain(`cat: ${HOME}/.ssh/id_ed25519: No such file or directory`);
        assert.deepEqual(lines, [
            "[sandbox] cannot read ~/.ssh/id_ed25519: it holds credentials. For git over SSH use the git tool (fetch, pull, push).",
        ]);
    });

    test("a project's .env, and the Windows drive on WSL", () => {
        assert.match(
            explain(`cat: ${CWD}/.env: Permission denied`).lines[0] ?? "",
            /cannot read .*\.env: it is a secret file of the project/,
        );
        assert.match(
            explain("ls: cannot access '/mnt/c/Users': No such file or directory").lines[0] ?? "",
            /the Windows drive.*share/,
        );
    });

    test("an ordinary missing file is not the sandbox's doing", () => {
        assert.deepEqual(explain(`cat: ${CWD}/nothing.txt: No such file or directory`).lines, []);
        assert.deepEqual(explain("cat: nothing.txt: No such file or directory").lines, []);
    });

    test("a write to a hidden path is said as a write", () => {
        assert.match(
            explain(`rm: cannot remove '${HOME}/.ssh/known_hosts': Device or resource busy`).lines[0] ?? "",
            /cannot write ~\/\.ssh\/known_hosts/,
        );
    });
});

describe("ask-first folders", () => {
    test("a refused write under one is explained and handed to the caller once, however many lines name it", () => {
        const output = [
            `mkdir: cannot create directory '${HOME}/.sdkman/candidates': Read-only file system`,
            `mkdir: cannot create directory '${HOME}/.sdkman/tmp': Read-only file system`,
            `curl: (23) Failure writing output; ${HOME}/.sdkman/archives/x.zip: Read-only file system`,
        ].join("\n");
        const { lines, askFirst } = explain(output);
        assert.equal(lines.length, 1);
        assert.match(
            lines[0] ?? "",
            /^\[sandbox\] cannot write ~\/\.sdkman\/candidates: programs installed there are on your PATH/,
        );
        assert.equal(askFirst.length, 1);
        assert.equal(askFirst[0]?.shown, "~/.sdkman");
    });
});

describe("the rest of the system", () => {
    test("a write outside every writable folder says where bash may write", () => {
        const { lines } = explain("bash: /usr/local/bin/tool: Read-only file system");
        assert.match(lines[0] ?? "", /cannot write \/usr\/local\/bin\/tool: it is outside the folders bash may write/);
    });

    test("the shell's own name and the program it ran are not the place that was refused", () => {
        const { lines } = explain("/usr/bin/bash: line 1: /usr/local/bin/tool: Read-only file system");
        assert.equal(lines.length, 1);
        assert.match(lines[0] ?? "", /cannot write \/usr\/local\/bin\/tool: it is outside/);
        const locked = explain(`/usr/bin/bash: line 1: ${HOME}/.bashrc: Read-only file system`).lines;
        assert.equal(locked.length, 1);
        assert.match(locked[0] ?? "", /cannot write ~\/\.bashrc/);
    });

    test("a read-only line with no path gets one general line, and an ordinary permission error none", () => {
        assert.match(explain("Read-only file system").lines[0] ?? "", /a write was refused/);
        assert.deepEqual(explain("cat: /etc/shadow: Permission denied").lines, []);
    });

    test("nothing is said when nothing was refused, or when a program only prints the words", () => {
        assert.deepEqual(explain("all fine\nbuild succeeded").lines, []);
        assert.deepEqual(explain("the message Permission denied is documented in README.md").lines, []);
    });

    test("kernel pseudo-paths are not blamed on a rule", () => {
        assert.deepEqual(explain("bash: /proc/sys/kernel/x: Read-only file system").lines, []);
    });
});

describe("the network", () => {
    test("with the network off, a connection error says so", () => {
        const output = "curl: (6) Could not resolve host: example.com";
        assert.match(explain(output, "off").lines[0] ?? "", /no network: the sandbox's network mode is off/);
        assert.deepEqual(explain(output, "open").lines, [], "in open mode a failure to resolve is the network's own");
    });

    test("refusals the runtime recorded are turned into lines", () => {
        assert.deepEqual(explainViolations([{ line: "  connect  to 169.254.169.254:80  denied " }, { line: "" }]), [
            "[sandbox] network refused: connect to 169.254.169.254:80 denied",
        ]);
    });
});

describe("a lot of refusals", () => {
    test("at most five lines follow, and the rest are counted", () => {
        const many = Array.from(
            { length: 8 },
            (_, index) => `touch: cannot touch '${HOME}/.config/fish/file${index}': Read-only file system`,
        );
        const folders = [
            `bash: ${HOME}/.bashrc: Read-only file system`,
            `bash: ${CWD}/.git/hooks/a: Read-only file system`,
            `bash: ${CWD}/.pi/extensions/a: Read-only file system`,
            `bash: ${HOME}/.gradle/init.d/a: Read-only file system`,
            `bash: ${HOME}/.sdkman/a: Read-only file system`,
            `bash: ${HOME}/.ssh/a: Read-only file system`,
        ];
        const { lines } = explain([...many, ...folders].join("\n"));
        assert.equal(lines.length, 6);
        assert.match(lines[5] ?? "", /and 2 more refusals/);
    });
});
