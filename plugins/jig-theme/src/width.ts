// Text for one terminal row: cleaned of anything that is not text, measured in cells, and cut to fit. A cell is one column
// of the terminal; a letter takes one, a wide character or an emoji two, and a combining mark none. Counting graphemes
// and not code units is what keeps a footer inside the row when a label holds an accent or an emoji.

/** Strips terminal escapes (OSC and CSI sequences), turns other control characters into spaces and squeezes spaces. */
export const plain = (value: unknown, limit = 2048): string =>
    String(value ?? "")
        .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);

/** `plain`, and without what could reorder or garble the row: bidirectional controls and lone surrogates. */
export const clean = (value: unknown, limit = 2048): string =>
    plain(value, limit)
        .replace(/[‪-‮⁦-⁩]/g, "")
        .replace(/[\uD800-\uDFFF]/gu, "");

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

interface Cell {
    segment: string;
    width: number;
}

function cells(value: string): Cell[] {
    return [...graphemes.segment(value)].map(({ segment }) => {
        const cp = segment.codePointAt(0) ?? 0;
        const wide =
            /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(segment) ||
            (cp >= 0x1100 &&
                (cp <= 0x115f ||
                    (cp >= 0x2e80 && cp <= 0xa4cf) ||
                    (cp >= 0xac00 && cp <= 0xd7a3) ||
                    (cp >= 0xf900 && cp <= 0xfaff) ||
                    (cp >= 0xfe10 && cp <= 0xfe6f) ||
                    (cp >= 0xff00 && cp <= 0xff60) ||
                    cp >= 0x20000));
        return { segment, width: /^\p{Mark}+$/u.test(segment) ? 0 : wide ? 2 : 1 };
    });
}

/** The width of a text in cells, as the terminal draws it: escapes and control characters count for nothing. */
export const cellWidth = (value: string): number =>
    cells(
        value
            .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ""),
    ).reduce((sum, item) => sum + item.width, 0);

/** A text cut to `width` cells, with `…` in the last one when something was cut. */
export function fit(value: string, width: number): string {
    if (width < 1) return "";
    const chars = cells(clean(value));
    if (chars.reduce((sum, item) => sum + item.width, 0) <= width) return chars.map((item) => item.segment).join("");
    let result = "";
    let used = 0;
    for (const item of chars) {
        if (used + item.width > width - 1) break;
        result += item.segment;
        used += item.width;
    }
    return `${result}…`;
}
