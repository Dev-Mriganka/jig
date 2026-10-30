// A fake Jira on this machine: a real HTTP server (node:http) on 127.0.0.1 that answers the REST endpoints jig-jira uses
// from fixtures, applies writes to them, and records every request. It plays either edition:
//   cloud        people have account ids; searching pages by token (`/search/jql`) and the classic `/search` is gone (410);
//   datacenter   people have user names and keys; searching pages by offset (`/search`) and `/search/jql` does not exist (404).
// A test can also make the next matching request misbehave: hold its reply past the client's timeout (with the write applied
// or not), answer with an error status, or drop the connection. That is how "the reply to a write was lost" is made.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Flavor = "cloud" | "datacenter";

export interface FakeUser {
    accountId?: string;
    name?: string;
    key?: string;
    displayName: string;
    active: boolean;
}

export interface FakeComment {
    id: string;
    author: FakeUser;
    body: string;
    created: string;
    updated: string;
}

export interface FakeIssue {
    key: string;
    fields: Record<string, unknown>;
    comments: FakeComment[];
    transitions: Array<{ id: string; name: string; to: string }>;
    histories: Array<Record<string, unknown>>;
}

/** One request as the server received it. `path` is below `/rest/api/2`. */
export interface Recorded {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
}

/** What to do to the next request that `match` accepts. */
export interface Misbehaviour {
    match: (request: Recorded) => boolean;
    /** Whether the server carries the request out. Default true: the reply is lost, not the request. */
    apply?: boolean;
    /** Answer this status instead of the real answer. */
    status?: number;
    /** Wait this long before answering or dropping. Default: longer than any timeout a test sets. */
    afterMs?: number;
    /** Drop the connection instead of answering. */
    drop?: boolean;
    /** Answer with this page instead of JSON, as a sign-in gateway does (status 200 unless `status` says otherwise). */
    html?: string;
    /** Answer a redirect to this address (status 302 unless `status` says otherwise). */
    redirect?: string;
    /** Something that happens on the server when the request arrives, such as someone else changing the issue. */
    effect?: () => void;
}

export interface FakeJira {
    flavor: Flavor;
    /** `http://127.0.0.1:<port>`. */
    origin: string;
    requests: Recorded[];
    me: FakeUser;
    users: FakeUser[];
    issues: Map<string, FakeIssue>;
    fields: Array<{ id: string; name: string; custom: boolean }>;
    /** The issues a search returns when its JQL has `summary ~` (a duplicate check). Default: none. */
    duplicates: string[];
    /** Field names that make a search fail with Jira's "Field ... does not exist" error. */
    unknownFields: string[];
    /** How many comments an issue carries inline before the rest must be asked for. Default: all. */
    inlineComments: number;
    /** Whether the create screen can be read. Default true. */
    createScreen: boolean;
    /** A header every request must carry, else it is answered 401. */
    requireHeader?: { name: string; value: string };
    misbehave(rule: Misbehaviour): void;
    /** Requests of a kind, e.g. `fake.sent("POST", "/issue/PROJ-1/comment")`. */
    sent(method: string, path: string | RegExp): Recorded[];
    /** Back to the fixtures, with no requests recorded and no rule waiting. */
    reset(): void;
    close(): Promise<void>;
}

const CLOUD_USERS: FakeUser[] = [
    { accountId: "5b10a2844c20165700ede21g", displayName: "Jane Doe", active: true },
    { accountId: "712020:6c21d3a0-1111-4222-8333-944455556666", displayName: "Sam Lee", active: true },
];
const DATACENTER_USERS: FakeUser[] = [
    { name: "jdoe", key: "JIRAUSER10001", displayName: "Jane Doe", active: true },
    { name: "slee", key: "JIRAUSER10002", displayName: "Sam Lee", active: true },
];

