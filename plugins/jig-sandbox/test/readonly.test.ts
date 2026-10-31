// The read-only lock, run for real: the sandbox of a child agent whose role may not write reads its working folder and its home
// folder and writes neither, while /tmp stays writable. Each write that must fail is tried several ways in the real sandbox, and the
// same writes are made to work in a world without the lock, so a failure is the lock's and not a broken command.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { skipUnlessRealSandbox } from "./support/programs.ts";
import { makeWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

const skip = skipUnlessRealSandbox();

/** Ways to write into a folder, each as one shell command for the folder it is given. */
const WAYS_TO_WRITE: Array<[string, (folder: string) => string]> = [
    ["a redirect", (folder) => `echo changed > ${folder}/made-by-redirect.txt`],
    ["touch", (folder) => `touch ${folder}/made-by-touch.txt`],
    ["mkdir", (folder) => `mkdir ${folder}/made-folder`],
    ["a copy", (folder) => `cp ${folder}/existing.txt ${folder}/made-by-copy.txt`],
    ["a link", (folder) => `ln -s ${folder}/existing.txt ${folder}/made-link`],
    ["an append", (folder) => `echo more >> ${folder}/existing.txt`],
    ["a rename", (folder) => `mv ${folder}/existing.txt ${folder}/renamed.txt`],
    ["a delete", (folder) => `rm ${folder}/existing.txt`],
    ["a tool that writes (tee)", (folder) => `echo x | tee ${folder}/made-by-tee.txt`],
];
/** Names the commands above would create. */
const MADE = [
    "made-by-redirect.txt",
    "made-by-touch.txt",
    "made-folder",
    "made-by-copy.txt",
    "made-link",
    "renamed.txt",
    "made-by-tee.txt",
];

describe("a role that may not write, in the real sandbox", { skip }, () => {
    let world: World;
    before(async () => {
        world = await makeWorld({ settings: { readOnly: true } });
        world.put(`${world.project}/existing.txt`, "original\n");
        world.put(`${world.home}/existing.txt`, "original\n");
        world.put(`${world.home}/.npm/_cacache/index-v5`, "cache\n");
        world.put(`${world.home}/.gradle/caches/modules-2/files.bin`, "cache\n");
    });
    after(() => world.cleanup());

    test("control: it reads the working folder, the home folder and the files in them", async () => {
        const result = await world.run(
            `cat ${world.project}/existing.txt; ls ${world.home} | head -5; ls -A ${world.project}`,
        );
        assert.match(result.output, /original/);
        assert.match(result.output, /existing\.txt/);
    });

    for (const [name, command] of WAYS_TO_WRITE) {
        test(`the working folder cannot be written: ${name}`, async () => {
            const folder = world.project;
            const result = await world.run(command(folder));
            assert.notEqual(result.exitCode, 0, result.output);
            // Nothing was changed, whichever way the command failed.
            assert.equal(readFileSync(path.join(folder, "existing.txt"), "utf8"), "original\n");
            for (const made of MADE) assert.equal(existsSync(path.join(folder, made)), false, made);
        });
    }

    test("the home folder cannot be written either", async () => {
        const result = await world.run(
            `echo x > ${world.home}/new-file.txt; touch ${world.home}/other.txt; mkdir ${world.home}/new-folder`,
        );
        assert.notEqual(result.exitCode, 0);
        for (const made of ["new-file.txt", "other.txt", "new-folder"]) {
            assert.equal(existsSync(path.join(world.home, made)), false, made);
        }
        assert.equal(readFileSync(path.join(world.home, "existing.txt"), "utf8"), "original\n");
    });

    test("the build caches in the home folder are read-only too: a poisoned cache would run in a later build", async () => {
        const result = await world.run(
            `echo poisoned >> ${world.home}/.npm/_cacache/index-v5; echo poisoned > ${world.home}/.gradle/caches/modules-2/files.bin; mkdir -p ${world.home}/.m2/repository`,
        );
        assert.notEqual(result.exitCode, 0);
        assert.equal(readFileSync(path.join(world.home, ".npm/_cacache/index-v5"), "utf8"), "cache\n");
        assert.equal(readFileSync(path.join(world.home, ".gradle/caches/modules-2/files.bin"), "utf8"), "cache\n");
        assert.equal(existsSync(path.join(world.home, ".m2")), false);
    });

    test("/tmp stays writable, for the scratch files a tool needs", async () => {
        const result = await world.run(
            `d=$(mktemp -d /tmp/jig-readonly-XXXXXX) && echo scratch > $d/f && cat $d/f && rm -r $d`,
        );
        assert.equal(result.exitCode, 0, result.output);
        assert.match(result.output, /scratch/);
        const viaTmpdir = await world.run(`f=$(mktemp) && echo ok > $f && cat $f`);
        assert.equal(viaTmpdir.exitCode, 0, viaTmpdir.output);
    });

    test("a refusal names the lock and says what to do instead", async () => {
        const result = await world.runAudited(`echo x > ${world.project}/blocked.txt`);
        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.lines.some((line) =>
                /\[sandbox\] cannot write .*blocked\.txt: this agent's role may not write\. Report the change you would make/.test(
                    line,
                ),
            ),
            result.lines.join("\n"),
        );
        assert.equal(result.questions.length, 0, "nobody is asked to widen a read-only role");
    });

    test("a write under a toolchain folder is answered by the lock and does not ask", async () => {
        world.put(`${world.home}/.nvm/versions/.keep`, "");
        const result = await world.runAudited(`mkdir ${world.home}/.nvm/versions/node-x`, { select: () => "Yes" });
        assert.notEqual(result.exitCode, 0);
        assert.equal(result.questions.length, 0);
    });

    test("the credentials stay hidden, as for every agent", async () => {
        const result = await world.run(`cat ${world.home}/.ssh/id_ed25519 2>&1; cat ${world.project}/.env 2>&1`);
        assert.doesNotMatch(result.output, new RegExp(world.markers.ssh as string));
        assert.doesNotMatch(result.output, new RegExp(world.markers.dotenv as string));
    });

    test("/sandbox says why", () => {
        assert.ok(world.sandbox.notes.some((note) => /role may not write.*locked/.test(note)));
    });
});

describe("the same writes in a world without the lock work, so the tests above fail for the right reason", {
    skip,
}, () => {
    let world: World;
    before(async () => {
        world = await makeWorld();
        world.put(`${world.project}/existing.txt`, "original\n");
    });
    after(() => world.cleanup());

    test("the working folder and the home folder can be written", async () => {
        const result = await world.run(
            `echo changed > ${world.project}/made-by-redirect.txt && touch ${world.home}/made-in-home.txt && mkdir ${world.project}/made-folder`,
        );
        assert.equal(result.exitCode, 0, result.output);
        assert.equal(existsSync(path.join(world.project, "made-by-redirect.txt")), true);
        assert.equal(existsSync(path.join(world.home, "made-in-home.txt")), true);
    });
});
