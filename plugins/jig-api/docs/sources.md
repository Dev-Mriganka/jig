# Adding a source

A source reads one kind of collection into saved requests. The tool, the variables, the planning and the sending know nothing of a
file format, so a new source is one file in `src/sources/` and a line in `src/sources/index.ts`. Back to the
[jig-api overview](../README.md).

## The interface

```ts
export interface Source<Config = unknown> {
    /** The key that picks this source in a collection's configuration, such as `postman` or `http`. */
    readonly kind: string;

    /** Checks the object under `api.collections.<name>`. The source owns all of it: its own key and any key that goes with it.
     *  Every mistake is added to `errors`, worded with its key. Returns what `load` needs, or undefined. Must not touch the disk. */
    check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): Config | undefined;

    /** Reads the collection. Local files only, and synchronous, because classifying a call needs the request's method before it
     *  runs. Never throws for what is in the files and never runs anything in them: a problem is a `Problem` with its file and
     *  key, and a request that cannot be sent is still listed, with `unsupported` or `scripts` set. */
    load(config: Config, name: string): Collection;
}
```

`check` runs when `jig-core` loads the configuration, `load` on every call that needs the collection. A source that needs the
network (Postman's cloud) fetches to a local copy first, and `load` reads that copy.

## What `load` returns

| Field | Meaning |
|---|---|
| `requests` | `SavedRequest`s: collection, folder path, name, `method`, `url` and `headers` as templates, a `body` (raw, JSON, form, file or GraphQL), `auth` (none, bearer, basic, apiKey in a header, or OAuth 2.0 with a headless grant), the `variables` it uses, which of them are `secrets` (declared by the environments) or `signsIn`, its own `defaults`, `scripts: { prerequest }`, and `unsupported` and `notes` |
| `environments` | By name, each with its `variables` (a secret has no value) and the file they came from |
| `variables` | The collection's own values, the weakest |
| `auth`, `authRefused` | The sign-in of the whole collection, for an ad-hoc `call` that names the collection |
| `root` | The folder every file reference must stay inside |
| `problems` | `{ file, key, message, level }` for everything found wrong, such as a secret that has a plain value |

A source marks a variable secret from what its format says, refuses a plain value for it (a warning, no value kept), and sets
`unsupported` for a protocol, a method or a sign-in it cannot express, with words that name it. The rest is done for it: scripts
are refused from `scripts.prerequest`, the agent's values are checked against `variables`, `secrets` and `signsIn`, and every
address is checked against the environment's hosts.

## Registering it

Add the adapter to `SOURCES` in `src/sources/index.ts`, and take its name out of `COMING_LATER` there (Bruno and OpenAPI are
listed until they are built, so a configuration that names them gets an error that says so). The configuration reports its
mistakes through `check`; no other file lists the sources.
