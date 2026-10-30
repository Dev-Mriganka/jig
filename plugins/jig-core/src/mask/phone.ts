// Shared phone-number facts: extension syntax and the digits that identify a number.

/** A trailing extension such as ` ext. 345` or `x99`. It is removed with the number, so it cannot narrow it down. */
const EXTENSION_SUFFIX = /\s*(?:ext\.?|x)\s*\d{1,5}$/i;

const NATIONAL_LENGTH = 10;

/** Digits of a phone number without its extension or a leading North American `1`, so spellings agree. */
export function phoneDigits(text: string): string {
    const digits = text.replace(EXTENSION_SUFFIX, "").replace(/\D/g, "");
    return digits.length === NATIONAL_LENGTH + 1 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** Token suffix: the last four digits stay visible so a number can still be matched against a ticket. */
export function lastFour(digits: string): string {
    return digits.slice(-4);
}

/** E.164 allows at most 15 digits; fewer than 8 is not a dialable number. */
export function isPlausiblePhone(digits: string): boolean {
    return digits.length >= 8 && digits.length <= 15;
}
