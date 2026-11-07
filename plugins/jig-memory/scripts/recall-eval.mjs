#!/usr/bin/env node
// Measures recall on a real or invented tickets folder without printing any content: only counts, rates and booleans.
//
// Default: a real link is a ticket whose notes.md names another ticket. With --labels <file>, the file's related key pairs
// are the links instead; the file is read here and never printed, copied or committed. The top N is really top N: the test
// asks recall for N derived entries, not the display cap. The query is the first lines of the note, an approximation of
// the message that starts a real ticket. The output also says how often a ticket with no labelled neighbour gets a hit,
// and whether that hit had a name/ID or only rare words. Errors print {"error":true} and exit 1.
//
// Usage: node recall-eval.mjs --folder <tickets> [--labels <json>] [--mode notes|cards|both]
//        [--min-score 2] [--max 3] [--top 3] [--lines 25] [--rule on|off]
import { readFileSync, readdirSync, lstatSync } from "node:fs";

// The plugin's TypeScript is imported inside the try below, so an import failure prints {"error":true} and no stack.
let entryOf;
let RECALL_DEFAULTS;
let noteEntryOf;
let buildQuery;
let recall;
let recallMessage;
let isSafeKey;
let readText;
let ticketPaths;

function args(argv) {
    const out = {
        folder: undefined,
        labels: undefined,
        mode: "notes",
        minScore: RECALL_DEFAULTS.minScore,
        max: RECALL_DEFAULTS.max,
        top: 3,
        maxNotes: undefined,
        gate: "auto",
        lines: 25,
        rule: "on",
    };
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        const value = argv[i + 1];
        if (name === "--folder") out.folder = value;
        else if (name === "--labels") out.labels = value;
        else if (name === "--mode") out.mode = value;
        else if (name === "--min-score") out.minScore = Number(value);
        else if (name === "--max") out.max = Number(value);
        else if (name === "--top") out.top = Number(value);
        else if (name === "--max-notes") out.maxNotes = Number(value);
        else if (name === "--gate") out.gate = value;
        else if (name === "--lines") out.lines = Number(value);
        else if (name === "--rule") out.rule = value;
        else continue;
        i++;
    }
    return out;
}

const quoteRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The text with every ticket key in the folder taken out, so a shared key cannot be the reason a result came back. */
function redact(text, keys) {
    let out = text;
    for (const key of keys) out = out.split(key).join(" ");
    return out;
}
/** The first meaningful lines of a note: what a message that starts the ticket resembles best. */
function start(text, lines) {
    const kept = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        kept.push(line);
        if (kept.length >= lines) break;
    }
    return kept.join("\n");
}
const names = (text, key) => new RegExp(`(?<![A-Za-z0-9])${quoteRegExp(key)}(?![A-Za-z0-9])`).test(text);

/**
 * The pairs of keys in a labels file. It accepts the shapes a person naturally writes, at any depth: `[["A","B"], …]`,
 * objects with `a`/`b`, `from`/`to`, `left`/`right` or `key`/`related`, and maps from a key to one key or a list. Only
 * pairs whose two names are tickets in this folder are kept; a labels file that names no ticket here yields no pairs.
 */
function readLabels(file, known) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const pairs = [];
    const add = (a, b) => {
        if (typeof a === "string" && typeof b === "string" && a !== b && known.has(a) && known.has(b))
            pairs.push([a, b]);
    };
    const walk = (node) => {
        if (Array.isArray(node)) {
            if (node.length >= 2 && node.every((item) => typeof item === "string")) add(node[0], node[1]);
            for (const item of node) walk(item);
            return;
        }
        if (typeof node !== "object" || node === null) return;
        const named = node.a ?? node.from ?? node.left ?? node.key ?? node.ticket;
        if (typeof named === "string") {
            const other = node.b ?? node.to ?? node.right ?? node.related ?? node.other;
            if (Array.isArray(other)) for (const item of other) add(named, item);
            else add(named, other);
        }
        for (const [key, value] of Object.entries(node)) {
            if (known.has(key)) {
                if (typeof value === "string") add(key, value);
                else if (Array.isArray(value)) for (const item of value) add(key, item);
            }
            walk(value);
        }
    };
    walk(raw);
    const unique = new Map();
    for (const [a, b] of pairs) {
        const ordered = a < b ? [a, b] : [b, a];
        unique.set(`${ordered[0]}\u0000${ordered[1]}`, ordered);
    }
    return [...unique.values()];
}

