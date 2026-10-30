// The sources there are. Adding one is adding its file here: nothing else in the plugin lists them.
import { httpFile } from "./http-file.ts";
import { postman } from "./postman.ts";
import type { Source } from "./source.ts";

export const SOURCES: readonly Source[] = [postman, httpFile];

export type { Source };
