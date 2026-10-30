// The review offered after the agent's turn: it shows what the agent just changed, even when a ticket is active and its
// branch holds many earlier commits. The whole branch is the explicit /code-review before a push.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { ReviewCoordinator } from "../src/coordinator.ts";
import type { Git } from "../src/git.ts";
import { MAX_CHANGED_PATHS } from "../src/run-changes.ts";
import { workspaceDirFor } from "../src/settings.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";
import { context, fakeHost } from "./support/harness.ts";
import { git } from "./support/git.ts";
import type { Session } from "./support/harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];
let jig: FakeJig;
const roots = new Map<string, string>();
const reviewsDirOf = (workspaceRoot: string): string =>
    path.join(workspaceDirFor(roots.get(workspaceRoot)!, workspaceRoot), "reviews");

type Stored = {
    fileScope: string;
    ticket?: string;
    heads?: string;
    headSha?: string;
    iterations: Array<{ diff: string }>;
};
const readRecords = (workspaceRoot: string): Stored[] => {
    const dir = reviewsDirOf(workspaceRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Stored);
};
const filesOf = (diff: string): string[] => [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]!);

before(() => {
    jig = installFakeJig();
});
after(() => jig.remove());
beforeEach(() => {
    process.env.BROWSER = "true";
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    delete process.env.BROWSER;
});

/** A workspace with one repository `orders-api` on `develop`, and a coordinator in it that accepts the offer. */
function newWorkspace(mode: "tui" | "print" = "tui", options: { git?: Git; entries?: unknown[] } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "jig-review-offer-"));
    const agentRoot = mkdtempSync(path.join(os.tmpdir(), "jig-review-root-"));
    roots.set(root, agentRoot);
    const repo = path.join(root, "orders-api");
    git(root, "init", "-q", "-b", "develop", repo);
    for (const file of ["Service.java", "Other.java", "Dirty.java"]) writeFileSync(path.join(repo, file), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    const host = fakeHost();
    const coordinator = new ReviewCoordinator(host.pi, root, {
        root: agentRoot,
        ...(options.git ? { git: options.git } : {}),
    });
    coordinator.register();
    const session = context(root, mode, options.entries);
    session.answer = (title) => title === "Review generated code?";
    cleanups.push(async () => {
        await host.fire("session_shutdown", session.ctx);
        rmSync(root, { recursive: true, force: true });
        rmSync(agentRoot, { recursive: true, force: true });
    });
    return { root, repo, host, session, coordinator };
}

type ToolCall = { toolName: string; input: Record<string, unknown> };

/** One agent run: `change` stands for whatever the agent does (bash, the user's editor), and the calls are what Pi saw. */
function runner(w: ReturnType<typeof newWorkspace>) {
    return async (
        change: () => void,
        toolEdits: string[] = [],
        calls: ToolCall[] = [{ toolName: "bash", input: { command: `cd ${w.repo} && ./gradlew build` } }],
    ): Promise<void> => {
        await w.host.fire("agent_start", w.session.ctx);
        await w.coordinator.runStartTaken();
        change();
        for (const file of toolEdits)
            await w.host.fire("tool_call", w.session.ctx, {
                toolName: "edit",
                input: { path: path.join(w.repo, file) },
            });
        for (const call of calls) await w.host.fire("tool_call", w.session.ctx, call);
        await w.host.fire("agent_end", w.session.ctx);
    };
}

/** Files the review records on disk cover, as paths from Pi's folder; every record must be a touched review. */
function reviewed(root: string): string[] {
    const records = readRecords(root);
    assert.ok(records.every((record) => record.fileScope === "touched"));
    return records.flatMap((record) => filesOf(record.iterations.at(-1)?.diff ?? "")).sort();
}

const linkNotice = (session: Session): boolean =>
    session.notices.some((notice) => notice.startsWith("Interactive review ready: "));