function main() {
    const a = args(process.argv.slice(2));
    if (typeof a.folder !== "string" || a.folder === "") throw new Error("no folder");
    if (!Number.isInteger(a.top) || a.top < 1) throw new Error("bad top");
    if (a.rule !== "on" && a.rule !== "off") throw new Error("bad rule");
    if (a.gate !== "auto" && a.gate !== "manual") throw new Error("bad gate");
    const folders = readdirSync(a.folder, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && isSafeKey(entry.name),
    );
    const keys = folders.map((entry) => entry.name);
    const notes = new Map();
    const cards = new Map();
    for (const key of keys) {
        const paths = ticketPaths(a.folder, key);
        try {
            const stat = lstatSync(paths.notes);
            notes.set(key, { text: readText(paths.notes), stamp: { mtimeMs: stat.mtimeMs, size: stat.size } });
        } catch {
            // No note yet.
        }
        try {
            const stat = lstatSync(paths.card);
            cards.set(key, { text: readText(paths.card), stamp: { mtimeMs: stat.mtimeMs, size: stat.size } });
        } catch {
            // No card yet.
        }
    }
    // Derived links: A names B in A's notes. With labels, the file's pairs replace them.
    const linked = new Map();
    for (const key of notes.keys()) linked.set(key, []);
    if (a.labels !== undefined) {
        for (const [one, other] of readLabels(a.labels, new Set(notes.keys()))) {
            if (linked.has(one) && linked.has(other)) {
                linked.get(one).push(other);
                linked.get(other).push(one);
            }
        }
    } else {
        for (const [key, note] of notes) {
            linked.set(
                key,
                [...notes.keys()].filter((other) => other !== key && names(note.text, other)),
            );
        }
    }
    const labelled =
        a.labels !== undefined ? [...linked.keys()].filter((key) => (linked.get(key) ?? []).length > 0) : [];
    const pairs = a.labels !== undefined ? readLabels(a.labels, new Set(notes.keys())) : [];
    const cardIndex = {};
    for (const [key, card] of cards) cardIndex[key] = entryOf(key, redact(card.text, keys), card.stamp);
    const noteIndex = {};
    for (const [key, note] of notes) noteIndex[key] = noteEntryOf(key, redact(note.text, keys), note.stamp, undefined);
    const modes = a.mode === "both" ? ["cards", "notes"] : [a.mode];
    const results = [];
    for (const mode of modes) {
        if (mode !== "cards" && mode !== "notes") throw new Error("bad mode");
        const maxNotes = a.maxNotes ?? (a.gate === "auto" ? 1 : a.top);
        const allowRareWords = a.gate === "manual";
        let expected = 0;
        let hits = 0;
        let cases = 0;
        let casesFound = 0;
        let noLinkCases = 0;
        let noLinkHits = 0;
        let noLinkHitsNamed = 0;
        let noLinkHitsWordOnly = 0;
        const topByKey = new Map();
        const queryKeys =
            a.labels !== undefined ? labelled : [...notes.keys()].filter((key) => (linked.get(key) ?? []).length > 0);
        for (const key of queryKeys) {
            const note = notes.get(key);
            if (note === undefined) continue;
            const wanted = linked.get(key) ?? [];
            const query = buildQuery({
                ticket: key,
                text: redact(start(note.text, a.lines), keys),
                pattern: undefined,
            });
            const matches =
                mode === "cards"
                    ? recall(cardIndex, query, { max: Math.max(a.max, a.top), minScore: a.minScore, maxNotes: 0 })
                    : recall(
                          {},
                          query,
                          {
                              max: Math.max(a.max, a.top),
                              minScore: a.minScore,
                              maxNotes,
                              requireEvidence: a.rule === "on",
                              allowRareWords,
                          },
                          noteIndex,
                      );
            const top = matches.slice(0, a.top).map((match) => match.ticket);
            topByKey.set(key, top);
            cases++;
            expected += wanted.length;
            const got = wanted.filter((ticket) => top.includes(ticket)).length;
            hits += got;
            if (got > 0) casesFound++;
        }
        for (const key of notes.keys()) {
            if (linked.get(key)?.length > 0) continue;
            noLinkCases++;
            const note = notes.get(key);
            if (note === undefined) continue;
            const query = buildQuery({
                ticket: key,
                text: redact(start(note.text, a.lines), keys),
                pattern: undefined,
            });
            const matches =
                mode === "cards"
                    ? recall(cardIndex, query, { max: a.top, minScore: a.minScore, maxNotes: 0 })
                    : recall(
                          {},
                          query,
                          {
                              max: Math.max(a.max, a.top),
                              minScore: a.minScore,
                              maxNotes,
                              requireEvidence: a.rule === "on",
                              allowRareWords,
                          },
                          noteIndex,
                      );
            if (matches.length === 0) continue;
            noLinkHits++;
            if (mode === "notes") {
                if (matches.some((match) => match.evidence === "name")) noLinkHitsNamed++;
                else if (matches.some((match) => match.evidence === "word")) noLinkHitsWordOnly++;
            }
        }
        // A label pair is found when either direction is in its top N; both says every direction is.
        let pairsFoundAny = 0;
        let pairsFoundBoth = 0;
        for (const [one, other] of pairs) {
            const oneTop = topByKey.get(one) ?? [];
            const otherTop = topByKey.get(other) ?? [];
            const a1 = oneTop.includes(other);
            const b1 = otherTop.includes(one);
            if (a1 || b1) pairsFoundAny++;
            if (a1 && b1) pairsFoundBoth++;
        }
        let autoMessages = 0;
        let autoBytes = 0;
        let autoBytesMax = 0;
        if (mode === "notes") {
            for (const [key, note] of notes) {
                const query = buildQuery({
                    ticket: key,
                    text: redact(start(note.text, a.lines), keys),
                    pattern: undefined,
                });
                const matches = recall(
                    {},
                    query,
                    { max: a.top, minScore: a.minScore, maxNotes: 1, requireEvidence: true, allowRareWords: false },
                    noteIndex,
                );
                if (matches.length === 0) continue;
                const bytes = Buffer.byteLength(recallMessage(key, a.folder, matches));
                autoMessages++;
                autoBytes += bytes;
                autoBytesMax = Math.max(autoBytesMax, bytes);
            }
        }
        results.push({
            mode,
            tickets: keys.length,
            documents: mode === "cards" ? Object.keys(cardIndex).length : Object.keys(noteIndex).length,
            labelled: a.labels !== undefined,
            cases,
            expectedLinks: expected,
            hits,
            recallAt3: expected === 0 ? null : Math.round((hits / expected) * 1000) / 1000,
            casesFound,
            pairs: a.labels === undefined ? null : pairs.length,
            pairsFoundAny: a.labels === undefined ? null : pairsFoundAny,
            pairsFoundBoth: a.labels === undefined ? null : pairsFoundBoth,
            noLinkCases,
            noLinkHits,
            noLinkHitsNamed,
            noLinkHitsWordOnly,
            noise: noLinkCases === 0 ? null : Math.round((noLinkHits / noLinkCases) * 1000) / 1000,
            top: a.top,
            maxNotes,
            gate: a.gate,
            rule: a.rule,
            minScore: a.minScore,
            queryLines: a.lines,
            autoMessages,
            autoMessageBytesMean: autoMessages === 0 ? null : Math.round((autoBytes / autoMessages) * 10) / 10,
            autoMessageBytesMax: autoMessages === 0 ? null : autoBytesMax,
        });
    }
    return a.mode === "both" ? { modes: results } : results[0];
}

try {
    ({ entryOf } = await import("../src/cards.ts"));
    ({ RECALL_DEFAULTS } = await import("../src/config.ts"));
    ({ noteEntryOf } = await import("../src/notes-index.ts"));
    ({ buildQuery, recall, recallMessage } = await import("../src/recall.ts"));
    ({ isSafeKey, readText, ticketPaths } = await import("../src/store.ts"));
    process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
} catch {
    process.stdout.write('{"error":true}\n');
    process.exitCode = 1;
}
