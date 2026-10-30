import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { checkCloneDir, cloneArgs, cloneFailure, cloneUrl, parseCloneRepo } from "../src/clone.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { installFakeGithub, alive } from "./support/fake-ssh.ts";
import type { FakeGithub } from "./support/fake-ssh.ts";
import { git } from "./support/repos.ts";

const HOST = "github.com";

const accepted: Array<[string, string, string]> = [
    ["acme/svc", "acme", "svc"],
    ["acme/svc.git", "acme", "svc"],
    ["  acme/svc\n", "acme", "svc"],
    ["some-org/provisioning_api", "some-org", "provisioning_api"],
    ["org/platform.toolkit", "org", "platform.toolkit"],
    ["acme/.github", "acme", ".github"],
    ["a/b", "a", "b"],
    ["git@github.com:acme/svc.git", "acme", "svc"],
    ["git@github.com:acme/svc", "acme", "svc"],
    ["https://github.com/acme/svc.git", "acme", "svc"],
    ["https://github.com/acme/svc", "acme", "svc"],
    ["acme/foo.git.git", "acme", "foo.git"],
];

for (const [input, owner, name] of accepted) {
    test(`clone repo ${JSON.stringify(input)} is ${owner}/${name}`, () => {
        assert.deepEqual(parseCloneRepo(input, HOST), { owner, name, slug: `${owner}/${name}` });
    });
}

const refused: Array<[string, unknown]> = [
    // transports and helpers that run commands, local paths
    ["ext helper", "ext::sh -c 'touch /tmp/pwned' %S"],
    ["fd helper", "fd::17/acme/x"],
    ["file url", "file:///etc"],
    ["file url of a repo", "file:///srv/git/x.git"],
    ["absolute path", "/srv/git/x"],
    ["home path", "~/x/y"],
    ["relative path", "./acme/x"],
    ["parent path", "../x"],
    ["parent path with owner", "acme/../x"],
    ["name is parent", "acme/.."],
    ["owner is parent", "../x/y"],
    ["owner is dot", "./x"],
    ["windows path", "C:\\repos\\x"],
    ["backslash", "acme\\x"],
    // option injection
    ["short option", "-uoption"],
    ["upload-pack option", "--upload-pack=touch /tmp/pwned"],
    ["option with slash", "-u/x"],
    ["owner starts with a dash", "-acme/x"],
    ["name starts with a dash", "acme/-x"],
    ["ssh option as host", "git@-oProxyCommand=touch /tmp/pwned:a/b"],
    // other hosts and schemes
    ["gitlab https", "https://gitlab.com/a/b.git"],
    ["lookalike host suffix", "https://github.com.evil.com/a/b"],
    ["lookalike host prefix", "https://evilgithub.com/a/b"],
    ["host in the path", "https://evil.com/github.com/a/b"],
    ["credentials in the url", "https://user:pw-CANARY@github.com/a/b"],
    ["plain http", "http://github.com/a/b"],
    ["https with a port", "https://github.com:443/a/b"],
    ["uppercase host", "https://GitHub.com/a/b"],
    ["www host", "https://www.github.com/a/b"],
    ["ssh scheme", "ssh://git@github.com/a/b.git"],
    ["git protocol", "git://github.com/a/b.git"],
    ["other ssh host", "git@gitlab.com:a/b.git"],
    ["ssh host suffix", "git@github.com.evil.com:a/b.git"],
    ["ssh host prefix", "git@evilgithub.com:a/b"],
    ["an alias nobody configured", "git@github.com-other:a/b"],
    ["another user", "user@github.com:a/b"],
    ["scp path with a leading slash", "git@github.com:/a/b"],
    ["scp with a port-like host", "git@github.com:22:a/b"],
    // shape
    ["empty", ""],
    ["blank", "   "],
    ["name only", "svc"],
    ["owner only", "acme/"],
    ["leading slash", "/acme"],
    ["three parts", "a/b/c"],
    ["empty part", "a//b"],
    ["trailing slash", "acme/svc/"],
    ["tree url", "https://github.com/acme/svc/tree/main"],
    ["query", "https://github.com/acme/svc?tab=readme"],
    ["fragment", "acme/svc#readme"],
    ["name is .git", "acme/.git"],
    ["double dot inside the owner", "a..b/c"],
    ["double dot inside the name", "a/b..c"],
    // characters
    ["space", "acme/svc x"],
    ["newline", "acme/svc\nx"],
    ["nul", "acme/svc\0x"],
    ["semicolon", "acme/x;touch /tmp/pwned"],
    ["command substitution", "acme/$(touch x)"],
    ["backtick", "acme/`touch x`"],
    ["pipe", "acme/x|y"],
    ["ampersand", "acme/x&y"],
    ["glob", "acme/*"],
    ["cyrillic lookalike", "acm\u0435/x"],
    ["unicode name", "acme/caf\u00e9"],
    ["too long", `a/${"b".repeat(400)}`],
    ["name too long", `a/${"b".repeat(101)}`],
    // not text
    ["undefined", undefined],
    ["number", 5],
    ["object", { owner: "a", name: "b" }],
    ["array", ["a/b"]],
];

