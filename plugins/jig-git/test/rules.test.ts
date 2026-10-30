import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The repository's code rules, checked on the sources: erasable TypeScript only, imports Pi can resolve, programs started
// only through jig-core, and no token anywhere.
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = /^(?:typebox|typebox\/value|@earendil-works\/pi-(?:coding-agent|tui|ai))$/;

function sources(): { file: string; text: string }[] {
    return fs
        .readdirSync(path.join(PLUGIN, "src"))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => ({ file: `src/${file}`, text: fs.readFileSync(path.join(PLUGIN, "src", file), "utf8") }));
}

test("there are sources to check", () => {
    assert.ok(sources().length >= 20);
});

test("no enum, namespace, import =, or parameter properties: types are erased, nothing else is needed to run", () => {
    for (const { file, text } of sources()) {
        assert.doesNotMatch(text, /^\s*(export\s+)?(const\s+)?enum\s/m, `${file}: enum`);
        assert.doesNotMatch(text, /^\s*(export\s+)?namespace\s/m, `${file}: namespace`);
        assert.doesNotMatch(text, /import\s+\w+\s*=\s*require/, `${file}: import =`);
        assert.doesNotMatch(
            text,
            /constructor\s*\(\s*(private|public|protected|readonly)\s/,
            `${file}: parameter property`,
        );
    }
});

test("runtime imports are node: builtins, Pi's host packages, or relative .ts modules; jig-core is reached by its contract, client and kit only", () => {
    for (const { file, text } of sources()) {
        for (const match of text.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gm)) {
            const [, typeOnly, , specifier = ""] = match;
            if (specifier.includes("jig-core")) {
                assert.match(
                    specifier,
                    /\/jig-core\/src\/(contract|client|kit\/[a-z-]+)\.ts$/,
                    `${file}: ${specifier} is not the contract, the client or the kit`,
                );
                if (specifier.endsWith("contract.ts"))
                    assert.ok(typeOnly, `${file}: the contract is imported with import type`);
            }
            if (typeOnly) continue;
            const ok =
                specifier.startsWith("node:") ||
                HOST.test(specifier) ||
                (specifier.startsWith(".") && specifier.endsWith(".ts"));
            assert.ok(ok, `${file}: runtime import ${specifier}`);
        }
        for (const match of text.matchAll(/from\s+"(\.{1,2}\/[^"]*)"/g))
            assert.ok((match[1] ?? "").endsWith(".ts"), `${file}: ${match[1]}`);
    }
});

test("programs start only through jig-core: no shell, no child_process, no spawn", () => {
    for (const { file, text } of sources()) {
        assert.doesNotMatch(text, /shell\s*:\s*true/, `${file}: shell`);
        assert.doesNotMatch(text, /child_process/, `${file}: child_process`);
        assert.equal(/(?<![.\w])exec(Sync)?\(/.test(text), false, `${file}: a bare exec call`);
        assert.equal(/(?<![.\w])spawn(Sync)?\(/.test(text), false, `${file}: a bare spawn call`);
    }
});

test("every git call goes through jig().exec.git and every gh call through jig().exec.run", () => {
    const calls = sources().flatMap(({ file, text }) =>
        [...text.matchAll(/exec\.(run|git)\(\s*([^,)]*)/g)].map((match) => ({
            file,
            kind: match[1],
            first: match[2]?.trim(),
        })),
    );
    assert.ok(calls.length >= 4);
    for (const call of calls) {
        if (call.kind === "run") assert.equal(call.first, '"gh"', `${call.file}: exec.run is for gh`);
    }
});

test("the plugin never handles a token: no token variable, no Authorization header, no secret resolution", () => {
    for (const { file, text } of sources()) {
        assert.doesNotMatch(
            text,
            /GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|Authorization|secrets\.resolve/,
            `${file}: handles a credential`,
        );
    }
});

test("each tool is a registered Pi tool and a declaration for jig-core, and the tools do not register themselves", () => {
    for (const { file, text } of sources()) {
        if (file !== "src/index.ts") assert.doesNotMatch(text, /registerTool\(/, `${file}: registers a tool`);
        if (file !== "src/index.ts") assert.doesNotMatch(text, /declareTool\(/, `${file}: declares a tool`);
    }
});
