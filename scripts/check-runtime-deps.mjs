// `npm run check`: the code that runs inside Pi imports only what a user's install has. `pi install git:` installs the root
// package.json's `dependencies` and nothing else (Pi's docs/packages.md), so a bare import in a plugin must name
//   - a `dependencies` entry of the root package.json,
//   - a Node built-in, or
//   - one of Pi's host packages, which package.json lists in `peerDependencies` and Pi supplies at run time.
// A `devDependencies` entry does not count: it is on the maintainer's machine and in CI, where a missing dependency stays hidden.
// Pi's docs also say not to list a host package in `dependencies`, which is checked here too.
//   node scripts/check-runtime-deps.mjs [--root <folder>]
import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The folders of a plugin that Pi does not run: tests, the review page (its own package, built to dist/), docs, build scripts.
const NOT_RUNTIME = new Set(["test", "web", "docs", "scripts", "dist", "skills", "themes"]);
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const IMPORT =
    /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

/** Every runtime source file under a plugin or example folder, relative to the root. */
function runtimeFiles(root, folder, top = true) {
    return readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(folder, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || (top && NOT_RUNTIME.has(entry.name))) return [];
            return runtimeFiles(root, relative, false);
        }
        return CODE.test(entry.name) ? [relative] : [];
    });
}

/** The package a bare specifier names: `hono/body-limit` is `hono`, `@scope/pkg/sub` is `@scope/pkg`. */
function packageOf(specifier) {
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** The bare imports of a file, with their line numbers. Relative paths and `node:` modules are not listed. */
export function bareImports(text) {
    const found = [];
    for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? "";
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
        const line = text.slice(0, (match.index ?? 0) + match[0].lastIndexOf(specifier)).split("\n").length;
        found.push({ specifier, line });
    }
    return found;
}

export function check(root) {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
    const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
    const hosts = new Set(Object.keys(manifest.peerDependencies ?? {}));
    const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
    const problems = [];

    for (const name of dependencies) {
        if (hosts.has(name)) {
            problems.push(`package.json: ${name} is a Pi host package, so it is a peerDependency, not a dependency`);
        }
    }

    let files = 0;
    let imports = 0;
    for (const group of ["plugins", "examples"]) {
        for (const plugin of readdirSync(path.join(root, group))) {
            for (const file of runtimeFiles(root, path.join(group, plugin))) {
                files += 1;
                for (const { specifier, line } of bareImports(readFileSync(path.join(root, file), "utf8"))) {
                    imports += 1;
                    const name = packageOf(specifier);
                    if (builtins.has(name) || dependencies.has(name) || hosts.has(name)) continue;
                    const why = devDependencies.has(name)
                        ? "a devDependency, which `pi install git:` does not install"
                        : "not in the root package.json at all";
                    problems.push(`${file}:${line}: imports "${specifier}", ${why}`);
                }
            }
        }
    }
    return { files, imports, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const flag = process.argv.indexOf("--root");
    const root = path.resolve(
        flag > 0 ? (process.argv[flag + 1] ?? ".") : path.join(path.dirname(process.argv[1]), ".."),
    );
    const { files, imports, problems } = check(root);
    if (problems.length > 0) {
        console.error(
            `A plugin imports something a user's install does not have. Move it to "dependencies" in package.json, or stop importing it:\n  ${problems.join("\n  ")}`,
        );
        process.exit(1);
    }
    console.log(
        `runtime dependencies are declared: ${imports} bare imports in ${files} files, each a dependency, a Node module or a Pi host package`,
    );
}