test("after a two-file edit on a ticket branch with earlier commits, the offer reviews those two files only", async () => {
    const w = newWorkspace();
    for (const file of ["ServiceTest.java", "Earlier.java"]) writeFileSync(path.join(w.repo, file), "one\n");
    git(w.repo, "add", ".");
    git(w.repo, "commit", "-q", "-m", "more files");
    git(w.repo, "checkout", "-q", "-b", "feature/PROJ-7");
    writeFileSync(path.join(w.repo, "Earlier.java"), "one\nearlier ticket work\n");
    git(w.repo, "commit", "-q", "-am", "PROJ-7 earlier work");
    writeFileSync(path.join(w.repo, "Service.java"), "one\nnow\n");
    writeFileSync(path.join(w.repo, "ServiceTest.java"), "one\nnow\n");

    for (const file of ["Service.java", "ServiceTest.java"])
        await w.host.fire("tool_call", w.session.ctx, { toolName: "edit", input: { path: path.join(w.repo, file) } });
    await w.host.fire("agent_end", w.session.ctx);

    assert.ok(linkNotice(w.session), w.session.notices.join(" | "));
    const [record, ...others] = readRecords(w.root);
    assert.equal(others.length, 0);
    assert.equal(record?.fileScope, "touched");
    assert.deepEqual(
        filesOf(record!.iterations.at(-1)!.diff)
            .map((file) => path.basename(file))
            .sort(),
        ["Service.java", "ServiceTest.java"],
        "the earlier commit on the branch is not in it",
    );
    assert.match(w.session.asked[0] ?? "", /changed 2 files/);
});

test("the agent's start tool opens the ticket's branch review itself; only the user gets its link", async () => {
    const tickets = mkdtempSync(path.join(os.tmpdir(), "jig-review-tickets-"));
    cleanups.push(() => rmSync(tickets, { recursive: true, force: true }));
    jig.setSection("memory", { folder: tickets });
    const entries = [{ type: "custom", customType: "jig-memory-ticket", data: { key: "PROJ-7" } }];
    const w = newWorkspace("tui", { entries });
    mkdirSync(path.join(tickets, "PROJ-7"));
    writeFileSync(path.join(tickets, "PROJ-7", "ticket.json"), JSON.stringify({ repositories: ["orders-api"] }));
    git(w.repo, "checkout", "-q", "-b", "feature/PROJ-7");
    writeFileSync(path.join(w.repo, "Service.java"), "one\nticket work\n");
    git(w.repo, "commit", "-q", "-am", "PROJ-7 work");

    const result = await w.host.tool("start_interactive_code_review", {}, w.session.ctx);

    // The link carries the server's secret: the agent must not get it.
    assert.equal(
        result.content[0]!.text,
        "Review opened in the user's browser. Ask the user to review and approve it there.",
    );
    assert.doesNotMatch(JSON.stringify(result), /http|localhost|127\.0\.0\.1|[?&]k=/);
    assert.ok(
        w.session.notices.some((notice) =>
            /^Interactive review ready: http:\/\/localhost:\d+\/\S+[?&]k=\S+$/.test(notice),
        ),
        `the user gets the link: ${w.session.notices.join(" | ")}`,
    );
    assert.ok(!w.host.sent.includes("/code-review"), "nothing is posted as a chat message");
    const [record] = readRecords(w.root);
    assert.equal(record?.fileScope, "branch");
    assert.equal(record?.ticket, "PROJ-7");
    assert.match(record!.iterations.at(-1)!.diff, /^\+ticket work$/m);
});

test("the start tool says why when there is nothing to review", async () => {
    const w = newWorkspace();
    const result = await w.host.tool("start_interactive_code_review", {}, w.session.ctx);
    assert.equal(result.content[0]!.text, "The review did not open: No git changes found to review.");
});

