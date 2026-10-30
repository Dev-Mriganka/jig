// The plans for the two writes on a link between issues: make one, and remove one.
//
// A link has two ends. The outward end reads the type's outward phrase ("blocks") and the inward end its inward phrase
// ("is blocked by"). A call reads "key <phrase> to", so `link PROJ-1 to PROJ-2 as "blocks"` makes PROJ-1 block PROJ-2, and
// the same link given as "is blocked by" from the other side is the same link. Jira's request names the two ends:
// `outwardIssue` is the issue that reads the outward phrase, `inwardIssue` the one that reads the inward phrase.
import { issueHead, issueWithLinks, linkTypes, phraseOf } from "./api.ts";
import type { Env, IssueLink, LinkType } from "./api.ts";
import { about } from "./plan.ts";
import type { CallOf, Plan } from "./plan.ts";
import { InputError, shortList } from "./values.ts";

/** `Blocks (blocks / is blocked by)`: a type with what its two ends read. */
const describeType = (type: LinkType): string => `${type.name} (${type.outward} / ${type.inward})`;

interface Chosen {
    type: LinkType;
    /** True when `key` is the outward end: the call said the type's name or its outward phrase. */
    outward: boolean;
}

/**
 * The link type a call means. A name, an id or the outward phrase makes the first issue the outward end ("PROJ-1 blocks
 * PROJ-2"); the inward phrase turns the link round ("PROJ-1 is blocked by PROJ-2"). Case does not matter. Anything that
 * matches no type, or more than one, is an InputError that says what there is to choose from.
 */
export function pickLinkType(types: readonly LinkType[], wanted: string): Chosen {
    const lower = wanted.toLowerCase();
    const named = (type: LinkType): boolean => type.name.toLowerCase() === lower;
    const byId = /^\d+$/.test(wanted) ? types.filter((type) => type.id === wanted) : [];
    const byName = types.filter(named);
    const byPhrase = types.flatMap((type): Chosen[] => {
        if (type.outward.toLowerCase() === lower) return [{ type, outward: true }];
        return type.inward.toLowerCase() === lower ? [{ type, outward: false }] : [];
    });
    const found: Chosen[] =
        byId.length > 0
            ? byId.map((type) => ({ type, outward: true }))
            : byName.length > 0
              ? byName.map((type) => ({ type, outward: true }))
              : byPhrase;
    const [only] = found;
    if (found.length === 1 && only !== undefined) return only;
    if (found.length > 1) {
        const choices = shortList(
            found.map((entry) => entry.type.name),
            ", ",
            80,
        );
        throw new InputError(`jira link: "${wanted.slice(0, 40)}" matches several link types (${choices}); use a name`);
    }
    const available = shortList(types.map(describeType), "; ", 90) || "none";
    throw new InputError(
        `jira link: no link type "${wanted.slice(0, 40)}"; link_types lists them. Available: ${available}`,
    );
}

/** True when `link` is of the type `wanted` names: by name, id or either phrase, without regard to case. */
function isOfType(link: IssueLink, wanted: string): boolean {
    const lower = wanted.toLowerCase();
    const { type } = link;
    return [type.name, type.id, type.outward, type.inward].some((text) => text !== "" && text.toLowerCase() === lower);
}

/** A type whose two ends read the same, such as "relates to", has no direction. */
const symmetric = (type: LinkType): boolean => type.inward.toLowerCase() === type.outward.toLowerCase();

