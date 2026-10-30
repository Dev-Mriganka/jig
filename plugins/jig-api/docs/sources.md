# Adding a source

A source reads one kind of collection into saved requests. The tool, the variables, the planning and the sending know nothing of a
file format, so a new source is one file in `src/sources/` and a line in `src/sources/index.ts`. The built ones are Postman files
(`postman.ts`), `.http` folders (`http-file.ts`), Bruno (`bruno.ts`, with a reader for each of its two languages), OpenAPI
(`openapi.ts`) and Postman's cloud (`postman-cloud.ts`). Back to the [jig-api overview](../README.md).

## The interface

```ts
export interface Source<Config = unknown> {
    /** The key that picks this source in a collection's configuration, such as `postman` or `http`. */
    readonly kind: string;

    /** Optional. Two sources may share a key (Postman files and Postman's cloud both use `postman`); this says which one an entry is for. */
    handles?(entry: Readonly<Record<string, unknown>>): boolean;

    /** Checks the object under `api.collections.<name>`. The source owns all of it: its own key and any key that goes with it.
     *  Every mistake is added to `errors`, worded with its key. Returns what `load` needs, or undefined. Must not touch the disk. */
    check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): Config | undefined;

    /** Reads the collection. Local files only, and synchronous, because classifying a call needs the request's method before it
     *  runs. Never throws for what is in the files and never runs anything in them: a problem is a `Problem` with its file and
     *  key, and a request that cannot be sent is still listed, with `unsupported` or `scripts` set. */
    load(config: Config, name: string): Collection;

    /** Optional. For a source that keeps a local copy of something fetched: what `/api refresh` runs for the collection. */
    refresher?(config: Config, name: string): Refresher;
}
```

`check` runs when `jig-core` loads the configuration, `load` on every call that needs the collection. A source that needs the
network (Postman's cloud) fetches to a local copy first, through the sending engine so that a company transport carries it, and
`load` reads that copy.

## What `load` returns

| Field | Meaning |
|---|---|
| `requests` | `SavedRequest`s: collection, folder path, name, `method`, `url` and `headers` as templates, a `body` (raw, JSON, form, file or GraphQL), `auth` (none, bearer, basic, apiKey in a header, or OAuth 2.0 with a headless grant), the `variables` it uses, which of them are `secrets` (declared by the environments) or `signsIn`, its own `defaults`, `scripts: { prerequest }`, and `unsupported` and `notes`. Optional: `optional` (variables that may stay unset, see below), `variableDocs` and `assertions` (shown by `show`) |
| `environments` | By name, each with its `variables` (a secret has no value) and the file they came from. Optional `unavailable`: a reason that nothing can run in it |
| `variables` | The collection's own values, the weakest |
| `auth`, `authRefused` | The sign-in of the whole collection, for an ad-hoc `call` that names the collection |
| `productionReads` | Optional. Set by a source that is opt-in per environment (OpenAPI): `false` refuses reads in production, `true` leaves them to the rules. Writes in production are denied by the floor either way |
| `root` | The folder every file reference must stay inside |
| `problems` | `{ file, key, message, level }` for everything found wrong, such as a secret that has a plain value |

A source marks a variable secret from what its format says, refuses a plain value for it (a warning, no value kept), and sets
`unsupported` for a protocol, a method or a sign-in it cannot express, with words that name it. The rest is done for it: scripts
are refused from `scripts.prerequest`, the agent's values are checked against `variables`, `secrets` and `signsIn`, and every
address is checked against the environment's hosts.

## Optional variables

A source that describes parameters (OpenAPI) lists in `optional` the variables that may stay unset. When nobody gives one a value,
`optional.ts` leaves out what hangs on it before any variable is filled: a query pair written `name={{variable}}`, a header whose
whole value is `{{variable}}`, and a JSON property on a line of its own (and an object that is left with none). A source that sets
`optional` writes its templates in that shape.

## Registering it

Add the adapter to `SOURCES` in `src/sources/index.ts`. The configuration reports its mistakes through `check`; no other file lists
the sources. Tests copy a fixture folder with `copyAcme` in `test/support/acme.ts`, which points its example addresses at the fake servers.
