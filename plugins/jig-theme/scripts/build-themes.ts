// Writes the six palettes as Pi theme files, into this plugin's `themes` folder: `node plugins/jig-theme/scripts/build-themes.ts`.
// The files are committed. A test compares them with what this makes, so a change to a palette or to the role map that
// was not followed by a run of this script fails there.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, themeText } from "../src/build.ts";
import { PALETTES } from "../src/palettes.ts";

const folder = path.resolve(import.meta.dirname, "../themes");
mkdirSync(folder, { recursive: true });
for (const [name, palette] of Object.entries(PALETTES)) {
    writeFileSync(path.join(folder, `${name}.json`), themeText(build(palette, name)));
}
console.log(`${Object.keys(PALETTES).length} themes written to ${folder}`);
