// The module specifiers a source file imports, found by reading its text (TypeScript has no programmatic API here, and the checks that
// use this, scripts/check-runtime-deps.mjs and plugins/jig-core/test/boundaries.test.ts, only need the names).
const IMPORT =
    /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every specifier a text imports or re-exports, with its 1-based line: `import x from "a"`, `import "a"`, `import type { T } from "a"`,
 * `export { x } from "a"`, `export type * from "a"`, `import("a")` and `require("a")`. A statement may span lines. Only a string
 * literal counts, so a computed `import(name)` is not found.
 */
export function importsOf(text) {
    const found = [];
    for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? "";
        const line = text.slice(0, (match.index ?? 0) + match[0].lastIndexOf(specifier)).split("\n").length;
        found.push({ specifier, line });
    }
    return found;
}
