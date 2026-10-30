// What dist/ was built from. `npm run build` runs this after Vite and writes build.json; the plugin's test recomputes the
// same hashes, so a source change without a rebuild, or a hand-edited bundle, fails `npm test` without needing the Vite
// toolchain. Run it directly (`node scripts/manifest.ts`) to rewrite the manifest.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = "build.json";

/** Everything the bundle is a function of besides the installed tools, which package-lock.json pins. */
const SOURCE_FILES = ["index.html", "vite.config.ts", "package-lock.json"];
const SOURCE_DIRECTORY = "src";
const OUTPUT_DIRECTORY = "dist";

export interface WebBuildManifest {
  /** Hash over the sources listed by `sourceFiles`. */
  sources: string;
  /** SHA-256 of every file under dist/, by path relative to it. */
  files: Record<string, string>;
}

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

function filesUnder(root: string, directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(root, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/** Paths, relative to the package, of the files `sources` hashes. */
export function sourceFiles(root: string = PACKAGE_ROOT): string[] {
  return [...SOURCE_FILES, ...filesUnder(root, SOURCE_DIRECTORY)].sort();
}

/** One hash over the path and content of every source file. */
export function hashSources(root: string = PACKAGE_ROOT): string {
  const lines = sourceFiles(root).map((file) => `${file}\0${sha256(readFileSync(path.join(root, file)))}\n`);
  return sha256(lines.join(""));
}

/** SHA-256 of each file in dist/, keyed by its path relative to dist/. */
export function hashOutputs(root: string = PACKAGE_ROOT): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of filesUnder(root, OUTPUT_DIRECTORY).sort()) {
    files[path.posix.relative(OUTPUT_DIRECTORY, file)] = sha256(readFileSync(path.join(root, file)));
  }
  return files;
}

export function readManifest(root: string = PACKAGE_ROOT): WebBuildManifest {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_FILE), "utf8")) as WebBuildManifest;
}

export function writeManifest(root: string = PACKAGE_ROOT): WebBuildManifest {
  const manifest: WebBuildManifest = { sources: hashSources(root), files: hashOutputs(root) };
  writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = writeManifest();
  console.log(`${MANIFEST_FILE}: ${Object.keys(manifest.files).length} files in dist, sources ${manifest.sources.slice(0, 12)}`);
}
