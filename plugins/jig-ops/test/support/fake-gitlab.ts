// A fake GitLab: the endpoints of the REST API (v4) that the adapter uses, answering from a world a test changes as it goes.
// Pipelines are listed newest first and filtered by `ref`, `sha` and `status`; jobs and traces are kept by id. A retry puts
// the failed jobs back to pending, and a create adds a pipeline. The token is checked as GitLab checks it: a request
// without the right one gets 401.
import type { Answer, Recorded, Responder } from "./fake-server.ts";

export interface GlPipeline {
    id: number;
    status: string;
    ref: string;
    sha: string;
    source?: string;
    created_at?: string;
    finished_at?: string | null;
    web_url?: string;
}

export interface GlJob {
    id: number;
    name: string;
    stage?: string;
    status: string;
    allow_failure?: boolean;
    failure_reason?: string;
    web_url?: string;
}

export interface GitlabWorld {
    /** The project as the path in the URL spells it. */
    project: string;
    /** Whether the headers sign in. Default: the `PRIVATE-TOKEN` is `glpat-test-token`. */
    authorized: (headers: Record<string, string>) => boolean;
    pipelines: GlPipeline[];
    jobs: Record<number, GlJob[]>;
    traces: Record<number, string>;
    /** What the creates received: the ref and the variables. */
    created: Array<{ ref: string | null; body: string }>;
    retried: number[];
}

export const TOKEN = "glpat-test-token";
export const SHA = "a".repeat(40);
export const SHA2 = "b".repeat(40);

export function pipeline(id: number, status: string, more: Partial<GlPipeline> = {}): GlPipeline {
    return {
        id,
        status,
        ref: "main",
        sha: SHA,
        source: "push",
        created_at: "2026-10-30T10:00:00.000Z",
        web_url: `https://ci.example.test/acme/orders-api/-/pipelines/${id}`,
        ...more,
    };
}

export function job(id: number, name: string, status: string, more: Partial<GlJob> = {}): GlJob {
    return {
        id,
        name,
        stage: "test",
        status,
        allow_failure: false,
        web_url: `https://ci.example.test/acme/orders-api/-/jobs/${id}`,
        ...more,
    };
}

export function gitlabWorld(more: Partial<GitlabWorld> = {}): GitlabWorld {
    return {
        project: "acme%2Forders-api",
        authorized: (headers) => headers["private-token"] === TOKEN,
        pipelines: [],
        jobs: {},
        traces: {},
        created: [],
        retried: [],
        ...more,
    };
}

const json = (body: unknown, status = 200): Answer => ({ status, json: body });
const NOT_FOUND: Answer = { status: 404, json: { message: "404 Not Found" } };

export function gitlabResponder(world: GitlabWorld): Responder {
    return (request: Recorded): Answer => {
        if (!world.authorized(request.headers)) return json({ message: "401 Unauthorized" }, 401);
        const base = `/api/v4/projects/${world.project}`;
        if (!request.path.startsWith(`${base}/`)) return NOT_FOUND;
        const rest = request.path.slice(base.length);
        const match = (pattern: RegExp) => pattern.exec(rest);

        if (request.method === "GET" && rest === "/pipelines") {
            const want = (name: string) => request.query.get(name);
            const limit = Number(want("per_page") ?? 20);
            const found = world.pipelines
                .filter((p) => want("ref") === null || p.ref === want("ref"))
                .filter((p) => want("sha") === null || p.sha === want("sha"))
                .filter((p) => want("status") === null || p.status === want("status"))
                .sort((a, b) => b.id - a.id)
                .slice(0, limit);
            return json(found);
        }
        let hit = match(/^\/pipelines\/(\d+)$/);
        if (request.method === "GET" && hit) {
            const found = world.pipelines.find((p) => p.id === Number(hit?.[1]));
            return found ? json(found) : NOT_FOUND;
        }
        hit = match(/^\/pipelines\/(\d+)\/jobs$/);
        if (request.method === "GET" && hit) {
            const jobs = world.jobs[Number(hit[1])] ?? [];
            return json([...jobs].sort((a, b) => b.id - a.id));
        }
        hit = match(/^\/jobs\/(\d+)\/trace$/);
        if (request.method === "GET" && hit) {
            const trace = world.traces[Number(hit[1])];
            return trace === undefined ? NOT_FOUND : { text: trace };
        }
        hit = match(/^\/pipelines\/(\d+)\/retry$/);
        if (request.method === "POST" && hit) {
            const found = world.pipelines.find((p) => p.id === Number(hit?.[1]));
            if (!found) return NOT_FOUND;
            world.retried.push(found.id);
            for (const item of world.jobs[found.id] ?? []) if (item.status === "failed") item.status = "pending";
            found.status = "running";
            return json(found, 201);
        }
        if (request.method === "POST" && rest === "/pipeline") {
            world.created.push({ ref: request.query.get("ref"), body: request.body });
            const made = pipeline(Math.max(0, ...world.pipelines.map((p) => p.id)) + 1, "pending", {
                ref: request.query.get("ref") ?? "main",
                source: "api",
            });
            world.pipelines.push(made);
            return json(made, 201);
        }
        return NOT_FOUND;
    };
}