export const DESCRIPTION = [
    "h3. Steps",
    "# Open the login page in Safari 17",
    "# Press *Sign in* twice",
    "",
    "h3. Expected",
    "The page signs in once. See [the spec|https://wiki.example.test/login] and {{LoginForm.submit()}}.",
    "",
    "{code:js}",
    "if (a < b && c > d) { retry(); }",
    "{code}",
].join("\n");

function person(user: FakeUser, flavor: Flavor): Record<string, unknown> {
    return flavor === "cloud"
        ? { accountId: user.accountId, displayName: user.displayName, active: user.active }
        : { name: user.name, key: user.key, displayName: user.displayName, active: user.active };
}

function fixtures(flavor: Flavor, users: FakeUser[]): Map<string, FakeIssue> {
    const [jane, sam] = users as [FakeUser, FakeUser];
    const stamp = (day: string): string => `2026-10-${day}.000+0000`;
    const comment = (id: string, author: FakeUser, body: string, created: string, updated = created): FakeComment => ({ id, author, body, created, updated });
    const issues = new Map<string, FakeIssue>();
    issues.set("PROJ-1", {
        key: "PROJ-1",
        fields: {
            summary: "Fix login crash on Safari",
            issuetype: { id: "10004", name: "Bug" },
            status: { id: "3", name: "In Progress" },
            priority: { id: "2", name: "High" },
            resolution: null,
            assignee: person(jane, flavor),
            reporter: person(sam, flavor),
            labels: ["login", "safari"],
            components: [{ id: "10000", name: "Web" }],
            fixVersions: [],
            created: stamp("01T09:30:00"),
            updated: stamp("12T14:03:22"),
            description: DESCRIPTION,
            parent: { key: "PROJ-10", fields: { summary: "Safari support", status: { name: "In Progress" } } },
            issuelinks: [{
                id: "10100",
                type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
                outwardIssue: { key: "PROJ-3", fields: { summary: "Release 1.2", status: { name: "Open" } } },
            }],
            subtasks: [{ key: "PROJ-4", fields: { summary: "Add a regression test", status: { name: "Open" } } }],
            customfield_10016: 5,
            customfield_10500: "https://git.example.test/org/app/pull/42",
            attachment: [{
                id: "20001", filename: "crash.log", size: 2048, mimeType: "text/plain", created: stamp("02T08:10:00"),
                author: person(sam, flavor), content: "https://jira.example.test/secure/attachment/20001/crash.log",
            }],
        },
        comments: [
            comment("10001", sam, "Reproduced on Safari 17.\n\nSteps are in the description.", stamp("02T08:00:00")),
            comment("10002", jane, "Fix is in [PR 42|https://git.example.test/org/app/pull/42].", stamp("03T10:00:00")),
            comment("10003", sam, "Verified on staging.", stamp("05T11:00:00"), stamp("06T09:00:00")),
        ],
        transitions: [
            { id: "21", name: "Start Progress", to: "In Progress" },
            { id: "31", name: "Resolve Issue", to: "Done" },
            { id: "41", name: "Back to Open", to: "Open" },
        ],
        histories: [
            { id: "30001", author: person(jane, flavor), created: stamp("03T09:00:00"), items: [{ field: "status", fromString: "Open", toString: "In Progress" }] },
            {
                id: "30002", author: person(sam, flavor), created: stamp("04T12:30:00"),
                items: [{ field: "priority", fromString: "Medium", toString: "High" }, { field: "labels", fromString: "", toString: "safari" }],
            },
        ],
    });
    issues.set("PROJ-2", {
        key: "PROJ-2",
        fields: {
            summary: "Update the onboarding guide",
            issuetype: { id: "10002", name: "Task" },
            status: { id: "1", name: "Open" },
            priority: { id: "3", name: "Medium" },
            resolution: null,
            assignee: null,
            reporter: person(jane, flavor),
            labels: [],
            components: [],
            created: stamp("08T10:00:00"),
            updated: stamp("08T10:00:00"),
            description: "Add the new VPN steps.",
            issuelinks: [],
            subtasks: [],
            attachment: [],
        },
        comments: [],
        transitions: [
            { id: "21", name: "Start Progress", to: "In Progress" },
            { id: "51", name: "Close", to: "Closed" },
            { id: "52", name: "Close", to: "Won't Do" },
        ],
        histories: [],
    });
    return issues;
}

