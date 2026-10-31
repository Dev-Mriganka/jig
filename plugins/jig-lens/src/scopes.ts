// What a command asks for: the scopes to summarise, and the blocks that come back. The text of a block is in
// summary.ts; this is only which blocks, and in which order.
import type { DatabaseSync } from "node:sqlite";
import type { SummaryCommand } from "./command.ts";
import { compareBlock } from "./compare-format.ts";
import { compareOf } from "./compare.ts";
import { lastDays } from "./period.ts";
import { activeTicket, hasRecords } from "./queries.ts";
import { blockFor, daysRequest, sessionRequest, ticketRequest } from "./summary.ts";
import type { Block, Request } from "./summary.ts";

/**
 * The scopes a command asks for. `/lens` alone shows today, the session the user is in, and the ticket that session is
 * on now, if it is on one. `session` is the id of the session the user is in, when Pi can say.
 */
export function requestsFor(
    command: SummaryCommand,
    db: DatabaseSync,
    now: Date,
    session: string | undefined,
): Request[] {
    switch (command.kind) {
        case "ticket":
            return [ticketRequest(command.ticket)];
        case "days":
            return [daysRequest(now, command.days)];
        case "session": {
            const id = command.session ?? session;
            return id === undefined ? [] : [sessionRequest(id, id === session)];
        }
        case "summary": {
            const requests = [daysRequest(now, 1)];
            if (session !== undefined) {
                requests.push(sessionRequest(session, true));
                const ticket = activeTicket(db, session);
                if (ticket !== undefined) requests.push(ticketRequest(ticket));
            }
            return requests;
        }
    }
}

/** What an index with no record at all says, whatever was asked. */
export const NO_RECORDS: Block = {
    title: "No records yet. jig-core writes them as tools run and model turns end.",
    sections: [],
};

/** The blocks for a command: one for each scope it asks for, or the note that there is nothing to show. */
export function summaryFor(command: SummaryCommand, db: DatabaseSync, now: Date, session: string | undefined): Block[] {
    if (!hasRecords(db)) return [NO_RECORDS];
    return requestsFor(command, db, now, session).map((request) => blockFor(db, request, now));
}

/** The comparison of conditions over the last `days` days: its block, or the note that there are no records. */
export function compareFor(db: DatabaseSync, now: Date, days: number): Block {
    if (!hasRecords(db)) return NO_RECORDS;
    const range = lastDays(now, days);
    return compareBlock(compareOf(db, range.from, range.to), now, days);
}
