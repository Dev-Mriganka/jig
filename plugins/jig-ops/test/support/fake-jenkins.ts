// A fake Jenkins: the remote access API paths that the adapter uses, answering from a world a test changes as it goes.
// A POST needs the CSRF crumb the crumb issuer handed out, and the cookie it set, as Jenkins with a crumb issuer wants;
// without a crumb issuer the world answers 404 there and takes any POST. The user and API token are checked as basic
// authentication.
import type { Answer, Recorded, Responder } from "./fake-server.ts";

export interface JkBuild {
    number: number;
    result: string | null;
    building: boolean;
    timestamp?: number;
    duration?: number;
    url?: string;
}

export interface JkStage {
    name: string;
    status: string;
    durationMillis?: number;
}

export interface JenkinsWorld {
    /** The path of the job, as the URL spells it: `/job/orders/job/build`. */
    job: string;
    /** The `authorization` header that signs in. Default: basic `ci-bot:jenkins-api-token`. */
    authorized: (headers: Record<string, string>) => boolean;
    builds: JkBuild[];
    /** The stages of a build, by number; a build without an entry has no stage page (a freestyle job). */
    stages: Record<number, JkStage[]>;
    consoles: Record<number, string>;
    buildable: boolean;
    inQueue: boolean;
    /** Whether the server has a crumb issuer. */
    crumbs: boolean;
    /** What the builds started received: the path and the form body. */
    started: Array<{ path: string; body: string }>;
}

export const USER = "ci-bot";
export const TOKEN = "jenkins-api-token";
export const CRUMB = "crumb-0123456789abcdef";
export const SESSION = "JSESSIONID.test=abc123";

export function build(number: number, result: string | null, more: Partial<JkBuild> = {}): JkBuild {
    return {
        number,
        result,
        building: result === null,
        timestamp: Date.parse("2026-10-30T10:00:00Z"),
        duration: result === null ? 0 : 252_000,
        url: `https://ci.example.test/job/orders/job/build/${number}/`,
        ...more,
    };
}

export function jenkinsWorld(more: Partial<JenkinsWorld> = {}): JenkinsWorld {
    return {
        job: "/job/orders/job/build",
        authorized: (headers) =>
            headers.authorization === `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`,
        builds: [],
        stages: {},
        consoles: {},
        buildable: true,
        inQueue: false,
        crumbs: true,
        started: [],
        ...more,
    };
}

const json = (body: unknown, status = 200): Answer => ({ status, json: body });
const HTML: Answer = { status: 404, text: "<html><body>Not found</body></html>" };

/** The `tree=` of a request, as the fields it names at the top level (`builds[...]` counts as `builds`). */
function wanted(request: Recorded): string[] | undefined {
    const tree = request.query.get("tree");
    if (tree === null) return undefined;
    return tree
        .replace(/\[[^\]]*\](\{[^}]*\})?/g, "")
        .split(",")
        .filter(Boolean);
}

function pick<T extends object>(item: T, request: Recorded): Partial<T> {
    const fields = wanted(request);
    if (fields === undefined) return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => fields.includes(key))) as Partial<T>;
}

export function jenkinsResponder(world: JenkinsWorld): Responder {
    return (request: Recorded): Answer => {
        if (!world.authorized(request.headers)) return { status: 403, text: "Forbidden" };
        if (request.path === "/crumbIssuer/api/json") {
            if (!world.crumbs) return HTML;
            return {
                json: {
                    _class: "hudson.security.csrf.DefaultCrumbIssuer",
                    crumb: CRUMB,
                    crumbRequestField: "Jenkins-Crumb",
                },
                cookies: [`${SESSION}; Path=/; HttpOnly`],
            };
        }
        if (!request.path.startsWith(`${world.job}/`) && request.path !== `${world.job}/api/json`) return HTML;
        const rest = request.path.slice(world.job.length);

        if (request.method === "POST") {
            if (world.crumbs) {
                const ok =
                    request.headers["jenkins-crumb"] === CRUMB && (request.headers.cookie ?? "").includes(SESSION);
                if (!ok)
                    return {
                        status: 403,
                        text: "<html>HTTP ERROR 403 No valid crumb was included in the request</html>",
                    };
            }
            if (rest !== "/build" && rest !== "/buildWithParameters") return HTML;
            world.started.push({ path: rest, body: request.body });
            const next = Math.max(0, ...world.builds.map((b) => b.number)) + 1;
            return { status: 201, headers: { location: `https://ci.example.test/queue/item/${next}/` }, text: "" };
        }

        if (rest === "/api/json") {
            const tree = request.query.get("tree") ?? "";
            if (tree.startsWith("builds[")) {
                const limit = Number(/\{0,(\d+)\}/.exec(tree)?.[1] ?? 100);
                return json({ builds: [...world.builds].sort((a, b) => b.number - a.number).slice(0, limit) });
            }
            const next = Math.max(0, ...world.builds.map((b) => b.number)) + 1;
            return json(
                pick(
                    { name: "build", buildable: world.buildable, inQueue: world.inQueue, nextBuildNumber: next },
                    request,
                ),
            );
        }
        const hit = /^\/(\d+|lastBuild|lastFailedBuild)\/(api\/json|wfapi\/describe|consoleText)$/.exec(rest);
        if (!hit) return HTML;
        const sorted = [...world.builds].sort((a, b) => b.number - a.number);
        const found =
            hit[1] === "lastBuild"
                ? sorted[0]
                : hit[1] === "lastFailedBuild"
                  ? sorted.find((b) => b.result !== null && b.result !== "SUCCESS")
                  : sorted.find((b) => b.number === Number(hit[1]));
        if (!found) return HTML;
        if (hit[2] === "api/json") return json(pick(found, request));
        if (hit[2] === "wfapi/describe") {
            const stages = world.stages[found.number];
            return stages === undefined ? HTML : json({ id: String(found.number), status: found.result, stages });
        }
        return { text: world.consoles[found.number] ?? "" };
    };
}