const FIELDS = [
    { id: "summary", name: "Summary", custom: false },
    { id: "description", name: "Description", custom: false },
    { id: "labels", name: "Labels", custom: false },
    { id: "priority", name: "Priority", custom: false },
    { id: "assignee", name: "Assignee", custom: false },
    { id: "components", name: "Components", custom: false },
    { id: "customfield_10016", name: "Story Points", custom: true },
    { id: "customfield_10500", name: "Pull Request Link", custom: true },
    { id: "customfield_10600", name: "Acceptance Criteria", custom: true },
];

/** The create screens of project PROJ, by issue type id. A Task must have a component. */
const FIXED_FIELDS = [
    { fieldId: "project", name: "Project", required: true, schema: { type: "project" } },
    { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype" } },
];
const SCREENS: Record<string, Array<Record<string, unknown>>> = {
    "10004": [
        ...FIXED_FIELDS,
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        { fieldId: "description", name: "Description", required: false, schema: { type: "string" } },
        {
            fieldId: "priority", name: "Priority", required: false, schema: { type: "priority" },
            allowedValues: [{ id: "1", name: "Highest" }, { id: "2", name: "High" }, { id: "3", name: "Medium" }, { id: "4", name: "Low" }],
        },
        { fieldId: "labels", name: "Labels", required: false, schema: { type: "array", items: "string" } },
        { fieldId: "assignee", name: "Assignee", required: false, schema: { type: "user" } },
        { fieldId: "components", name: "Components", required: false, schema: { type: "array", items: "component" }, allowedValues: [{ id: "10000", name: "Web" }, { id: "10001", name: "Billing" }] },
        { fieldId: "customfield_10016", name: "Story Points", required: false, schema: { type: "number" } },
        { fieldId: "reporter", name: "Reporter", required: true, schema: { type: "user" } },
    ],
    "10002": [
        ...FIXED_FIELDS,
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        { fieldId: "description", name: "Description", required: false, schema: { type: "string" } },
        { fieldId: "components", name: "Components", required: true, schema: { type: "array", items: "component" }, allowedValues: [{ id: "10000", name: "Web" }, { id: "10001", name: "Billing" }] },
    ],
    "10003": [
        ...FIXED_FIELDS,
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        { fieldId: "parent", name: "Parent", required: true, schema: { type: "issuelink" } },
    ],
};
const TYPES = [
    { id: "10004", name: "Bug", subtask: false },
    { id: "10002", name: "Task", subtask: false },
    { id: "10003", name: "Sub-task", subtask: true },
];

function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

interface Reply {
    status: number;
    body?: unknown;
}

const notFound = (message: string): Reply => ({ status: 404, body: { errorMessages: [message], errors: {} } });
const badRequest = (errors: Record<string, string>, messages: string[] = []): Reply => ({ status: 400, body: { errorMessages: messages, errors } });

export async function startFakeJira(flavor: Flavor = "cloud"): Promise<FakeJira> {
    const users = (): FakeUser[] => structuredClone(flavor === "cloud" ? CLOUD_USERS : DATACENTER_USERS);
    let nextIssue = 100;
    let nextComment = 10100;
    let rules: Misbehaviour[] = [];

    const fake: FakeJira = {
        flavor,
        origin: "",
        requests: [],
        users: users(),
        me: undefined as unknown as FakeUser,
        issues: new Map(),
        fields: [],
        duplicates: [],
        unknownFields: [],
        inlineComments: Number.POSITIVE_INFINITY,
        createScreen: true,
        misbehave: (rule) => void rules.push(rule),
        sent: (method, path) => fake.requests.filter((request) => request.method === method && (typeof path === "string" ? request.path === path : path.test(request.path))),
        reset() {
            fake.requests = [];
            fake.users = users();
            fake.me = fake.users[0] as FakeUser;
            fake.issues = fixtures(flavor, fake.users);
            fake.fields = structuredClone(FIELDS);
            fake.duplicates = [];
            fake.unknownFields = [];
            fake.inlineComments = Number.POSITIVE_INFINITY;
            fake.createScreen = true;
            delete fake.requireHeader;
            rules = [];
            nextIssue = 100;
            nextComment = 10100;
        },
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        }),
    };

    const userJson = (user: FakeUser): Record<string, unknown> => person(user, flavor);
    const findUser = (reference: unknown): FakeUser | undefined => {
        const wanted = reference as Record<string, string> | null;
        return fake.users.find((user) => wanted !== null && (user.accountId === wanted.accountId && wanted.accountId !== undefined || user.name === wanted.name && wanted.name !== undefined));
    };
    const issueJson = (issue: FakeIssue, query: Record<string, string>): Record<string, unknown> => {
        const wanted = (query.fields ?? "*all").split(",");
        const fields: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(issue.fields)) if (wanted.includes("*all") || wanted.includes(name)) fields[name] = value;
        if (wanted.includes("*all") || wanted.includes("comment")) {
            const inline = issue.comments.slice(0, fake.inlineComments);
            fields.comment = { comments: inline.map((c) => commentJson(c)), total: issue.comments.length, maxResults: inline.length, startAt: 0 };
        }
        const json: Record<string, unknown> = { id: `1${issue.key.replace(/\D/g, "")}`, key: issue.key, self: `${fake.origin}/rest/api/2/issue/${issue.key}`, fields };
        if ((query.expand ?? "").includes("changelog")) {
            json.changelog = { startAt: 0, maxResults: 100, total: issue.histories.length, histories: issue.histories };
        }
        return json;
    };
    const commentJson = (comment: FakeComment): Record<string, unknown> => ({
        id: comment.id, author: userJson(comment.author), body: comment.body, created: comment.created, updated: comment.updated,
    });

    /** Answers a request from the fixtures, applying writes to them. */
    function answer(request: Recorded): Reply {
        const { method, path, query } = request;
        const body = request.body as Record<string, any> | undefined;
        let match: RegExpExecArray | null;

        if (fake.requireHeader !== undefined && request.headers[fake.requireHeader.name] !== fake.requireHeader.value) {
            return { status: 401, body: { message: "Unauthorized" } };
        }
        if (method === "GET" && path === "/myself") return { status: 200, body: userJson(fake.me) };
        if (method === "GET" && path === "/field") return { status: 200, body: fake.fields };

        if (method === "GET" && (match = /^\/project\/([A-Z]+)$/.exec(path))) {
            return match[1] === "PROJ" ? { status: 200, body: { key: "PROJ", name: "Project" } } : notFound(`No project could be found with key '${match[1]}'.`);
        }
        if (method === "GET" && (match = /^\/issue\/createmeta\/([A-Z]+)\/issuetypes(?:\/(\d+))?$/.exec(path))) {
            if (match[1] !== "PROJ") return notFound(`No project could be found with key '${match[1]}'.`);
            if (!fake.createScreen) return notFound("Not Found");
            const rows = match[2] === undefined ? TYPES : SCREENS[match[2]];
            if (rows === undefined) return notFound("Issue type not found");
            const name = flavor === "cloud" ? (match[2] === undefined ? "issueTypes" : "fields") : "values";
            return { status: 200, body: { startAt: 0, maxResults: 100, total: rows.length, ...(flavor === "datacenter" ? { isLast: true } : {}), [name]: rows } };
        }

        if (method === "GET" && path === "/user/assignable/search") {
            const text = (query.query ?? query.username ?? "").toLowerCase();
            const found = fake.users.filter((user) => text === "" || [user.displayName, user.name, user.accountId, user.key].some((value) => value?.toLowerCase().includes(text)));
            return { status: 200, body: found.map(userJson) };
        }

        if (method === "GET" && (path === "/search" || path === "/search/jql")) {
            const enhanced = path === "/search/jql";
            if (enhanced && flavor === "datacenter") return { status: 404, body: { message: "null for uri: /rest/api/2/search/jql", "status-code": 404 } };
            if (!enhanced && flavor === "cloud") return { status: 410, body: { errorMessages: ["The requested API has been removed. Please migrate to the /rest/api/2/search/jql API."], errors: {} } };
            const jql = query.jql ?? "";
            const unknown = fake.unknownFields.find((name) => jql.includes(name));
            if (unknown !== undefined) return badRequest({}, [`Field '${unknown}' does not exist or you do not have permission to view it.`]);
            const matching = /summary ~/.test(jql) ? fake.duplicates.flatMap((key) => fake.issues.get(key) ?? []) : [...fake.issues.values()];
            const size = Number(query.maxResults ?? 50);
            const start = Number(enhanced ? (query.nextPageToken ?? 0) : (query.startAt ?? 0));
            const page = matching.slice(start, start + size).map((issue) => issueJson(issue, query));
            const more = start + size < matching.length;
            return {
                status: 200,
                body: enhanced
                    ? { issues: page, ...(more ? { nextPageToken: String(start + size) } : {}), isLast: !more }
                    : { startAt: start, maxResults: size, total: matching.length, issues: page },
            };
        }

        if (method === "POST" && path === "/issue") {
            const fields = (body?.fields ?? {}) as Record<string, any>;
            if (fields.summary === undefined) return badRequest({ summary: "You must specify a summary of the issue." });
            const key = `PROJ-${nextIssue++}`;
            fake.issues.set(key, {
                key,
                fields: {
                    ...fields,
                    status: { name: "Open" },
                    issuetype: { name: fields.issuetype?.name ?? TYPES.find((type) => type.id === fields.issuetype?.id)?.name },
                    created: "2026-10-30T10:00:00.000+0000",
                },
                comments: [], transitions: [{ id: "21", name: "Start Progress", to: "In Progress" }], histories: [],
            });
            return { status: 201, body: { id: `1${key.replace(/\D/g, "")}`, key, self: `${fake.origin}/rest/api/2/issue/${key}` } };
        }

        if ((match = /^\/issue\/([A-Z]+-\d+)(?:\/(comment|transitions)(?:\/(\d+))?)?$/.exec(path)) !== null) {
            const issue = fake.issues.get(match[1] as string);
            if (issue === undefined) return notFound("Issue does not exist or you do not have permission to see it.");
            const [, , part, id] = match;
            if (part === undefined) {
                if (method === "GET") return { status: 200, body: issueJson(issue, query) };
                if (method === "PUT") {
                    const fields = (body?.fields ?? {}) as Record<string, any>;
                    const known = new Set([...fake.fields.map((field) => field.id), "status"]);
                    for (const id of Object.keys(fields)) if (!known.has(id)) return badRequest({ [id]: `Field '${id}' cannot be set. It is not on the appropriate screen, or unknown.` });
                    for (const [id, value] of Object.entries(fields)) {
                        if (id === "assignee" && value !== null) {
                            const user = findUser(value);
                            if (user === undefined) return badRequest({ assignee: "User does not exist" });
                            issue.fields.assignee = userJson(user);
                        } else {
                            issue.fields[id] = value;
                        }
                    }
                    return { status: 204 };
                }
            }
            if (part === "comment") {
                if (id === undefined && method === "GET") {
                    const start = Number(query.startAt ?? 0);
                    const size = Number(query.maxResults ?? 50);
                    const page = issue.comments.slice(start, start + size);
                    return { status: 200, body: { startAt: start, maxResults: size, total: issue.comments.length, comments: page.map(commentJson) } };
                }
                if (id === undefined && method === "POST") {
                    const now = "2026-10-30T10:00:00.000+0000";
                    const created: FakeComment = { id: String(nextComment++), author: fake.me, body: String(body?.body ?? ""), created: now, updated: now };
                    issue.comments.push(created);
                    return { status: 201, body: commentJson(created) };
                }
                const existing = issue.comments.find((comment) => comment.id === id);
                if (id !== undefined && existing === undefined) return notFound(`Can't find a comment with the id ${id}`);
                if (existing !== undefined && method === "GET") return { status: 200, body: commentJson(existing) };
                if (existing !== undefined && method === "PUT") {
                    existing.body = String(body?.body ?? "");
                    existing.updated = "2026-10-30T10:05:00.000+0000";
                    return { status: 200, body: commentJson(existing) };
                }
                if (existing !== undefined && method === "DELETE") {
                    issue.comments = issue.comments.filter((comment) => comment !== existing);
                    return { status: 204 };
                }
            }
            if (part === "transitions") {
                if (method === "GET") {
                    return { status: 200, body: { expand: "transitions", transitions: issue.transitions.map((t) => ({ id: t.id, name: t.name, to: { id: t.to, name: t.to }, hasScreen: false })) } };
                }
                if (method === "POST") {
                    const chosen = issue.transitions.find((t) => t.id === body?.transition?.id);
                    if (chosen === undefined) return badRequest({}, [`Transition id '${body?.transition?.id}' is not valid for this issue.`]);
                    const from = (issue.fields.status as { name: string }).name;
                    issue.fields.status = { name: chosen.to };
                    issue.histories.push({
                        id: String(40000 + issue.histories.length), author: userJson(fake.me), created: "2026-10-30T10:00:00.000+0000",
                        items: [{ field: "status", fromString: from, toString: chosen.to }],
                    });
                    return { status: 204 };
                }
            }
        }
        return notFound(`No such endpoint: ${method} ${path}`);
    }

    const server = http.createServer((incoming, outgoing) => {
        void (async () => {
            const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(incoming.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
            const text = await readBody(incoming);
            const request: Recorded = {
                method: incoming.method ?? "GET",
                path: url.pathname.replace(/^\/rest\/api\/2/, ""),
                query: Object.fromEntries(url.searchParams),
                headers,
                body: text === "" ? undefined : JSON.parse(text),
            };
            fake.requests.push(request);

            const index = rules.findIndex((rule) => rule.match(request));
            const rule = index < 0 ? undefined : rules.splice(index, 1)[0];
            rule?.effect?.();
            const reply: Reply | undefined = rule?.apply === false ? undefined : answer(request);
            if (rule === undefined) {
                send(outgoing, reply as Reply);
                return;
            }
            const timer = setTimeout(() => {
                if (rule.drop === true) incoming.socket.destroy();
                else if (rule.html !== undefined) outgoing.writeHead(rule.status ?? 200, { "content-type": "text/html" }).end(rule.html);
                else if (rule.redirect !== undefined) outgoing.writeHead(rule.status ?? 302, { location: rule.redirect }).end();
                else send(outgoing, rule.status === undefined ? (reply ?? { status: 200, body: {} }) : { status: rule.status, body: { errorMessages: ["Service Unavailable"] } });
            }, rule.afterMs ?? 5_000);
            timer.unref();
            incoming.socket.on("close", () => clearTimeout(timer));
        })().catch((error: unknown) => {
            outgoing.writeHead(500).end(String(error));
        });
    });

    function send(outgoing: http.ServerResponse, reply: Reply): void {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
        outgoing.writeHead(reply.status, text === "" ? {} : { "content-type": "application/json" }).end(text);
    }

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake.reset();
    return fake;
}