test("an active ticket that jig-memory has no bound repositories for says what ticket scope needs", async () => {
    const tickets = mkdtempSync(path.join(os.tmpdir(), "jig-review-tickets-"));
    cleanups.push(() => rmSync(tickets, { recursive: true, force: true }));
    jig.setSection("memory", { folder: tickets });
    const entries = [{ type: "custom", customType: "jig-memory-ticket", data: { key: "PROJ-9" } }];
    const w = newWorkspace("tui", { entries });
    writeFileSync(path.join(w.repo, "Service.java"), "one\nuncommitted\n");
    const result = await w.host.tool("start_interactive_code_review", {}, w.session.ctx);
    assert.match(
        result.content[0]!.text,
        /^The review did not open: Ticket scope needs jig-memory with bound repositories: PROJ-9 has none/,
    );
    assert.deepEqual(readRecords(w.root), []);
});

test("files changed only through bash are offered: a modified file and a new one, not the agent's own files", async () => {
    const w = newWorkspace();
    await runner(w)(() => {
        writeFileSync(path.join(w.repo, "Service.java"), "one\nreplaced by python\n");
        writeFileSync(path.join(w.repo, "Created.java"), "cat > file\n");
        mkdirSync(path.join(w.repo, ".pi"));
        writeFileSync(path.join(w.repo, ".pi", "notes.md"), "evidence\n");
    });
    assert.deepEqual(reviewed(w.root), ["orders-api/Created.java", "orders-api/Service.java"]);
    assert.ok(linkNotice(w.session), w.session.notices.join(" | "));
    assert.match(w.session.asked[0] ?? "", /changed 2 files/);
});

test("changes the agent committed during the run are reviewed from where the run started", async () => {
    const w = newWorkspace();
    await runner(w)(() => {
        writeFileSync(path.join(w.repo, "Service.java"), "one\nfixed and committed\n");
        writeFileSync(path.join(w.repo, "ServiceTest.java"), "new test\n");
        git(w.repo, "add", ".");
        git(w.repo, "commit", "-q", "-m", "PROJ-7 Address review");
        writeFileSync(path.join(w.repo, "Other.java"), "one\nafter the commit\n");
    });
    assert.deepEqual(reviewed(w.root), [
        "orders-api/Other.java",
        "orders-api/Service.java",
        "orders-api/ServiceTest.java",
    ]);
    assert.match(readRecords(w.root)[0]!.iterations.at(-1)!.diff, /^\+fixed and committed$/m);
});

test("a run whose changes come to nothing opens no review", async () => {
    const w = newWorkspace();
    await runner(w)(() => {
        writeFileSync(path.join(w.repo, "Service.java"), "one\nchanged\n");
        git(w.repo, "add", ".");
        git(w.repo, "commit", "-q", "-m", "change");
        git(w.repo, "revert", "--no-edit", "HEAD");
    });
    assert.deepEqual(reviewed(w.root), []);
    assert.ok(!linkNotice(w.session), w.session.notices.join(" | "));
});

test("the diff of a bash-created file is the same added-file diff an edit would give", async () => {
    const w = newWorkspace();
    await runner(w)(() => writeFileSync(path.join(w.repo, "Created.java"), "line\n"));
    const diff = readRecords(w.root)[0]!.iterations.at(-1)!.diff;
    assert.match(diff, /^--- a\/orders-api\/Created\.java$/m);
    assert.match(diff, /^\+\+\+ b\/orders-api\/Created\.java$/m);
    assert.match(diff, /^\+line$/m);
});

test("a deleted file is offered too", async () => {
    const w = newWorkspace();
    await runner(w)(() => rmSync(path.join(w.repo, "Other.java")));
    assert.deepEqual(reviewed(w.root), ["orders-api/Other.java"]);
});

test("a file that was dirty before the run and untouched during it is not offered", async () => {
    const w = newWorkspace();
    writeFileSync(path.join(w.repo, "Dirty.java"), "one\nhand edit before the run\n");
    writeFileSync(path.join(w.repo, "Untracked.java"), "before\n");
    await runner(w)(() => writeFileSync(path.join(w.repo, "Service.java"), "one\nnow\n"));
    assert.deepEqual(reviewed(w.root), ["orders-api/Service.java"]);
});

