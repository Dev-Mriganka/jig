// The interface every source of saved requests implements: Postman files, a folder of `.http` files, Bruno, OpenAPI and Postman's
// cloud. A source is two functions and a name; nothing else in the plugin knows a file format.
import type { Http } from "../engine/http.ts";
import type { Collection } from "../model.ts";

/** What a refresh needs from the plugin: the sending engine, so a transport or a sign-in service carries the fetch, and the
 *  settings that govern any call. */
export interface RefreshDeps {
    http: Http;
    timeoutSec: number;
    allowPlainLocal: boolean;
    /** For tests: where the service is. */
    serviceUrl?: string | undefined;
}

/** How a refresh went, in lines for the person. A failure is reported here, never thrown. */
export interface RefreshReport {
    lines: string[];
    failed: boolean;
}

/** A collection that is kept as a local copy of something fetched. `/api refresh` fetches it again. */
export interface Refresher {
    run(deps: RefreshDeps, signal?: AbortSignal): Promise<RefreshReport>;
}

export interface Source<Config = unknown> {
    /** The key that picks this source in a collection's configuration, such as `postman` or `http`. */
    readonly kind: string;

    /**
     * Two sources may share a key (Postman files and Postman's cloud both use `postman`). This says which one an entry is for.
     * Without it, a source takes every entry that has its key.
     */
    handles?(entry: Readonly<Record<string, unknown>>): boolean;

    /**
     * Checks a collection's configuration, which is the object under `api.collections.<name>`. The source owns the whole
     * object: its own key (`postman`) and any key that goes with it (`environments`). Every mistake is added to `errors`,
     * worded with the key it is about (`at` is the key of the object). Returns what `load` needs, or undefined when
     * there were mistakes. Must not touch the disk: jig-core runs this when it loads the file.
     */
    check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): Config | undefined;

    /**
     * Reads the collection. It reads local files only and is synchronous, because jig-core asks a tool to classify a call
     * before it runs, and classifying needs the request's method. A source that needs the network fetches to a local copy
     * first, and reads that copy here.
     *
     * It never throws for what is in the files and never runs anything in them. A file it cannot read or understand, a
     * variable in the wrong place, a secret that has a plain value: each is a `Problem` with its file and key, and the
     * rest of the collection loads. A request it cannot send (a script, a protocol, a sign-in) is still listed, with
     * `unsupported` or `scripts` set, and is refused when it is run.
     */
    load(config: Config, name: string): Collection;

    /** Set by a source that fetches: what `/api refresh` runs for this collection. */
    refresher?(config: Config, name: string): Refresher;
}