for (const [what, input] of refused) {
    test(`clone repo refused: ${what}`, () => {
        assert.throws(
            () => parseCloneRepo(input, HOST),
            (error: unknown) =>
                error instanceof Error &&
                /^clone/.test(error.message) &&
                !error.message.includes("\n") &&
                !error.message.includes("CANARY"),
        );
    });
}

test("clone refusals say what is accepted, and name the host that is not allowed without its credentials", () => {
    assert.throws(
        () => parseCloneRepo("https://gitlab.com/a/b", HOST),
        /^Error: clone: only github\.com repositories can be cloned \(got host "gitlab\.com"\); repo must be owner\/name, git@<host>:owner\/name\.git or https:\/\/github\.com\/owner\/name$/,
    );
    assert.throws(
        () => parseCloneRepo("https://user:pw-CANARY@gitlab.com/a/b", HOST),
        (error: unknown) =>
            error instanceof Error && /got host "gitlab\.com"/.test(error.message) && !error.message.includes("CANARY"),
    );
    assert.throws(() => parseCloneRepo(undefined, HOST), /^Error: clone needs repo: owner\/name/);
    assert.throws(
        () => parseCloneRepo("svc", HOST),
        /repo must be owner\/name, git@<host>:owner\/name\.git or https:\/\/github\.com\/owner\/name \(got "svc"\)$/,
    );
    assert.throws(
        () => parseCloneRepo("_a/b", HOST),
        /^Error: clone: the repository owner may use only letters, digits, \. _ and -, must start with a letter or digit and must not contain \.\. \(got "_a"\)$/,
    );
    assert.throws(
        () => parseCloneRepo("a/b..c", HOST),
        /^Error: clone: the repository name may use only letters, digits, \. _ and -, must not start with - and must not contain \.\. \(got "b\.\.c"\)$/,
    );
});

test("the configured clone host is the only other host an ssh or https URL may name", () => {
    assert.deepEqual(parseCloneRepo("git@gh-work:acme/svc.git", "gh-work"), {
        owner: "acme",
        name: "svc",
        slug: "acme/svc",
    });
    assert.deepEqual(parseCloneRepo("git@github.com:acme/svc.git", "gh-work"), {
        owner: "acme",
        name: "svc",
        slug: "acme/svc",
    });
    assert.throws(
        () => parseCloneRepo("git@gh-other:acme/svc.git", "gh-work"),
        /only github\.com and gh-work repositories can be cloned \(got host "gh-other"\)/,
    );
});

