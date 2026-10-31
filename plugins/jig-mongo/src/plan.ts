// A call, planned: checked against the access lists, and turned into something that can be run. Nothing is sent. `classify` and
// `execute` plan the same way from the same input, so what jig-core decided about and what runs are the same call.
import type { Access } from "./access.ts";
import { ACTIONS, scanJavaScript } from "./params.ts";
import type { Call } from "./params.ts";
import { checkPipeline } from "./pipeline.ts";
import { nsOf, planAggregateRead, planRead } from "./reads.ts";
import type { ReadRun } from "./reads.ts";
import type { PlanOptions } from "./require-index.ts";
import { planAggregateWrite, planWrite } from "./writes.ts";
import type { WriteRun } from "./writes.ts";

export type Planned = { effect: "read"; run: ReadRun } | { effect: "write"; run: WriteRun };

/** `options.requireIndex` is the connection's choice: the reads that would scan a collection are then refused when they run. */
export function planCall(call: Call, access: Access, options?: PlanOptions): Planned {
    // Server-side JavaScript is refused wherever it is written in the call, before anything else is looked at.
    scanJavaScript(call, access.javascript);
    if (call.action === "aggregate") {
        const ns = nsOf(call);
        access.namespace(ns.db, ns.coll);
        const checked = checkPipeline(call.pipeline, ns, access);
        // `$out` and `$merge` make a pipeline a write.
        return checked.output === undefined
            ? { effect: "read", run: planAggregateRead(call, ns, checked, access, options) }
            : { effect: "write", run: planAggregateWrite(call, ns, checked, access) };
    }
    return ACTIONS[call.action].effect === "write"
        ? { effect: "write", run: planWrite(call, access) }
        : { effect: "read", run: planRead(call, access, options) };
}