export async function planLink(env: Env, call: CallOf<"link">): Promise<Plan> {
    const [first, second, types] = await Promise.all([
        issueWithLinks(env, call.key),
        issueHead(env, call.to),
        linkTypes(env),
    ]);
    const { type, outward } = pickLinkType(types, call.linkType);
    const phrase = outward ? type.outward : type.inward;
    const back = outward ? type.inward : type.outward;
    const relation = `${call.key} ${phrase} ${call.to}`;

    // The same link twice would be a second link on the page, not a second chance.
    const existing = first.links.find(
        (link) =>
            link.other.key === call.to && link.type.name === type.name && (link.outward === outward || symmetric(type)),
    );
    if (existing !== undefined)
        throw new InputError(`jira link: ${call.key} already has this link: ${relation} (link ${existing.id})`);

    const outwardKey = outward ? call.key : call.to;
    const inwardKey = outward ? call.to : call.key;
    const exists = (links: readonly IssueLink[]): IssueLink | undefined =>
        links.find((link) => link.other.key === call.to && link.type.name === type.name);

    return {
        key: call.key,
        shown: {
            summary: `Link ${about(first)} ${phrase} ${about(second)} (link type ${type.name})`,
            flags: [],
            rows: [
                ["Issue", `${about(first)} (${first.status})`],
                ["Relation", phrase],
                ["Other issue", `${about(second)} (${second.status})`],
                ["Link type", describeType(type)],
            ],
            notes: [
                `Seen from ${call.to}: "${back} ${call.key}". Jira receives outwardIssue ${outwardKey} ` +
                    `(the one that "${type.outward}") and inwardIssue ${inwardKey}.`,
            ],
            texts: [],
        },
        send: {
            method: "POST",
            path: "/issueLink",
            body: { type: { name: type.name }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } },
        },
        basis: { relation, type: type.id },
        async check() {
            const now = exists((await issueWithLinks(env, call.key)).links);
            if (now === undefined) {
                return { happened: false, text: `${call.key} holds no ${type.name} link to ${call.to}` };
            }
            if (now.outward !== outward && !symmetric(type)) {
                return {
                    happened: undefined,
                    text: `${call.key} holds a ${type.name} link to ${call.to}, but it reads "${phraseOf(now)}", not "${phrase}"`,
                };
            }
            return { happened: true, text: `${call.key} now ${phrase} ${call.to} (link ${now.id})` };
        },
        done: () => ({ text: `Linked: ${relation} (${type.name}).`, key: call.key }),
    };
}

export async function planUnlink(env: Env, call: CallOf<"unlink">): Promise<Plan> {
    const issue = await issueWithLinks(env, call.key);
    const toThat = issue.links.filter((link) => link.other.key === call.to);
    const matching =
        call.linkType === undefined ? toThat : toThat.filter((link) => isOfType(link, call.linkType ?? ""));
    const reads = (link: IssueLink): string => `${phraseOf(link)} ${link.other.key} [${link.type.name}]`;

    const [link] = matching;
    if (matching.length > 1) {
        const choices = shortList(matching.map(reads), "; ", 100);
        throw new InputError(
            `jira unlink: ${call.key} has ${matching.length} links to ${call.to} (${choices}); name one with linkType`,
        );
    }
    if (link === undefined) {
        const wording = call.linkType === undefined ? "" : ` of type "${call.linkType.slice(0, 40)}"`;
        const other = toThat.length > 0 ? toThat : issue.links;
        const listed = shortList(other.map(reads), "; ", 100);
        const what = toThat.length > 0 ? `its links to ${call.to}` : "its links";
        throw new InputError(
            `jira unlink: ${call.key} has no link to ${call.to}${wording}; ${what}: ${listed || "none"}`,
        );
    }
    if (link.id === "")
        throw new InputError(`jira unlink: Jira gave no id for the link of ${call.key}, so it cannot be removed`);

    const phrase = phraseOf(link);
    const other = link.other.summary === "" ? link.other.key : `${link.other.key} "${link.other.summary}"`;
    const relation = `${call.key} ${phrase} ${call.to}`;
    return {
        key: call.key,
        shown: {
            summary: `Remove the link "${relation}" between ${about(issue)} and ${other} (link type ${link.type.name})`,
            flags: [],
            rows: [
                ["Issue", `${about(issue)} (${issue.status})`],
                ["Relation", phrase],
                ["Other issue", link.other.status === "" ? other : `${other} (${link.other.status})`],
                ["Link type", describeType(link.type)],
                ["Link id", link.id],
            ],
            notes: ["Only this link is removed; neither issue is changed otherwise. Linking again brings it back."],
            texts: [],
        },
        send: { method: "DELETE", path: `/issueLink/${link.id}` },
        basis: { id: link.id, relation, type: link.type.id },
        async check() {
            const still = (await issueWithLinks(env, call.key)).links.some((entry) => entry.id === link.id);
            return still
                ? { happened: false, text: `link ${link.id} is still on ${call.key}` }
                : { happened: true, text: `link ${link.id} is no longer on ${call.key}` };
        },
        done: () => ({ text: `Removed the link: ${relation} (${link.type.name}).`, key: call.key }),
    };
}
