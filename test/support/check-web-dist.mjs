// `npm run check:dist`: the committed plugins/jig-review/web/dist is what the sources build to.
// Builds the review page into a temporary folder and compares every file, by name and by byte, with the committed dist.
// The build is reproducible (same sources, same lockfile, same Node), so any difference means dist is stale or was edited
// by hand. Needs `npm ci` in plugins/jig-review/web first.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/jig-review/web");
const committed = path.join(web, "dist");
const vite = path.join(web, "node_modules/vite/bin/vite.js");
const REBUILD = "run `npm --prefix plugins/jig-review/web run build` and commit web/dist/ and web/build.json";

if (!existsSync(vite)) {
    console.error("The review page is not installed: run `npm ci` in plugins/jig-review/web, then try again");
    process.exit(1);
}

/** Every file below `folder`, by path relative to it with forward slashes, sorted. */
function filesUnder(folder) {
    return readdirSync(folder, { recursive: true })
        .map((entry) => String(entry).split(path.sep).join("/"))
        .filter((entry) => statSync(path.join(folder, entry)).isFile())
        .sort();
}

const built = mkdtempSync(path.join(tmpdir(), "jig-web-dist-"));
try {
    execFileSync(process.execPath, [vite, "build", "--outDir", built, "--emptyOutDir", "--logLevel", "warn"], {
        cwd: web,
        stdio: ["ignore", "inherit", "inherit"],
    });

    const now = filesUnder(built);
    const before = filesUnder(committed);
    const problems = [
        ...before
            .filter((file) => !now.includes(file))
            .map((file) => `${file}: in dist, but the build does not make it`),
        ...now.filter((file) => !before.includes(file)).map((file) => `${file}: made by the build, but not in dist`),
        ...now
            .filter((file) => before.includes(file))
            .filter((file) => !readFileSync(path.join(built, file)).equals(readFileSync(path.join(committed, file))))
            .map((file) => `${file}: differs from the build`),
    ];
    if (problems.length > 0) {
        console.error(`web/dist is not what the sources build to:\n  ${problems.join("\n  ")}\n${REBUILD}`);
        process.exitCode = 1;
    } else {
        console.log(`web/dist is current: ${now.length} files, identical to a fresh build`);
    }
} finally {
    rmSync(built, { recursive: true, force: true });
}
