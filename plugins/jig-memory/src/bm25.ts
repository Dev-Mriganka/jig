// Keyword search over card text: words cut to a root, and BM25 (Robertson and Zaragoza) to score a card against a query.
// It is the weak half of recall, so it is small: a word list, a light stemmer, and the formula. A word's weight is its
// rarity among the cards, scaled so a word only one card uses is worth 1, and recall.ts decides how many points that is.

// Words that every ticket uses and that say nothing about which ticket it is.
const STOP_WORDS: ReadonlySet<string> = new Set(
    (
        "about above after again all also and any are because been before being below between both but can could did does " +
        "doing down during each few for from further had has have having her here him his how into its just more most " +
        "nor not now off once only other our out over own same she should some such than that the their them then there " +
        "these they this those through too under until upon very was were what when where which while who whom why will " +
        "with would you your via per use used using get got ticket issue problem cause fix fixed"
    ).split(" "),
);

/** Parameters of BM25. */
const K1 = 1.2;
const B = 0.75;

/**
 * A word cut to a root, so `timeouts`, `timed` and `timing` are not three words. This is not a full stemmer: it strips
 * the endings that matter in tickets (`ies`, `s`, `ing`, `ed`, a final `e`), and a root that two words share is
 * enough, even if it is not a word.
 */
export function stem(word: string): string {
    let w = word;
    if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
    // What is left must still hold a vowel, so `spring` and `string` stay whole.
    if (w.length > 5 && w.endsWith("ing") && /[aeiouy]/.test(w.slice(0, -3))) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith("ed") && /[aeiouy]/.test(w.slice(0, -2))) w = w.slice(0, -2);
    // A doubled consonant left by the cut (`mapping` to `mapp`) goes, so `map` and `mapping` meet.
    if (w !== word && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
    // `cancel` and `cancelling`, `install` and `installed`: one l, whichever way the word was spelt.
    if (w.length > 4 && w.endsWith("ll")) w = w.slice(0, -1);
    return w;
}

/** A `CamelCase` name in its parts: `OrderService` gives `Order` and `Service`. */
function parts(name: string): string[] {
    return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
}

export interface Word {
    /** The root the search uses. */
    term: string;
    /** The word as the text had it, in lower case, for showing why a card matched. */
    word: string;
}

/** The words of a text that a search uses, in order and with repeats. A `CamelCase` name counts whole and in parts. */
export function words(text: string): Word[] {
    const found: Word[] = [];
    const add = (raw: string) => {
        const word = raw.toLowerCase();
        if (word.length < 3 || STOP_WORDS.has(word)) return;
        found.push({ term: stem(word), word });
    };
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
        const pieces = parts(match[0]);
        if (pieces.length > 1) add(match[0]);
        for (const piece of pieces) add(piece);
    }
    return found;
}

/** The roots of a text, with repeats. */
export const tokenize = (text: string): string[] => words(text).map((word) => word.term);

/** How many times each root occurs. */
export function countTerms(terms: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const term of terms) counts[term] = (counts[term] ?? 0) + 1;
    return counts;
}

/** What BM25 needs of one card. */
export interface Doc {
    /** The number of roots in the card's text. */
    length: number;
    terms: Readonly<Record<string, number>>;
}

export interface Corpus {
    /** The number of cards. */
    size: number;
    averageLength: number;
    /** In how many cards each root occurs. */
    frequency: Map<string, number>;
}

export function corpusOf(docs: readonly Doc[]): Corpus {
    const frequency = new Map<string, number>();
    let total = 0;
    for (const doc of docs) {
        total += doc.length;
        for (const term of Object.keys(doc.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
    return { size: docs.length, averageLength: docs.length === 0 ? 1 : Math.max(1, total / docs.length), frequency };
}

/**
 * How rare something is among `size` cards when `holding` of them have it: 1 for what one card has, and near 0 for what
 * almost every card has. It is BM25's inverse document frequency divided by the value for one card, so it does not
 * grow with the number of cards and one threshold serves a folder of ten cards and a folder of a thousand.
 */
export function rarity(holding: number, size: number): number {
    if (size <= 0) return 0;
    const idf = (count: number) => Math.log(1 + (size - count + 0.5) / (count + 0.5));
    const one = idf(1);
    return Math.max(0, Math.min(1, idf(Math.min(Math.max(1, holding), size)) / one));
}

/**
 * The BM25 score of a card for a set of roots, with the share each root added. A root's share is its rarity times how
 * strongly the card uses it (a count that levels off, and counts for less in a long card).
 */
export function bm25(
    terms: Iterable<string>,
    doc: Doc,
    corpus: Corpus,
): { score: number; shares: Map<string, number> } {
    const shares = new Map<string, number>();
    let score = 0;
    const norm = K1 * (1 - B + (B * doc.length) / corpus.averageLength);
    for (const term of new Set(terms)) {
        // Own properties only: a card parsed from JSON has Object's members, and `constructor` is a word.
        const count = Object.hasOwn(doc.terms, term) ? doc.terms[term] : undefined;
        if (count === undefined || count === 0) continue;
        const share = rarity(corpus.frequency.get(term) ?? 1, corpus.size) * ((count * (K1 + 1)) / (count + norm));
        shares.set(term, share);
        score += share;
    }
    return { score, shares };
}
