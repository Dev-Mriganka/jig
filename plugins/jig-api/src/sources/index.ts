// The sources there are. Adding one is adding its file here: nothing else in the plugin lists them.
import { httpFile } from "./http-file.ts";
import { postman } from "./postman.ts";
import type { Source } from "./source.ts";

export const SOURCES: readonly Source[] = [postman, httpFile];

/** Sources that are designed and not built yet. A collection that names one gets an error that says so, not "unknown field". */
export const COMING_LATER: ReadonlyMap<string, string> = new Map([
    ["bruno", "Bruno"],
    ["openapi", "OpenAPI"],
]);

export type { Source };
