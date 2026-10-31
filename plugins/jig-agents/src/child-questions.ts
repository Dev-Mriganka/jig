// A child's questions on their way to the user, and the time they cost. The child is a separate Pi, and its jig-core asks inside its own
// waiting call; here each request is checked against the role's approvals and the counts, brought to the screen one at a time through
// forward.ts, and answered on the pipe the parent alone holds. The time spent waiting is counted apart, because it does not count
// against the child's minutes. This file is kept apart from child.ts so that the rules for questions are in one place.
import { oneLine } from "./clean.ts";
import type { ChildSpec } from "./child-types.ts";
import { askUser, parseRequest } from "./forward.ts";
import type { AskDeps, Askable, UiAnswer, Verdict } from "./forward.ts";
import type { Wire } from "./rpc.ts";

const MAX_SEEN_IDS = 1000;
/** A child may have this many questions on the user's screen queue at once; the rest are cancelled. */
const MAX_PENDING_ASKS = 4;

/** What the questions need from the child they belong to. */
export interface QuestionLink {
    /** Who the child is now: a resumed child has a new spec. */
    spec(): ChildSpec;
    /** True once the child is ending or has ended: nothing more is asked or answered. */
    ending(): boolean;
    /** True once the child's state is finished, stopped or failed. */
    ended(): boolean;
    note(line: string): void;
    /** Sends a record to the child on its pipe. */
    send(record: { type: string; [key: string]: unknown }): void;
    /** Called when the number of waiting questions changes. */
    changed(): void;
    now(): number;
    /** Aborted when the child ends, so a question on the screen is closed with it. */
    signal(): AbortSignal;
}

export class Questions {
    /** How many questions the child has asked since it started. */
    asks = 0;
    /** How many are on the user's screen queue now. */
    waiting = 0;
    private waitSince = 0;
    private waitedMs = 0;
    private readonly seen = new Set<string>();
    private readonly answered = new Set<string>();
    private readonly ask: AskDeps;
    private readonly maxAsks: number;
    private readonly link: QuestionLink;

    constructor(ask: AskDeps, maxAsks: number, link: QuestionLink) {
        this.ask = ask;
        this.maxAsks = maxAsks;
        this.link = link;
    }

    /** Forgets everything, for a child that starts again in a new process. */
    reset(): void {
        this.asks = 0;
        this.waiting = 0;
        this.waitSince = 0;
        this.waitedMs = 0;
        this.seen.clear();
        this.answered.clear();
    }

    /** Milliseconds the user has kept the child waiting so far, including a question that is still open. */
    waitedTotal(now: number): number {
        return this.waitedMs + (this.waiting > 0 ? now - this.waitSince : 0);
    }

    private respond(id: string, answer: UiAnswer): void {
        if (this.answered.has(id)) return;
        this.answered.add(id);
        this.link.send({ type: "extension_ui_response", id, ...answer });
    }

    /** A request from the child: refuse it for a reason, or bring it to the user. */
    onRequest(request: Wire): void {
        if (this.link.ending() || this.link.ended()) return;
        const parsed = parseRequest(request);
        if (parsed.kind === "ignore") return;
        // A repeated id is ignored: the first request with it was answered, or is being asked.
        if (this.seen.has(parsed.id)) return;
        if (this.seen.size >= MAX_SEEN_IDS) this.seen.clear();
        this.seen.add(parsed.id);
        if (parsed.kind === "cancel") {
            this.link.note(`question refused: ${parsed.why}`);
            this.respond(parsed.id, { cancelled: true });
            return;
        }
        this.asks++;
        const refuse = (why: string): void => {
            this.link.note(`question refused: ${why}`);
            this.respond(parsed.id, { cancelled: true });
        };
        if (this.link.spec().approvals === "deny") {
            refuse("this role's approvals are set to deny");
            return;
        }
        if (this.asks > this.maxAsks) {
            refuse(`it has asked more than ${this.maxAsks} times`);
            return;
        }
        if (this.waiting >= MAX_PENDING_ASKS) {
            refuse("too many of its questions are waiting");
            return;
        }
        void this.forward(parsed);
    }

    private async forward(parsed: Askable): Promise<void> {
        const first = oneLine(parsed.title.split("\n").find((line) => line.trim() !== "") ?? parsed.title, 120);
        this.link.note(`asks: ${first}`);
        if (this.waiting === 0) this.waitSince = this.link.now();
        this.waiting++;
        this.link.changed();
        let verdict: Verdict = "unreadable";
        let answer: UiAnswer = { cancelled: true };
        try {
            const { name, role } = this.link.spec();
            const asked = await askUser(this.ask, { name, role }, parsed, this.link.signal());
            ({ answer, verdict } = asked);
        } catch {
            // askUser never rejects; a bug in it is still a no.
        } finally {
            this.waiting--;
            if (this.waiting === 0) this.waitedMs += this.link.now() - this.waitSince;
        }
        const label =
            "cancelled" in answer ? `no (${verdict === "answered" ? "declined or closed" : verdict})` : `answered`;
        this.link.note(`question ${label}`);
        if (!this.link.ending()) this.respond(parsed.id, answer);
        this.link.changed();
    }
}