test("a file that was dirty before the run and changed again during it is offered", async () => {
    const w = newWorkspace();
    writeFileSync(path.join(w.repo, "Dirty.java"), "one\nhand edit before the run\n");
    await runner(w)(() =>
        writeFileSync(path.join(w.repo, "Dirty.java"), "one\nhand edit before the run\nand the agent's\n"),
    );
    assert.deepEqual(reviewed(w.root), ["orders-api/Dirty.java"]);
});

test("the edit tool still counts alone, and together with bash changes", async () => {
    const alone = newWorkspace();
    writeFileSync(path.join(alone.repo, "Service.java"), "one\nedited\n");
    await alone.host.fire("tool_call", alone.session.ctx, {
        toolName: "edit",
        input: { path: path.join(alone.repo, "Service.java") },
    });
    await alone.host.fire("agent_end", alone.session.ctx);
    assert.deepEqual(reviewed(alone.root), ["orders-api/Service.java"]);

    const both = newWorkspace();
    await runner(both)(
        () => {
            writeFileSync(path.join(both.repo, "Service.java"), "one\nedited\n");
            writeFileSync(path.join(both.repo, "Other.java"), "one\nbash\n");
        },
        ["Service.java"],
        [],
    );
    assert.deepEqual(reviewed(both.root), ["orders-api/Other.java", "orders-api/Service.java"]);
    assert.match(both.session.asked[0] ?? "", /changed 2 files/);
});

test("no offer when the run changed nothing, even with files dirty from before", async () => {
    const w = newWorkspace();
    writeFileSync(path.join(w.repo, "Dirty.java"), "one\nbefore\n");
    await runner(w)(() => {});
    assert.deepEqual(w.session.asked, []);
    assert.deepEqual(w.session.notices, []);
    assert.deepEqual(reviewed(w.root), []);
});

test("a repository with more changed paths than the bound is skipped without an error", async () => {
    const w = newWorkspace();
    mkdirSync(path.join(w.repo, "generated"));
    for (let i = 0; i <= MAX_CHANGED_PATHS; i++) writeFileSync(path.join(w.repo, "generated", `f${i}.txt`), "x\n");
    await runner(w)(() => writeFileSync(path.join(w.repo, "Service.java"), "one\nnow\n"));
    assert.deepEqual(w.session.asked, []);
    assert.deepEqual(w.session.notices, []);
});

test("a one-shot print run does not look at git", async () => {
    const w = newWorkspace("print");
    await runner(w)(() => writeFileSync(path.join(w.repo, "Service.java"), "one\nnow\n"));
    assert.deepEqual(w.session.asked, []);
    assert.deepEqual(w.session.notices, []);
});

test("a git that fails leaves the run without the comparison and tells the user nothing", async () => {
    const broken: Git = async () => {
        throw new Error("jig-core refused: .git/config sets core.sshcommand");
    };
    const w = newWorkspace("tui", { git: broken });
    await runner(w)(() => writeFileSync(path.join(w.repo, "Service.java"), "one\nnow\n"));
    assert.deepEqual(w.session.notices, []);
    assert.deepEqual(w.session.asked, []);
});

// Several Pi sessions can share one workspace: only the repositories this run used are compared.
function sharedWorkspace() {
    const w = newWorkspace();
    const other = path.join(path.dirname(w.repo), "payments-api");
    git(path.dirname(w.repo), "init", "-q", "-b", "develop", other);
    for (const file of ["Payment.java", "Dirty.java"]) writeFileSync(path.join(other, file), "one\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "init");
    const usedByBash: ToolCall = { toolName: "bash", input: { command: `cd ${w.repo} && ./gradlew build` } };
    return { ...w, other, usedByBash, run: runner(w) };
}

test("a file another session changes in a repository this run did not use is not offered", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => {
            writeFileSync(path.join(w.repo, "Service.java"), "one\nthis run\n");
            writeFileSync(path.join(w.other, "Payment.java"), "one\nthe other session\n");
        },
        [],
        [w.usedByBash],
    );
    assert.deepEqual(reviewed(w.root), ["orders-api/Service.java"]);
    assert.match(w.session.asked[0] ?? "", /changed 1 file\./);
});

