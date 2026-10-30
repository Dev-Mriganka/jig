// Asking about a write to an ask-first folder: after the command, in the waiting call, one question at a time, and the
// answer widens the rules from the next command.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAllowed } from "../src/allowed.ts";
import { createAsker } from "../src/ask.ts";
import type { Rule } from "../src/rules.ts";
import { fakeContext } from "./support/fake-pi.ts";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { makeWorld } from "./support/world.ts";

const skip = skipUnlessRealSandbox();

describe("the question", () => {
    let root: string;
    let home: string;
    beforeEach(() => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-ask-test-")));
        home = path.join(root, "home");
        mkdirSync(path.join(home, ".sdkman"), { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const rule = (): Rule => ({
        kind: "ask-first",
        path: path.join(home, ".sdkman"),
        named: path.join(home, ".sdkman"),
        shown: "~/.sdkman",
        reason: "programs installed there are on your PATH and run outside the sandbox later",
        way: "",
        source: "built in",
        floor: false,
    });

    test("it names the folder that was refused, says why it matters, and offers this session, always and no", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const { ctx, screen } = fakeContext({ cwd: home, select: () => "No" });
        await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "candidates", "java"));
        assert.deepEqual(screen.selects, [
            {
                title: [
                    "bash was stopped from writing ~/.sdkman/candidates/java.",
                    "Programs installed there are on your PATH and run outside the sandbox later.",
                    "Allow writes to ~/.sdkman?",
                ].join("\n"),
                options: ["This session", "Always", "No"],
            },
        ]);
    });

    test("this session: allowed in memory only, and the agent is told to run it again", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const { ctx } = fakeContext({ cwd: home, select: () => "This session" });
        const lines = await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x"));
        assert.deepEqual(lines, [
            "[sandbox] the user allowed writes to ~/.sdkman for this session; run the command again.",
        ]);
        assert.deepEqual(allowed.folders(), [path.join(home, ".sdkman")]);
        assert.equal(existsSync(path.join(root, "agent", "jig-sandbox", "allowed.json")), false);
    });

    test("always: kept in the agent folder, with a private mode", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const { ctx } = fakeContext({ cwd: home, select: () => "Always" });
        const lines = await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x"));
        assert.match(lines[0] ?? "", /allowed writes to ~\/\.sdkman always; run the command again/);
        const file = path.join(root, "agent", "jig-sandbox", "allowed.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { folders: [path.join(home, ".sdkman")] });
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        // A new session reads it back.
        assert.deepEqual(createAllowed(() => path.join(root, "agent")).folders(), [path.join(home, ".sdkman")]);
    });

    test("always, when the answer cannot be kept: for this session, and the user is told", async () => {
        const blocker = path.join(root, "agent");
        writeBlocker(blocker);
        const allowed = createAllowed(() => blocker);
        const { ctx } = fakeContext({ cwd: home, select: () => "Always" });
        const lines = await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x"));
        assert.match(lines[0] ?? "", /for this session only, since the answer could not be kept/);
        assert.deepEqual(allowed.folders(), [path.join(home, ".sdkman")]);
    });

    test("no, and a question closed without an answer: refused, and the agent is told not to look for another way", async () => {
        for (const answer of ["No", undefined]) {
            const allowed = createAllowed(() => path.join(root, "agent"));
            const { ctx } = fakeContext({ cwd: home, select: () => answer });
            const lines = await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x"));
            assert.match(
                lines[0] ?? "",
                /writes to ~\/\.sdkman stay refused: the user said no.* Do not try another way round it\./,
            );
            assert.deepEqual(allowed.folders(), []);
        }
    });

    test("with no screen the answer is no, and the line says how a person allows it", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const { ctx, screen } = fakeContext({ cwd: home, ui: false });
        const lines = await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x"));
        assert.deepEqual(lines, [
            "[sandbox] writes to ~/.sdkman are not allowed, and there is no screen to ask on. A person can allow them with /sandbox allowed add ~/.sdkman.",
        ]);
        assert.deepEqual(screen.selects, []);
    });

    test("questions that come at the same time wait in line, and a folder allowed meanwhile is not asked about again", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        let open = 0;
        let mostOpen = 0;
        const { ctx, screen } = fakeContext({ cwd: home });
        (ctx.ui as unknown as { select: unknown }).select = async (title: string, choices: string[]) => {
            screen.selects.push({ title, options: choices });
            open++;
            mostOpen = Math.max(mostOpen, open);
            await new Promise((resolve) => setTimeout(resolve, 20));
            open--;
            return "This session";
        };
        const asker = createAsker(allowed, () => home);
        const [first, second, third] = await Promise.all([
            asker.ask(ctx, rule(), path.join(home, ".sdkman", "a")),
            asker.ask(ctx, rule(), path.join(home, ".sdkman", "b")),
            asker.ask(ctx, rule(), path.join(home, ".sdkman", "c")),
        ]);
        assert.equal(mostOpen, 1, "one question at a time");
        assert.equal(screen.selects.length, 1, "the others found the folder allowed");
        assert.match(first?.[0] ?? "", /allowed writes to ~\/\.sdkman for this session/);
        assert.match(second?.[0] ?? "", /writes to ~\/\.sdkman are allowed now; run the command again/);
        assert.match(third?.[0] ?? "", /are allowed now/);
    });

    test("a question is not asked of a run that was aborted", async () => {
        const allowed = createAllowed(() => path.join(root, "agent"));
        const { ctx, screen } = fakeContext({ cwd: home });
        (ctx as { signal: AbortSignal | undefined }).signal = AbortSignal.abort();
        assert.deepEqual(await createAsker(allowed, () => home).ask(ctx, rule(), path.join(home, ".sdkman", "x")), []);
        assert.deepEqual(screen.selects, []);
    });

    test("allowed.json that is damaged allows nothing, and /sandbox says so", async () => {
        mkdirSync(path.join(root, "agent", "jig-sandbox"), { recursive: true });
        writeFileSync(path.join(root, "agent", "jig-sandbox", "allowed.json"), "{ not json");
        const allowed = createAllowed(() => path.join(root, "agent"));
        assert.deepEqual(allowed.folders(), []);
        assert.match(allowed.problem() ?? "", /is not valid and is ignored/);
    });
});

