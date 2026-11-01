// `npm run check`: every dependency version in every package.json is exact, such as "4.13.14", never "^4.13.14", "~4.13", "*" or
// "latest". Dependabot proposes the updates (AGENTS.md, "Dependencies"). `peerDependencies` are the exception: a range is how a
// package says which host it runs in, and Pi's packages are "*".
//   node scripts/check-pinned-deps.mjs [--root <folder>]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const EXACT = /^\d+\.\d+\.\d+$/;
const SKIPPED = new Set(["node_modules", ".git", "dist"]);

/** Every package.json under a folder, as a path relative to it. */
function manifests(root, folder = "") {
    return readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(folder, entry.name);
        if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : manifests(root, relative);
        return entry.name === "package.json" ? [relative] : [];
    });
}

/** The problems in one package.json: each dependency that is not an exact version. */
export function unpinned(manifest) {
    const found = [];
    for (const section of SECTIONS) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
            if (typeof version !== "string" || !EXACT.test(version)) {
                found.push(`${section}.${name} is "${version}", not an exact version such as "1.2.3"`);
            }
        }
    }
    return found;
}

export function check(root) {
    const files = manifests(root).sort();
    const problems = files.flatMap((file) => {
        const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
        return unpinned(manifest).map((problem) => `${file}: ${problem}`);
    });
    return { files, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const flag = process.argv.indexOf("--root");
    const root = path.resolve(
        flag > 0 ? (process.argv[flag + 1] ?? ".") : path.join(path.dirname(process.argv[1]), ".."),
    );
    const { files, problems } = check(root);
    if (problems.length > 0) {
        console.error(
            `Dependencies must be pinned to an exact version (AGENTS.md, "Dependencies"):\n  ${problems.join("\n  ")}`,
        );
        process.exit(1);
    }
    console.log(`dependencies are pinned: ${files.length} package.json files, every version exact`);
}
