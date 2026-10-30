// Removing credentials from an answer. jig-core hides every secret it resolved and every sign-in header from tool results,
// but a server can echo what it was sent, and an access token that this tool fetched itself is unknown to jig-core. So the
// tool removes what it sent from what comes back, before the answer goes anywhere.
import type { Answer } from "./wire.ts";

export const REDACTED = "[redacted]";

/** A shorter value is left alone: removing it would blank common words, and jig-core still hides what it knows. */
const MIN_LENGTH = 8;

/** The forms in which a server may repeat a credential: as it is, inside JSON text, and URL-encoded. */
function formsOf(secret: string): string[] {
    return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
}

/** The answer with every one of the secrets removed from its headers and its body. */
export function scrubbed(answer: Answer, secrets: readonly string[]): Answer {
    // The longest first: a value that contains a shorter one is replaced as a whole.
    const needles = [...new Set(secrets.filter((secret) => secret.length >= MIN_LENGTH).flatMap(formsOf))].sort(
        (a, b) => b.length - a.length,
    );
    if (needles.length === 0) return answer;
    const clean = (text: string): string =>
        needles.reduce((out, needle) => (out.includes(needle) ? out.split(needle).join(REDACTED) : out), text);
    return {
        ...answer,
        text: clean(answer.text),
        headers: Object.fromEntries(Object.entries(answer.headers).map(([name, value]) => [name, clean(value)])),
    };
}
