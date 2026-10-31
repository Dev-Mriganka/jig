// GitLab's answers, written down in the shape its REST API (v4) gives them: the fields are the ones a real merge request,
// pipeline job and discussion carry (a merge request was recorded once from a public project and trimmed to what the plugin
// reads). Every name is made up: `acme/orders-api`, `gitlab.example.com`, `alice`.

export const HEAD = "1111111111111111111111111111111111111111";
const HOST = "https://gitlab.example.com";

/** A merge request, as `GET projects/:id/merge_requests/:iid` gives it. */
export function mr(overrides: Record<string, unknown> = {}, path = "acme/orders-api"): Record<string, unknown> {
    return {
        id: 90042,
        iid: 42,
        project_id: 7,
        title: "Add the thing",
        description: "What changed and why.",
        state: "opened",
        created_at: "2026-10-30T09:00:00.000Z",
        updated_at: "2026-10-31T09:00:00.000Z",
        target_branch: "main",
        source_branch: "feature/one",
        author: { id: 5, username: "hp", name: "H P", state: "active", bot: false },
        assignees: [],
        reviewers: [{ id: 11, username: "alice", name: "Alice", state: "active" }],
        labels: ["bug"],
        draft: false,
        work_in_progress: false,
        merge_when_pipeline_succeeds: false,
        merge_status: "can_be_merged",
        detailed_merge_status: "mergeable",
        sha: HEAD,
        merge_commit_sha: null,
        has_conflicts: false,
        blocking_discussions_resolved: true,
        user_notes_count: 2,
        web_url: `${HOST}/${path}/-/merge_requests/42`,
        head_pipeline: {
            id: 301,
            iid: 12,
            project_id: 7,
            sha: HEAD,
            ref: "feature/one",
            status: "failed",
            source: "merge_request_event",
            web_url: `${HOST}/${path}/-/pipelines/301`,
        },
        ...overrides,
    };
}

/** A job of a pipeline, as `GET projects/:id/pipelines/:id/jobs` gives it. */
export function job(name: string, status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 5000 + name.length,
        name,
        stage: "test",
        status,
        allow_failure: false,
        web_url: `${HOST}/acme/orders-api/-/jobs/${5000 + name.length}`,
        ...overrides,
    };
}

export const person = (username: string, overrides: Record<string, unknown> = {}) => ({
    id: 100 + username.length,
    username,
    name: username,
    state: "active",
    ...overrides,
});

/** A note, as the discussions and the notes endpoints give it. */
export function note(
    id: number,
    username: string,
    body: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id,
        type: null,
        body,
        author: person(username),
        created_at: stamp(id),
        updated_at: stamp(id),
        system: false,
        noteable_id: 90042,
        noteable_type: "MergeRequest",
        project_id: 7,
        resolvable: false,
        ...overrides,
    };
}

/** A note on a line of the diff, inside a thread. */
export function diffNote(
    id: number,
    username: string,
    body: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return note(id, username, body, {
        type: "DiffNote",
        resolvable: true,
        resolved: false,
        position: {
            base_sha: "a",
            start_sha: "b",
            head_sha: HEAD,
            position_type: "text",
            old_path: "src/orders.ts",
            new_path: "src/orders.ts",
            old_line: null,
            new_line: 42,
        },
        ...overrides,
    });
}

/** A note inside a general thread (not on a line). */
export const threadNote = (id: number, username: string, body: string, overrides: Record<string, unknown> = {}) =>
    note(id, username, body, { type: "DiscussionNote", resolvable: true, resolved: false, ...overrides });

/** A discussion: a single comment (`individual_note`) or a thread of notes. */
export function discussion(id: string, notes: unknown[], individual = false): Record<string, unknown> {
    return { id, individual_note: individual, notes };
}

/** When a note was made: its id counts seconds from nine o'clock, so the order of the ids is the order in time. */
export const stamp = (id: number): string => new Date(Date.UTC(2026, 9, 31, 9, 0, 0) + id * 1000).toISOString();

/** A discussion id, as GitLab makes them: forty hex digits. */
export const did = (n: number): string => n.toString(16).padStart(40, "0");