test("a file dirty before the run and committed by someone else in an unused repository is not offered", async () => {
    const w = sharedWorkspace();
    writeFileSync(path.join(w.other, "Dirty.java"), "one\nhalf done\n");
    await w.run(
        () => {
            git(w.other, "commit", "-q", "-am", "PROJ-1 finished by the other session");
        },
        [],
        [w.usedByBash],
    );
    assert.deepEqual(reviewed(w.root), []);
    assert.deepEqual(w.session.asked, []);
    assert.deepEqual(w.session.notices, []);
});

test("a commit this run made in a repository it used is offered, and another session's commit in an unused one is not", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => {
            writeFileSync(path.join(w.repo, "Service.java"), "one\ncommitted by this run\n");
            git(w.repo, "commit", "-q", "-am", "this run");
            writeFileSync(path.join(w.other, "Payment.java"), "one\ncommitted elsewhere\n");
            git(w.other, "commit", "-q", "-am", "other session");
        },
        [],
        [w.usedByBash],
    );
    assert.deepEqual(reviewed(w.root), ["orders-api/Service.java"]);
});

test("the git tool's repo parameter marks a repository used, by name or by absolute path", async () => {
    for (const repoParam of ["payments-api", "path"] as const) {
        const w = sharedWorkspace();
        await w.run(
            () => writeFileSync(path.join(w.other, "Payment.java"), "one\nviaBash\n"),
            [],
            [{ toolName: "git", input: { action: "status", repo: repoParam === "path" ? w.other : "payments-api" } }],
        );
        assert.deepEqual(reviewed(w.root), ["payments-api/Payment.java"], repoParam);
    }
});

test("a git call for another repository does not mark this one used", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => writeFileSync(path.join(w.repo, "Service.java"), "one\nviaBash\n"),
        [],
        [{ toolName: "git", input: { action: "status", repo: "payments-api" } }],
    );
    assert.deepEqual(reviewed(w.root), []);
});

test("a run that used no repository finds no git changes", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => writeFileSync(path.join(w.repo, "Service.java"), "one\nsomeone else\n"),
        [],
        [{ toolName: "bash", input: { command: "ls ~/dev" } }],
    );
    assert.deepEqual(reviewed(w.root), []);
    assert.deepEqual(w.session.asked, []);
    assert.deepEqual(w.session.notices, []);
});

test("a bash call that cds into a repository with a relative directory uses it", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => writeFileSync(path.join(w.other, "Payment.java"), "one\nsed -i\n"),
        [],
        [{ toolName: "bash", input: { command: "cd payments-api && sed -i s/one/two/ Payment.java" } }],
    );
    assert.deepEqual(reviewed(w.root), ["payments-api/Payment.java"]);
});

test("the review's head label names the repository the run committed in, not a dirty repository another session works in", async () => {
    const w = sharedWorkspace();
    await w.run(
        () => {
            writeFileSync(path.join(w.repo, "Service.java"), "one\ncommitted by this run\n");
            git(w.repo, "commit", "-q", "-am", "this run");
            writeFileSync(path.join(w.other, "Payment.java"), "one\nuncommitted elsewhere\n");
        },
        [],
        [w.usedByBash],
    );
    const [record] = readRecords(w.root);
    assert.equal(record?.heads, `orders-api@${git(w.repo, "rev-parse", "HEAD").trim().slice(0, 12)}`);
    assert.equal(record?.headSha, "workspace");
});
