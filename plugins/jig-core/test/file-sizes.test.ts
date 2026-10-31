// Growth made visible. A source file of more than 500 lines is a lot for a newcomer to hold in their head, so this test says which ones
// there are. It never fails: it prints a warning for each, and in GitHub Actions an annotation on the file, so a file that grows is
// noticed before it is a problem. The rule of thumb is one job for each file; `docs/decisions.md` says how the big ones were split.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LIMIT = 500;

/** Every `.ts` file under a folder, skipping `node_modules`. */
function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (name === "node_modules") return [];
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith(".ts") ? [full] : [];
    });
}

/** The `src` folders of the plugins and of the example company plugin. */
function sourceFolders(): string[] {
    return ["plugins", "examples"].flatMap((group) =>
        readdirSync(path.join(ROOT, group)).map((name) => path.join(ROOT, group, name, "src")),
    );
}

test(`source files over ${LIMIT} lines are listed as warnings, and never fail`, (t) => {
    const big: Array<{ file: string; lines: number }> = [];
    for (const folder of sourceFolders()) {
        let files: string[];
        try {
            files = sourceFiles(folder);
        } catch {
            continue; // a plugin with no src folder
        }
        for (const file of files) {
            const lines = readFileSync(file, "utf8").split("\n").length - 1;
            if (lines > LIMIT) big.push({ file: path.relative(ROOT, file).split(path.sep).join("/"), lines });
        }
    }
    big.sort((a, b) => b.lines - a.lines);
    for (const { file, lines } of big) {
        const message = `${file} has ${lines} lines: a source file over ${LIMIT} is a warning, so growth is seen`;
        t.diagnostic(message);
        // GitHub Actions turns this line into an annotation on the file.
        if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning file=${file}::${message}`);
    }
    if (big.length === 0) t.diagnostic(`no source file is over ${LIMIT} lines`);
});
