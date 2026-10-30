// What this plugin remembers of the deploys and rollbacks it ran, for `deploy status`. It is kept in memory, for the length of
// the session: the cluster is the truth, and `status` always reads it. The record only says what was done from here, and how it
// ended as far as this plugin could tell. Every call is also in jig-core's records.

/** How a deploy ended, as far as this plugin could tell. `unknown` is a command that was cut short, and was not run again. */
export type RecordedOutcome = "started" | "failed" | "unknown";

export interface DeployRecord {
    action: "run" | "rollback";
    method: string;
    /** The versions that ran before, as a person reads them. */
    from: string;
    /** The version asked for, or where a rollback went back to, as a person reads it. */
    to: string;
    /** The version the pods should run, when it is known. */
    version: string | undefined;
    /** When it was run, by the clock of the tool. */
    at: number;
    outcome: RecordedOutcome;
}

export interface Records {
    remember(service: string, environment: string, record: DeployRecord): void;
    /** The last one for this service in this environment, or undefined when none was run from here. */
    last(service: string, environment: string): DeployRecord | undefined;
}

export function createRecords(): Records {
    // A Map keyed by the pair, so that no name can be anything but a name.
    const kept = new Map<string, DeployRecord>();
    const key = (service: string, environment: string) => JSON.stringify([service, environment]);
    return {
        remember: (service, environment, record) => void kept.set(key(service, environment), record),
        last: (service, environment) => kept.get(key(service, environment)),
    };
}