test("the url git gets is built from the configured host: the host in the request is checked, then dropped", () => {
    const target = parseCloneRepo("git@github.com:acme/svc.git", "gh-work");
    assert.equal(cloneUrl(target, "gh-work"), "git@gh-work:acme/svc.git");
    assert.equal(cloneUrl(parseCloneRepo("https://github.com/acme/x", HOST), HOST), "git@github.com:acme/x.git");
});

test("dir defaults to the repository name and must be one folder name that a later call can use", () => {
    const target = parseCloneRepo("acme/svc", HOST);
    assert.equal(checkCloneDir(undefined, target), "svc");
    for (const ok of ["svc", "my.repo", "a_b", "A-1", "x".repeat(100)]) assert.equal(checkCloneDir(ok, target), ok);
    for (const bad of [
        "a/b",
        "..",
        ".",
        "",
        "-rf",
        "/abs",
        "/",
        ".hidden",
        "a b",
        "x..y",
        "foo.git",
        "a\nb",
        "a\0b",
        "x".repeat(101),
        "~",
        "a;b",
        5,
        null,
        {},
    ]) {
        assert.throws(
            () => checkCloneDir(bad, target),
            (error: unknown) => error instanceof Error && /^clone: dir must be one folder name/.test(error.message),
            `dir ${JSON.stringify(bad)}`,
        );
    }
    assert.throws(
        () => checkCloneDir(undefined, parseCloneRepo("acme/.github", HOST)),
        /^Error: clone: acme\/\.github does not make a usable folder name; pass dir/,
    );
    assert.equal(checkCloneDir("github-meta", parseCloneRepo("acme/.github", HOST)), "github-meta");
});

test("the argument list: one transport, no submodules, the branch as an option, and -- before the url and the folder", () => {
    assert.deepEqual(cloneArgs("git@github.com:acme/svc.git", "/w/.jig-clone-1", undefined), [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.ssh.allow=always",
        "clone",
        "--no-recurse-submodules",
        "--",
        "git@github.com:acme/svc.git",
        "/w/.jig-clone-1",
    ]);
    assert.deepEqual(cloneArgs("git@h:a/b.git", "/t", "release/1.2").slice(4, 9), [
        "clone",
        "--no-recurse-submodules",
        "--branch",
        "release/1.2",
        "--",
    ]);
});

test("the failure wording is plain text over the host and repository, whatever git said", () => {
    const say = (stderr: string) => cloneFailure(stderr, "gh-work", "acme/svc", "nope", "/w/.jig-clone-1", "/w/svc");
    assert.equal(
        say("Permission denied (publickey).\ngit@gh-work: ssh-ed25519 SHA256:KEYMATERIAL"),
        'SSH authentication to gh-work failed: check "ssh -T git@gh-work" in your terminal',
    );
    assert.ok(!say("Permission denied (publickey).\nKEYMATERIAL").includes("KEYMATERIAL"));
    assert.equal(
        say("Host key verification failed.\r\nfatal: Could not read from remote repository."),
        'SSH does not know the host key of gh-work: run "ssh -T git@gh-work" in your terminal once and accept it',
    );
    assert.equal(
        say("ssh: Could not resolve hostname gh-work: Name or service not known"),
        "SSH host gh-work does not resolve: it must be github.com or a Host alias in ~/.ssh/config (git.cloneHost sets it)",
    );
    assert.equal(
        say("ERROR: Repository not found."),
        "acme/svc was not found, or the ssh key of gh-work cannot read it",
    );
    assert.equal(say("fatal: Remote branch nope not found in upstream origin"), "nope does not exist in acme/svc");
    assert.equal(
        say("ssh: connect to host gh-work port 22: Connection timed out"),
        "Could not reach gh-work: check the network and VPN, then retry",
    );
    assert.equal(
        say("fatal: could not create work tree dir '/w/.jig-clone-1': Permission denied"),
        "git clone failed: fatal: could not create work tree dir '/w/svc': Permission denied",
    );
    assert.equal(
        say(
            "Cloning into '/w/.jig-clone-1'...\nReceiving objects:  45% (45/100)\rReceiving objects: 100% (100/100)\nerror: unable to write file x\nfatal: cannot create file: No space left on device",
        ),
        "git clone failed: error: unable to write file x; fatal: cannot create file: No space left on device",
    );
    assert.equal(
        say("fatal: unable to access 'https://user:tok-CANARY@example.com/x': nope"),
        "git clone failed: fatal: unable to access 'https://example.com/x': nope",
    );
    assert.equal(say(""), "git clone failed: no reason given");
});

