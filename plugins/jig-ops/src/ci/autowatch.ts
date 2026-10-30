// The watch that starts by itself. jig-git announces a push and a new pull request on Pi's event bus as
// `jig-git:pushed` ({ repo, branch, sha, pr? }), and this listens: when a service of the catalog has that repository
// and a CI entry, the CI run of the pushed commit is watched, so nobody has to ask "is it done?". A newer push to the
// same branch replaces the watch of the older commit: its result would only be about a commit that is no longer the
// head.
//
// jig-git cannot import this plugin, and this plugin never reads jig-git's files: the event is the whole contract. What
// arrives on the bus is untrusted input, so the payload is checked before anything is done with it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jig } from "../../../jig-core/src/client.ts";
import { catalogOf, ciServicesOfRepo } from "../catalog.ts";
import type { CiService } from "../catalog.ts";
import type { Catalog } from "../catalog.ts";
import { titleOf as githubTitle } from "./github-actions.ts";
import { titleOf as gitlabTitle } from "./gitlab-watch.ts";
import { titleOf as jenkinsTitle } from "./jenkins-watch.ts";
import { CI_KIND } from "./watch.ts";
import type { CiSpec } from "./watch.ts";

export const PUSHED_EVENT = "jig-git:pushed";

/** What jig-git announces after a push has landed and after a pull request was opened. */
export interface Pushed {
    /** `owner/name` on GitHub, as origin names it. */
    repo: string;
    branch: string;
    /** The full id of the pushed head. */
    sha: string;
    /** The pull request, when there is one. */
    pr?: number;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The payload as a `Pushed`, or undefined when it is not one. Anything on the bus can be published by anyone. */
export function parsePushed(payload: unknown): Pushed | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const { repo, branch, sha, pr } = payload as Record<string, unknown>;
    if (typeof repo !== "string" || !REPO.test(repo)) return undefined;
    if (typeof branch !== "string" || !BRANCH.test(branch)) return undefined;
    if (typeof sha !== "string" || !SHA.test(sha)) return undefined;
    if (pr !== undefined && (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1)) return undefined;
    return { repo, branch, sha, ...(pr === undefined ? {} : { pr }) };
}

/** What to watch for a push, in the terms of the service's CI system, and how to say it. */
function watchFor(service: CiService, pushed: Pushed, now: number): { spec: CiSpec; title: string } {
    const { ci } = service;
    switch (ci.system) {
        case "github-actions": {
            const spec: CiSpec = {
                system: "github-actions",
                service: service.name,
                ...(pushed.pr === undefined ? {} : { pr: pushed.pr }),
                branch: pushed.branch,
                sha: pushed.sha,
                finish: { kind: "required" },
            };
            return { spec, title: githubTitle(spec, pushed.repo) };
        }
        case "gitlab": {
            const spec: CiSpec = {
                system: "gitlab",
                service: service.name,
                ref: pushed.branch,
                sha: pushed.sha,
                finish: ci.required.length > 0 ? { kind: "jobs", names: [...ci.required] } : { kind: "pipeline" },
                since: now,
            };
            return { spec, title: gitlabTitle(spec) };
        }
        case "jenkins": {
            const spec: CiSpec = {
                system: "jenkins",
                service: service.name,
                sha: pushed.sha,
                finish: ci.required.length > 0 ? { kind: "stages", names: [...ci.required] } : { kind: "build" },
                since: now,
            };
            return { spec, title: jenkinsTitle(spec) };
        }
    }
}

export interface AutoWatch {
    /** The watch that started by itself for each branch of each service, by `service#branch`. */
    started: Map<string, string>;
    /** Handles one payload from the bus. Returns the titles of the watches it started. */
    handle(payload: unknown): string[];
}

export function createAutoWatch(now: () => number = Date.now): AutoWatch {
    const started = new Map<string, string>();

    function start(catalog: Catalog, service: CiService, pushed: Pushed): string | undefined {
        const { spec, title } = watchFor(service, pushed, now());
        const key = `${service.name}#${pushed.branch}`;
        const earlier = started.get(key);
        const watches = jig().watches;
        if (earlier !== undefined && watches.list().some((watch) => watch.id === earlier && watch.status !== "done")) {
            watches.stop(earlier);
        }
        const id = watches.start({
            kind: CI_KIND,
            spec,
            title,
            timeoutMinutes: catalog.watch.timeoutMinutes,
            stallMinutes: catalog.watch.stallMinutes,
        });
        started.set(key, id);
        return title;
    }

    return {
        started,
        handle(payload) {
            const pushed = parsePushed(payload);
            if (pushed === undefined) return [];
            const catalog = catalogOf(jig().config.section("ops"));
            if (catalog === undefined || !catalog.watch.auto) return [];
            return ciServicesOfRepo(catalog, pushed.repo).flatMap((service) => start(catalog, service, pushed) ?? []);
        },
    };
}

/** Listens for pushes on Pi's event bus. A payload or catalog that cannot be used starts nothing and breaks nothing. */
export function listenForPushes(pi: ExtensionAPI, auto: AutoWatch): void {
    pi.events.on(PUSHED_EVENT, (payload: unknown) => {
        try {
            auto.handle(payload);
        } catch {
            // jig-core may not be loaded yet, or may refuse to start a watch outside a session. The push itself is
            // done, and the agent can still start the watch with the ci tool.
        }
    });
}
