// The watch kind `ops-ci`: waits in the background until a CI run ends, whatever the CI system. jig-core's watch engine calls
// `poll` on a timer, saves the state it returns, and sends the result to the agent once. Each spec says which system it is
// for, and the adapter of that system polls it. This kind was jig-git's `github`; the GitHub rules moved with it, and
// GitLab and Jenkins have probes of their own.
//
// The spec holds the name of a service and what to follow, never an address, a project or a job: each poll finds those in
// the catalog as it is now, so a watch always reads where the catalog says, and a saved watch file cannot point it elsewhere.
import { jig } from "../../../jig-core/src/client.ts";
import type { JigApi, PollOutcome, WatchKind } from "../../../jig-core/src/contract.ts";
import { catalogOf, findCiService, notSetUp } from "../catalog.ts";
import { SYSTEMS } from "./adapters.ts";
import type { CiContext } from "./adapter.ts";
import type { Announce } from "./artifacts.ts";
import type { GithubState } from "./github-checks.ts";
import { describeSpec as describeGithub } from "./github-watch.ts";
import type { GithubSpec } from "./github-watch.ts";
import { describeGitlab } from "./gitlab-watch.ts";
import type { GitlabSpec, PlainState } from "./gitlab-watch.ts";
import { describeJenkins } from "./jenkins-watch.ts";
import type { JenkinsSpec } from "./jenkins-watch.ts";

export const CI_KIND = "ops-ci";

/** What a CI watch watches. Plain JSON, because it is saved with the watch. */
export type CiSpec = GithubSpec | GitlabSpec | JenkinsSpec;
/** What the watch remembers between polls. Plain JSON. */
export type CiState = GithubState | PlainState;

/** The parts of the watch a test replaces. */
export interface CiWatchOptions {
    /** The clock. Default: the real one. */
    now?: () => number;
    /** The network, for GitLab and Jenkins. Default: the global `fetch`. */
    fetch?: typeof fetch;
    /** How long one request may take. Default: thirty seconds. */
    timeoutMs?: number;
}

export function describeSpec(spec: CiSpec): string {
    switch (spec.system) {
        case "github-actions":
            return describeGithub(spec);
        case "gitlab":
            return describeGitlab(spec);
        case "jenkins":
            return describeJenkins(spec);
    }
}

/** What an adapter is given: the settings and the clock, as the catalog and the options say they are now. */
export function contextFor(signal: AbortSignal | undefined, announce: Announce, options: CiWatchOptions): CiContext {
    const catalog = catalogOf(jig().config.section("ops"));
    if (catalog === undefined) throw notSetUp();
    return {
        signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        now: options.now ?? Date.now,
        announce,
        pollSeconds: catalog.watch.pollSeconds,
        artifacts: catalog.artifacts,
    };
}

async function pollCi(
    spec: CiSpec,
    previous: CiState | undefined,
    signal: AbortSignal,
    announce: Announce,
    options: CiWatchOptions,
): Promise<PollOutcome<CiState>> {
    const catalog = catalogOf(jig().config.section("ops"));
    if (catalog === undefined) throw notSetUp();
    const service = findCiService(catalog, "ci watch", spec.service);
    if (service.ci.system !== spec.system) {
        throw new Error(
            `${spec.service} now uses ${service.ci.system} for CI, so this ${spec.system} watch cannot go on`,
        );
    }
    const adapter = SYSTEMS[spec.system].create(service, contextFor(signal, announce, options));
    return adapter.poll(spec, previous);
}

/** Registers the watch kind with jig-core. `announce` publishes the "artifact ready" event on Pi's event bus. */
export function registerCiWatch(api: JigApi, announce: Announce, options: CiWatchOptions = {}): void {
    const kind: WatchKind<CiSpec, CiState> = {
        kind: CI_KIND,
        plugin: "jig-ops",
        // A run takes minutes, and a poll is a few small reads. Each system also says how long to wait at least.
        intervalMs: 30_000,
        describe: describeSpec,
        poll: (spec, state, signal) => pollCi(spec, state, signal, announce, options),
    };
    api.watches.registerKind(kind);
}