// ---- the clone itself, over a fake ssh ----------------------------------------------------------------------------

let h: Harness;
let github: FakeGithub;

before(() => {
    h = setupHarness();
    github = installFakeGithub(h.sb);
});
beforeEach(() => {
    h.reset();
    github.mode("serve");
    h.jig.setSection("git", { cloneHost: "gh-test" });
    for (const name of fs.readdirSync(h.sb.workspace))
        fs.rmSync(path.join(h.sb.workspace, name), { recursive: true, force: true });
    github.clear();
});
after(() => h.cleanup());

const folders = () => fs.readdirSync(h.sb.workspace);
const clone = (input: Record<string, unknown>) => h.call("git", { action: "clone", ...input });

test("clone: a repository into a new folder named after it, over ssh as the configured host", async () => {
    github.addRepo("acme/svc");
    const result = await clone({ repo: "acme/svc" });
    const dest = path.join(h.sb.workspace, "svc");
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["local", "write"]);
    assert.equal(
        result.text,
        `Cloned acme/svc into ${dest} (default branch main, HEAD ${git(dest, "rev-parse", "--short", "HEAD")}). Read its AGENTS.md or README before working in it.`,
    );
    assert.deepEqual(folders(), ["svc"], "renamed into place; no temporary folder left");
    assert.equal(git(dest, "remote", "get-url", "origin"), "git@gh-test:acme/svc.git");
    assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), "# acme/svc\n");
    assert.match(github.sshCalls()[0] ?? "", /git@gh-test/);
    const cloneCall = h.jig.started_processes.find((p) => p.args.includes("clone"));
    assert.deepEqual(cloneCall?.args.slice(0, 6), [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.ssh.allow=always",
        "clone",
        "--no-recurse-submodules",
    ]);
    assert.equal(cloneCall?.cwd, h.sb.workspace);
    assert.match(cloneCall?.args.at(-1) ?? "", /\.jig-clone-[0-9a-f]{12}$/);
});

test("clone: a URL, another folder name, a branch, a tag and an empty repository", async () => {
    github.addRepo("acme/svc", { branches: ["release/1"], tags: ["v1.2.0"] });
    github.addRepo("acme/new", { empty: true });
    assert.match(
        ok(await clone({ repo: "https://github.com/acme/svc", dir: "svc-r", branch: "release/1" })),
        /\(branch release\/1, HEAD [0-9a-f]{7}\)/,
    );
    assert.equal(git(path.join(h.sb.workspace, "svc-r"), "branch", "--show-current"), "release/1");
    assert.match(
        ok(await clone({ repo: "git@github.com:acme/svc.git", dir: "svc-t", branch: "v1.2.0" })),
        /\(v1\.2\.0 detached, HEAD [0-9a-f]{7}\)/,
    );
    assert.match(
        ok(await clone({ repo: "acme/new" })),
        /^Cloned acme\/new into .*\/new \(empty repository, no commits yet\)\.$/,
    );
    assert.deepEqual(folders().sort(), ["new", "svc-r", "svc-t"]);
});

