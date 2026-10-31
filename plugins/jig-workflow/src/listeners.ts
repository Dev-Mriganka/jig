// What other plugins announce on Pi's event bus, kept as evidence for the active ticket's workflow: a review that was approved,
// and a CI watch that ended. Anyone can publish on the bus, so each payload is checked (sources.ts); one that does not pass, or
// is about a repository that is not bound, is ignored. A listener that fails never disturbs the plugin that published.
import { inspect } from "./repos.ts";
import type { Runtime } from "./runtime.ts";
import { ciFromEvent, ciRecord, reviewFromEvent } from "./sources.ts";
import { updateState } from "./store.ts";

/** A review was approved: kept when it covers the commits of a bound repository of the active ticket. */
export function onReviewApproved(rt: Runtime, payload: unknown): void {
    try {
        const ticket = rt.activeTicket();
        if (ticket === undefined) return;
        const work = rt.work(ticket);
        if (work.read.kind !== "state") return;
        const record = reviewFromEvent(payload, ticket, rt.bound(ticket).roots, rt.cwd, rt.host.now());
        if (record === undefined) return;
        updateState(work.paths.dir, (state) => {
            state.reviews = state.reviews.filter((review) => review.reviewId !== record.reviewId);
            state.reviews.push(record);
        });
    } catch {
        // Evidence that could not be kept is evidence the condition will ask for again.
    }
}

/** A CI watch ended: kept when it is about a commit of a repository bound to the active ticket (matched by origin's name). */
export async function onCiFinished(rt: Runtime, payload: unknown): Promise<void> {
    try {
        const found = ciFromEvent(payload);
        const ticket = rt.activeTicket();
        if (found === undefined || ticket === undefined) return;
        const work = rt.work(ticket);
        if (work.read.kind !== "state") return;
        const views = await Promise.all(rt.bound(ticket).roots.map((root) => inspect(rt.host, root)));
        if (!views.some((view) => view.slug === found.repo)) return;
        const record = ciRecord(found, rt.host.now());
        updateState(work.paths.dir, (state) => {
            state.ci = state.ci.filter(
                (entry) => !(entry.repo === record.repo && entry.sha === record.sha && entry.finish === record.finish),
            );
            state.ci.push(record);
        });
    } catch {
        // See above.
    }
}
