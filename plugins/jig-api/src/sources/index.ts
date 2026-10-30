// The sources there are. Adding one is adding its file here: nothing else in the plugin lists them.
import { bruno } from "./bruno.ts";
import { httpFile } from "./http-file.ts";
import { openapi } from "./openapi.ts";
import { postman } from "./postman.ts";
import type { Source } from "./source.ts";

export const SOURCES: readonly Source[] = [postman, httpFile, bruno, openapi];

export type { Source };
