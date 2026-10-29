// A placeholder for the watch engine (docs: "Tool: watch" in the README). The engine is built separately and replaces
// this file; nothing else in jig-core depends on how it works, only on this shape: `JigApi["watches"]`.
import type { JigApi } from "./contract.ts";

const NOT_BUILT = "watches are not built yet";

export function createWatchPlaceholder(): JigApi["watches"] {
    // Plugins register their kinds at load. The kinds are kept so the engine, once it exists, can be given them.
    const kinds = new Map<string, unknown>();
    return {
        registerKind(kind) {
            kinds.set(kind.kind, kind);
        },
        start() {
            throw new Error(NOT_BUILT);
        },
        list() {
            return [];
        },
        stop() {
            throw new Error(NOT_BUILT);
        },
    };
}
