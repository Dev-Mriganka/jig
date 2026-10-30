// `npm run check`: point .pi-host at the Pi package so tsconfig.json finds Pi's type declarations.
import { existsSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { piHostDir } from "./pi-host-dir.mjs";

if (!existsSync(path.join(piHostDir, "dist/index.d.ts"))) {
    console.error(
        `No Pi at ${piHostDir}: install it with npm install -g @earendil-works/pi-coding-agent, or set PI_HOST_DIR to its package directory`,
    );
    process.exit(1);
}
const link = path.join(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))), ".pi-host");
rmSync(link, { force: true });
symlinkSync(piHostDir, link);
