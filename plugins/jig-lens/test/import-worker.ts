// Imports the record files into the index the way a second Pi session would, in a process of its own. import.test.ts
// starts two of these at the same moment. Usage: node import-worker.ts <state folder> <now, ISO> <start, epoch ms>
import { importRecords } from "../src/import.ts";
import { lensPaths } from "../src/paths.ts";
import { openIndex } from "../src/store.ts";

const [state, now, startAt] = process.argv.slice(2);
if (state === undefined || now === undefined || startAt === undefined)
    throw new Error("usage: import-worker.ts state now start");

// Both workers wait for the same moment, so their first writes meet.
while (Date.now() < Number(startAt)) {
    // Waiting.
}

const where = lensPaths(state);
const db = openIndex(where.index);
try {
    console.log(JSON.stringify(await importRecords(db, { records: where.records, now: new Date(now) })));
} finally {
    db.close();
}
