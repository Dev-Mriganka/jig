// Runs before every test file (`node --import`). First the isolated environment (test/support/hermetic.mjs), then Pi's host packages:
// tests resolve them from the installed Pi (test/support/pi-host-dir.mjs), as Pi maps them for extensions at runtime.
import { register } from "node:module";
import "./hermetic.mjs";

register("./host-hooks.mjs", import.meta.url);
