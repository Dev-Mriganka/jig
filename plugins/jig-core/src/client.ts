// How plugins reach jig-core at run time.
//
// jig-core publishes its API on a process-wide symbol when it loads. A plugin calls `jig()` when it needs the
// API, or `withJig()` from its factory: Pi may load a plugin before jig-core, and then the call waits until
// jig-core loads. Plugins in other packages copy this file or import it; it holds no state of its own.
import type { JigApi } from "./contract.ts";

const API = Symbol.for("jig.core.api/v1");
const PENDING = Symbol.for("jig.core.pending/v1");

type Slot = typeof globalThis & {
    [API]?: JigApi;
    [PENDING]?: Array<(api: JigApi) => void>;
};

const slot = globalThis as Slot;

/** jig-core's API. Throws when jig-core is not loaded, so a Jig tool fails closed instead of running
 *  ungoverned. */
export function jig(): JigApi {
    const api = slot[API];
    if (api === undefined) throw new Error("jig-core is not loaded: enable jig-core, which governs every Jig tool");
    return api;
}

/** Runs `use` now if jig-core is loaded, otherwise as soon as it loads. */
export function withJig(use: (api: JigApi) => void): void {
    const api = slot[API];
    if (api !== undefined) {
        use(api);
        return;
    }
    (slot[PENDING] ??= []).push(use);
}

/** For jig-core only: publishes the API and runs what plugins queued before it loaded. */
export function publishJig(api: JigApi): void {
    slot[API] = api;
    const pending = slot[PENDING] ?? [];
    slot[PENDING] = [];
    for (const use of pending) use(api);
}

/** For jig-core only: withdraws the API when its runtime ends (reload, session replacement, exit), so a plugin
 *  loading into the next runtime waits for the new jig-core instead of declaring into the old one. */
export function withdrawJig(api: JigApi): void {
    if (slot[API] === api) delete slot[API];
}