function writeBlocker(place: string): void {
    // A file where the agent folder should be, so nothing can be kept under it.
    mkdirSync(path.dirname(place), { recursive: true });
    writeFileSync(place, "in the way");
}

describe("a refused write under a toolchain folder, in the real sandbox", { skip }, () => {
    test("the command fails, the question comes after it, and yes lets the next command write", async () => {
        const world = await makeWorld();
        try {
            mkdirSync(`${world.home}/.sdkman`, { recursive: true });
            const first = await world.runAudited(`mkdir -p ${world.home}/.sdkman/candidates/java && echo installed`, {
                select: () => "This session",
            });
            assert.doesNotMatch(first.output, /^installed/, "the write was refused while the command ran");
            assert.equal(existsSync(`${world.home}/.sdkman/candidates`), false);
            assert.equal(first.questions.length, 1);
            assert.match(
                first.questions[0]?.title ?? "",
                /^bash was stopped from writing ~\/\.sdkman\/candidates\.\nPrograms installed there are on your PATH and run outside the sandbox later\.\nAllow writes to ~\/\.sdkman\?$/,
            );
            assert.ok(
                first.lines.some((line) =>
                    line.includes("cannot write ~/.sdkman/candidates: programs installed there are on your PATH"),
                ),
            );
            assert.ok(
                first.lines.includes(
                    "[sandbox] the user allowed writes to ~/.sdkman for this session; run the command again.",
                ),
            );

            const again = await world.runAudited(`mkdir -p ${world.home}/.sdkman/candidates/java && echo installed`);
            assert.match(again.output, /^installed/);
            assert.equal(existsSync(`${world.home}/.sdkman/candidates/java`), true);
            assert.deepEqual(again.questions, []);
        } finally {
            await world.cleanup();
        }
    });

    test("no keeps it refused, and the same command is asked about again next time", async () => {
        const world = await makeWorld();
        try {
            mkdirSync(`${world.home}/.nvm`, { recursive: true });
            const first = await world.runAudited(`mkdir ${world.home}/.nvm/versions`, { select: () => "No" });
            assert.ok(first.lines.some((line) => line.includes("writes to ~/.nvm stay refused")));
            const second = await world.runAudited(`mkdir ${world.home}/.nvm/versions`, { select: () => "No" });
            assert.equal(second.questions.length, 1);
            assert.equal(existsSync(`${world.home}/.nvm/versions`), false);
        } finally {
            await world.cleanup();
        }
    });

    test("without a screen nothing is asked and the line says who can allow it", async () => {
        const world = await makeWorld();
        try {
            mkdirSync(`${world.home}/.pyenv`, { recursive: true });
            const result = await world.runAudited(`mkdir ${world.home}/.pyenv/versions`, { ui: false });
            assert.deepEqual(result.questions, []);
            assert.ok(
                result.lines.some((line) =>
                    line.includes(
                        "there is no screen to ask on. A person can allow them with /sandbox allowed add ~/.pyenv",
                    ),
                ),
            );
        } finally {
            await world.cleanup();
        }
    });

    test("a locked path is never a question: only a toolchain folder asks", async () => {
        const world = await makeWorld();
        try {
            const result = await world.runAudited(`echo x >> ${world.home}/.bashrc`, { select: () => "Always" });
            assert.deepEqual(result.questions, []);
            assert.ok(result.lines.some((line) => line.includes("cannot write ~/.bashrc")));
        } finally {
            await world.cleanup();
        }
    });

    test("an answer for always is still there for a new session", async () => {
        const world = await makeWorld();
        try {
            mkdirSync(`${world.home}/.rbenv`, { recursive: true });
            await world.runAudited(`mkdir ${world.home}/.rbenv/versions`, { select: () => "Always" });
            assert.deepEqual(JSON.parse(readFileSync(`${world.agentDir}/jig-sandbox/allowed.json`, "utf8")), {
                folders: [`${world.home}/.rbenv`],
            });
            const after = await world.runAudited(`mkdir ${world.home}/.rbenv/versions && echo ok`);
            assert.match(after.output, /ok/);
            // And the agent cannot write the file itself: the agent folder is locked.
            const forged = await world.run(
                `echo '{"folders":["${world.home}/.nvm"]}' > ${world.agentDir}/jig-sandbox/allowed.json`,
            );
            assert.match(forged.output, /Read-only file system/);
            assert.deepEqual(JSON.parse(readFileSync(`${world.agentDir}/jig-sandbox/allowed.json`, "utf8")), {
                folders: [`${world.home}/.rbenv`],
            });
        } finally {
            await world.cleanup();
        }
    });
});
