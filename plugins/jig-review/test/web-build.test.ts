// The committed web/dist/ is what the server serves, and an install runs without a build. These checks need no toolchain:
// they compare the hashes `npm --prefix plugins/jig-review/web run build` wrote to web/build.json with the files as committed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hashOutputs, hashSources, PACKAGE_ROOT, readManifest } from "../web/scripts/manifest.ts";

const REBUILD = "run `npm --prefix plugins/jig-review/web run build` and commit web/dist/ and web/build.json";

test("dist was built from the sources as they are now", () => {
    assert.equal(
        hashSources(),
        readManifest().sources,
        `web/src, index.html, vite.config.ts or package-lock.json changed since dist was built: ${REBUILD}`,
    );
});

test("dist holds exactly the files the build wrote", () => {
    assert.deepEqual(
        hashOutputs(),
        readManifest().files,
        `web/dist/ differs from web/build.json (edited by hand, or a stale build): ${REBUILD}`,
    );
});

test("the page loads only assets that exist", () => {
    const html = readFileSync(path.join(PACKAGE_ROOT, "dist", "index.html"), "utf8");
    const referenced = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(
        referenced.some((file) => file.endsWith(".js")),
        "index.html loads the script",
    );
    assert.ok(
        referenced.some((file) => file.endsWith(".css")),
        "index.html loads the stylesheet",
    );
    for (const file of referenced) {
        assert.match(file, /^\/assets\/[\w.-]+$/, `${file} is served from /assets/`);
        assert.ok(existsSync(path.join(PACKAGE_ROOT, "dist", file)), `${file} is missing from dist/`);
    }
});

test("the built files name nothing of the machine or the company that built them", () => {
    const html = readFileSync(path.join(PACKAGE_ROOT, "dist", "index.html"), "utf8");
    assert.doesNotMatch(html, /\/home\/|C:\\\\Users/i);
});
