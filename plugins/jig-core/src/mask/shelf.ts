import { MaskError } from "./error.ts";

/** Private-use character U+E000, which brackets placeholders. Text containing it is refused before masking.
 *  Written as a number so that the source holds no invisible character. */
export const SENTINEL = String.fromCharCode(0xe000);

const PLACEHOLDER = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");

/**
 * Holds finished text (masked JSON, values deliberately kept) while later stages scan around it, so a stage cannot
 * alter or re-mask it. Placeholders look like `<sentinel>12<sentinel>` and are restored in one pass.
 */
export class Shelf {
    readonly #items: string[] = [];

    protect(text: string): string {
        this.#items.push(text);
        return `${SENTINEL}${this.#items.length - 1}${SENTINEL}`;
    }

    restore(text: string): string {
        return text.replace(PLACEHOLDER, (_placeholder, index: string) => {
            const item = this.#items[Number(index)];
            if (item === undefined) throw new MaskError("masking failed: lost a protected segment");
            return item;
        });
    }
}
