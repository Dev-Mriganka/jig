// Patterns for personal data in free text, applied in order: broad numeric shapes (phones, IPs) come after the
// narrower ones that contain digits too (addresses, cards). Each stage works on the output of the previous one.
// Boundaries use lookarounds so that two matches may share a separator, and no pattern can rescan a long run.
import type { Host } from "./host.ts";
import { isInternalIp, parseIPv4, parseIPv6 } from "./ip.ts";
import { removed } from "./kinds.ts";
import { luhn } from "./luhn.ts";
import { isPlausiblePhone, lastFour, phoneDigits } from "./phone.ts";

// Every replacement is protected: later stages must not re-scan a token (an all-digit hex token followed by a
// last-four suffix looks like a phone number) nor split a removal marker.
type Context = Pick<Host, "tokens" | "protect">;
type Stage = (text: string, context: Context) => string;

const EXT = String.raw`(?:\s*(?:ext\.?|x)\s*\d{1,5})?`;

// House number, street name (a single letter is enough: `1 A St`) and street suffix, then whatever of city, state with
// postal code, and country follows. Whatever follows is removed with the street: it narrows the person down too.
const ADDRESS = new RegExp(
    String.raw`\b\d{1,6}\s+[A-Za-z][A-Za-z ]{0,40}\s+(?:Lane|Street|St|Road|Rd|Avenue|Ave|Blvd)\b` +
        String.raw`(?:,\s*[A-Za-z ]+)?(?:,\s*[A-Z]{2}\s+\d{5})?(?:,\s*[A-Z]{2})?`,
    "gi",
);
const INTERNATIONAL_PHONE = new RegExp(
    String.raw`(?<![A-Za-z0-9_+.-])\+[1-9](?:[ .-]?\d){7,14}${EXT}(?![A-Za-z0-9_-]|\.\d)`,
    "gi",
);
// Only phone-formatted numbers: `(415) 555-0132`, `415-555-0132`, `415.555.0132`, `1-415-555-0132`. A bare run of
// ten or eleven digits is an identifier. Not the tail of a dotted number (`10.415.555.0132`).
const NATIONAL_PHONE = new RegExp(
    String.raw`(?<![A-Za-z0-9_-]|\d\.)(?:\+?1[ .-])?` +
        String.raw`(?:\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})` +
        String.raw`${EXT}(?![A-Za-z0-9_-]|\.\d)`,
    "gi",
);

const streetAddress: Stage = (text, { protect }) => text.replace(ADDRESS, () => protect(removed("address")));

const coordinates: Stage = (text, { protect }) =>
    text.replace(/\b(?:gps|lat|lon|latitude|longitude)\s*=\s*-?\d{1,3}\.\d{4,}(?:\s*,\s*-?\d{1,3}\.\d{4,})?/gi, () =>
        protect(removed("geo")),
    );

const dateOfBirth: Stage = (text, { protect }) =>
    text.replace(/\b(?:DOB\s+)(?:\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/gi, () => `DOB ${protect(removed("birth"))}`);

// The lookbehind covers every local-part character, so a long run is tried once, from its start.
const email: Stage = (text, { tokens, protect }) => {
    if (!text.includes("@")) return text;
    return text.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (found) =>
        protect(tokens.mint("email", found)),
    );
};

/**
 * Card numbers written like cards: three to five groups of digits split by spaces or dashes (`4111 1111 1111 1111`,
 * `3782 822463 10005`), 13-19 digits in all, passing the Luhn check. A bare run of digits is an identifier.
 * Of the groups found, the longest prefix that is a valid card is masked, and a candidate that is not one does not
 * hide a card later in the text (`qty 5 4111 ...`), so the search resumes one character after its start.
 */
const cards: Stage = (text, { protect }) => {
    const pattern = /(?<![A-Za-z0-9_-])\d{4,6}(?:[ -]\d{4,6}){1,4}(?:[ -]\d{1,3})?(?![A-Za-z0-9_-])/g;
    let out = "";
    let cursor = 0;
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
        const groups = found[0].split(/[ -]/);
        let hit: { groups: number; digits: string } | undefined;
        for (let count = groups.length; count >= 3 && hit === undefined; count--) {
            const digits = groups.slice(0, count).join("");
            if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) hit = { groups: count, digits };
        }
        if (hit === undefined) {
            pattern.lastIndex = found.index + 1;
            continue;
        }
        const end = found.index + groups.slice(0, hit.groups).join("-").length; // separators are one character each
        out += text.slice(cursor, found.index) + protect(`card ****${lastFour(hit.digits)}`);
        cursor = end;
        pattern.lastIndex = end;
    }
    return out + text.slice(cursor);
};

