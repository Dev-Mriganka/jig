// A write whose reply was lost. A timeout, a broken connection, a gateway error or a cancelled call after the request
// left may mean that the CI system did what it was asked. The request is never sent again, because a second rerun or a
// second pipeline could land twice. One read says what the system shows now, and the result tells the model both what
// was found and that nothing was sent twice.
import type { Outcome } from "../values.ts";

/**
 * `look` reads the system once and returns the success text when the change is there, or undefined when it is not.
 * `where` names the system for the message.
 */
export async function afterLostReply(
    what: string,
    why: string,
    where: string,
    look: () => Promise<string | undefined>,
): Promise<Outcome> {
    let found: string | undefined;
    try {
        found = await look();
    } catch (error) {
        throw new Error(
            `${what}: the reply was lost (${why}) and the check failed too (${(error as Error).message}). ` +
                `Look at ${where} before trying again. Nothing was sent twice.`,
        );
    }
    if (found === undefined) {
        throw new Error(
            `${what}: the reply was lost (${why}) and one check shows it did not go through. ` +
                "Nothing was sent twice; run it again if you still want it.",
        );
    }
    return {
        text: `${found}\n(The reply was lost (${why}); one check shows it went through. Nothing was sent twice.)`,
        facts: { outcome: "lost-but-done" },
        details: { lost: true },
    };
}
