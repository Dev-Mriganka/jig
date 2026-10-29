// Tests resolve Pi's host packages from the installed Pi (test/support/pi-host-dir.mjs), as Pi maps them for extensions at runtime.
import { register } from "node:module";

register("./host-hooks.mjs", import.meta.url);