test("clone: a folder that exists is refused before any connection, and a clone can be named afterwards", async () => {
    github.addRepo("acme/svc");
    fs.mkdirSync(path.join(h.sb.workspace, "svc"));
    const result = await clone({ repo: "acme/svc" });
    assert.match(
        result.error?.message ?? "",
        new RegExp(
            `${path.join(h.sb.workspace, "svc")} already exists; nothing was cloned\\. Use that folder, or pass another dir`,
        ),
    );
    assert.deepEqual(github.sshCalls(), [], "no connection was made");
    ok(await clone({ repo: "acme/svc", dir: "svc2" }));
    assert.match(ok(await h.call("git", { action: "log", repo: "svc2" })), /Initial commit/);
});

test("clone: refusals happen before anything runs", async () => {
    for (const repo of ["ext::sh -c 'touch /tmp/pwned' %S", "https://gitlab.com/a/b", "../x", "acme/svc x"]) {
        assert.ok((await clone({ repo })).error, repo);
    }
    assert.match(
        (await clone({ repo: "acme/.github" })).error?.message ?? "",
        /does not make a usable folder name; pass dir/,
    );
    assert.deepEqual(github.sshCalls(), []);
    assert.equal(h.jig.started_processes.filter((p) => p.args.includes("clone")).length, 0);
    assert.deepEqual(folders(), []);
});

const failures: Array<[string, SshModeName, string | RegExp]> = [
    [
        "a key ssh did not accept",
        "deny",
        'SSH authentication to gh-test failed: check "ssh -T git@gh-test" in your terminal',
    ],
    [
        "an alias that does not exist",
        "unresolvable",
        /^SSH host gh-test does not resolve: it must be github\.com or a Host alias in ~\/\.ssh\/config \(git\.cloneHost sets it\)$/,
    ],
];
type SshModeName = "deny" | "unresolvable";

for (const [what, mode, expected] of failures) {
    test(`a failed clone (${what}) says one thing and leaves nothing behind`, async () => {
        github.addRepo("acme/svc");
        github.mode(mode);
        const result = await clone({ repo: "acme/svc" });
        if (typeof expected === "string") assert.equal(result.error?.message, expected);
        else assert.match(result.error?.message ?? "", expected);
        assert.deepEqual(folders(), [], "no half-made folder");
    });
}

test("a repository the server does not have is reported as not found, or not readable by the key", async () => {
    const result = await clone({ repo: "acme/missing" });
    assert.match(
        result.error?.message ?? "",
        /^acme\/missing was not found, or the ssh key of gh-test cannot read it$/,
    );
    assert.deepEqual(folders(), []);
});

test("a branch that does not exist is reported", async () => {
    github.addRepo("acme/svc");
    assert.match(
        (await clone({ repo: "acme/svc", branch: "nope" })).error?.message ?? "",
        /^nope does not exist in acme\/svc$/,
    );
    assert.deepEqual(folders(), []);
});

test("Esc stops git and its ssh, removes the temporary folder and creates nothing", async () => {
    github.addRepo("acme/svc");
    github.mode("hang");
    const controller = new AbortController();
    // Esc is pressed once the fake ssh is running and waiting.
    void (async () => {
        for (let waited = 0; github.sshPid() === undefined && waited < 10_000; waited += 25)
            await new Promise((resolve) => setTimeout(resolve, 25));
        controller.abort();
    })();
    const result = await h.call(
        "git",
        { action: "clone", repo: "acme/svc", dir: "svc-aborted" },
        { signal: controller.signal },
    );
    assert.match(result.error?.message ?? "", /^git clone was aborted; nothing was created$/);
    const pid = github.sshPid();
    assert.ok(pid !== undefined, "the fake ssh started");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(pid), false, "the ssh process was stopped with git");
    assert.deepEqual(folders(), [], "neither the folder nor a temporary one is left");
});

test("a timeout is reported as one, and cleans up", async () => {
    github.addRepo("acme/svc");
    github.mode("hang");
    h.jig.forceTimeout(600, (file, args) => file === "git" && args.includes("clone"));
    const result = await clone({ repo: "acme/svc" });
    assert.match(result.error?.message ?? "", /^git clone timed out after 600s; nothing was created$/);
    assert.deepEqual(folders(), []);
});
