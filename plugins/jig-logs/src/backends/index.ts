// The backends that are built. Adding one is a file in this folder that exports a `LogBackend`, and a line here.
import type { BackendType, Target } from "../config.ts";
import type { LogBackend } from "./backend.ts";
import { elasticsearch } from "./elasticsearch.ts";
import { loki } from "./loki.ts";

export type { LogBackend } from "./backend.ts";

/** By the `type` in `logs.backend`. */
export const backends: Readonly<Record<BackendType, LogBackend>> = { elasticsearch, loki };

/** The backend an environment was made by, and so the one that knows how to ask it and read its replies. */
export function backendOf(target: Target): LogBackend {
    return backends[target.type ?? "elasticsearch"];
}