function maskedPhone(number: string, { tokens, protect }: Context, accept: (digits: string) => boolean): string {
    const base = phoneDigits(number);
    if (!accept(base)) return number;
    return protect(`${tokens.mint("phone", base)}-${lastFour(base)}`);
}

// International: `+` and a country code, 8-15 digits. A trailing sentence period is not part of the number.
const phoneInternational: Stage = (text, context) =>
    text.replace(INTERNATIONAL_PHONE, (number) => maskedPhone(number, context, isPlausiblePhone));

// North American numbers written with separators or parentheses, with or without `1` or `+1`, and an extension.
const phoneNational: Stage = (text, context) =>
    text.replace(NATIONAL_PHONE, (number) => maskedPhone(number, context, (digits) => digits.length === 10));

const socialSecurity: Stage = (text, { protect }) =>
    text.replace(/(?<![A-Za-z0-9_-])\d{3}-\d{2}-\d{4}\b/g, () => protect(removed("government")));

const MAX_IPV6_LENGTH = 45;
const WORD_CHARACTER = /[A-Za-z0-9_]/;

/**
 * IPv6, public addresses only (internal ones identify infrastructure and stay readable). Works on whole runs of
 * hex digits, colons and dots so each run is examined once. Trailing punctuation the run swallowed
 * (`2001:db8::1.`, `2001:db8::1:`) is set aside before parsing and put back.
 */
const ipv6: Stage = (text, { tokens, protect }) => {
    if (!text.includes(":")) return text;
    return text.replace(/[0-9a-f:.]{2,}/gi, (candidate, offset: number) => {
        if (candidate.length > MAX_IPV6_LENGTH || !candidate.includes(":")) return candidate;
        const before = text[offset - 1] ?? "";
        const after = text[offset + candidate.length] ?? "";
        if (WORD_CHARACTER.test(before) || WORD_CHARACTER.test(after)) return candidate;
        let address = candidate;
        for (let tail = ""; ; ) {
            if (parseIPv6(address) !== undefined) {
                if (isInternalIp(address)) return candidate;
                return protect(tokens.mint("ip", address)) + tail;
            }
            if (tail.length === 3 || !/[.:]$/.test(address)) return candidate;
            tail = address.slice(-1) + tail;
            address = address.slice(0, -1);
        }
    });
};

const ipv4: Stage = (text, { tokens, protect }) => {
    if (!text.includes(".")) return text;
    return text.replace(/(?<![A-Za-z0-9_.-])(?:\d{1,3}\.){3}\d{1,3}\b/g, (candidate) => {
        if (parseIPv4(candidate) === undefined || isInternalIp(candidate)) return candidate;
        return protect(tokens.mint("ip", candidate));
    });
};

const DIGIT = /\d/;

// `needs` is a cheap test that lets a stage be skipped for text that cannot match, which is most short values.
const STAGES: ReadonlyArray<{ stage: Stage; needs?: RegExp }> = [
    { stage: streetAddress, needs: DIGIT },
    { stage: coordinates, needs: DIGIT },
    { stage: dateOfBirth, needs: DIGIT },
    { stage: email },
    { stage: cards, needs: DIGIT },
    { stage: phoneInternational, needs: DIGIT },
    { stage: phoneNational, needs: DIGIT },
    { stage: socialSecurity, needs: DIGIT },
    { stage: ipv6 },
    { stage: ipv4, needs: DIGIT },
];

/** Public IP addresses in `text`, for values of IP-named fields. Tokens hold no `.` or `:`, so the stages compose. */
export function maskIpAddresses(text: string, context: Pick<Host, "tokens">): string {
    const direct = { ...context, protect: (segment: string): string => segment };
    return ipv4(ipv6(text, direct), direct);
}

export function maskFreeText(text: string, context: Context): string {
    return STAGES.reduce(
        (current, { stage, needs }) => (needs === undefined || needs.test(current) ? stage(current, context) : current),
        text,
    );
}
