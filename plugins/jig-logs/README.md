# jig-logs: searching logs

**Status: built.** Tested against a fake search server on this machine and a fake
transport. Not tried against a real OpenSearch or Elasticsearch yet (see
[Not verified yet](docs/not-verified.md)).

`jig-logs` gives the agent one tool, `logs`, that searches the logs of an
OpenSearch or Elasticsearch index over a time window. It only reads, and
`jig-core` governs every call and masks production results. For example, `logs`
with the phrase `req-7f3a9c` in `staging` searches the last 2 hours and returns
how many hits the window holds, then one line per hit.

## Tool: `logs`

Every call is a read. The tool has no aggregations, dashboards or saved
searches, and does not follow a log as it grows. The first six rows decide what
is searched. `match`, `exclude`, `around`, `chars` and `offset` only choose and
shape the hits already fetched, so they never change the search.

| Parameter | Kind | What it does |
|---|---|---|
| `phrase` or `query` | one of the two | `phrase`: an exact phrase in the message, such as a trace id, an account id or an error text (1 to 512 characters). `query`: a Lucene query over the message, with `AND`, `OR`, `NOT`, wildcards and quotes (1 to 2000 characters) |
| `environment` | required | Where to search: one of the environments in the configuration. A name nobody configured is refused, and the message lists the ones that exist |
| `window` | optional | A relative window that ends now: `30m`, `2h` or `1d`, at most `7d`. Default `2h`. Not together with `from` and `to` |
| `from`, `to` | optional, together | Exact times: ISO 8601 with a timezone, `to` exclusive, at most 7 days apart |
| `size` | optional | How many hits to fetch, 1 to 200. Default 50 |
| `order` | optional | `asc` (default) fetches the oldest hits of the window, `desc` the newest |
| `match`, `exclude` | optional | 1 to 5 plain texts of 1 to 200 characters, not patterns. A hit is shown only if its message contains all of `match` and none of `exclude`, ignoring case |
| `around` | optional | One plain text. Each hit is shown as a window around the first place the text occurs in it, instead of its first characters |
| `chars` | optional | How many characters a hit keeps, 40 to 4000. Default 300, or 4000 when 3 or fewer hits are shown. With `around`, the size of the window |
| `offset` | optional | Which hit to start from among the fetched ones that pass `match` and `exclude`. Default 0. A page holds up to 20 hits, fewer when `chars` is large |

The result is plain text: a header with the status and the counts, what is
missing, then one line per hit. A wrong call is refused before anything is sent,
with one line that shows the right form, such as `logs does not use limit.
Usage: logs {phrase or query, environment, window?, ...}`.

## Rules

- **It only reads.** A search is a read in the `jig-core` environment that the
  searched environment's `jigEnvironment` names. A production search is allowed,
  and `jig-core` masks the result. This plugin masks nothing itself, and a name
  that `jig-core` does not know counts as production.
- **What the model writes is a value and nothing else.** Every request body is
  built in one place, from a short list of parts, and the text of a call is only
  ever the phrase or the query string.
- **No credential in anything the model reads.** A secret is resolved when a
  request is made and stays in that call. An error names what failed (a status,
  an error code) and never repeats a header, a body, an address or the reply.
- **A bad environment is invalid input.** `jig-core` classifies the call before
  it runs; an environment nobody configured gives a `TypeError` that lists the
  ones that exist, and nobody is asked.
- **A result says what it covers.** A call makes a limited number of requests in
  a limited time. A part of the window it could not search is a gap, named with
  its reason, and the total is then "at least".
- **Cut is not hidden.** A hit line is cut so that no JSON body or quoted value
  is left open. `{…}` means a body cut for length, not hidden.
- **Facts.** After a search, the call's record carries `status`, `hits`,
  `atLeast`, `fetched` and `requests`.

## Configure

In `~/.pi/agent/jig.json`, under `logs`. `backend` and `environments` are both
needed. `jig-core` reports an unknown or invalid field, and the tool then says it
is not configured instead of running half set up.

| Field | Default | Meaning |
|---|---|---|
| `backend` | required | Exactly one of two shapes: `{ "url", "auth" }` for a direct request, or `{ "transport", "url" }` for one through a company transport. `url` is where the backend is, without the index. A direct `url` must be `https://`; a transport's may be `http://` or `https://`. It may hold a path, and must not hold a user name, a password, a query string or a fragment |
| `backend.auth` | required with a direct `url` | One of four kinds (see [Backends](docs/backends.md)): a user name with a password, an `apiKey`, a `token`, or a `signIn` service. A password, key or token is always a secret reference, such as `pass:logs/api-key` or `env:LOGS_KEY` (see [Secrets](../../docs/secrets.md)), never the secret |
| `environments` | required | A map from the name the tool uses to that environment's settings, at least one |
| `environments.<name>.index` | required | The index name or pattern, such as `app-logs-*`. Several can be listed with commas |
| `environments.<name>.timeField` | `@timestamp` | The date field that windows and sorting use |
| `environments.<name>.messageField` | `message` | The text field that `phrase` and `query` search and that hits show. A dotted name such as `log.message` works whether the documents nest it or not |
| `environments.<name>.filter` | none | Fields that must equal a value, for an index that holds several environments, such as `{ "env.keyword": "production" }`. Every entry is an exact `term`, so name a keyword field. At most 8 entries |
| `environments.<name>.jigEnvironment` | the name itself | The `jig-core` environment this search is classified in, which decides masking and rules |

```json
{
  "logs": {
    "backend": { "url": "https://logs.example.com:9200", "auth": { "apiKey": "pass:logs/api-key" } },
    "environments": {
      "staging": { "index": "app-logs-*", "filter": { "env.keyword": "staging" } },
      "production": { "index": "app-logs-*", "filter": { "env.keyword": "production" } }
    }
  }
}
```

## Company part (in the company plugin)

- the backend's address and the indexes, as `backend.url` and
  `environments.<name>.index`;
- how environments map to the log's own environment names, as `filter`, and to
  `jig-core` environments, as `jigEnvironment`;
- the sign-in: a company sign-in service (for example a single sign-on gateway)
  or a company transport, registered with `jig-core`.

## Later

- **Other backends,** such as SQL or the query languages of other products, and
  requests signed with AWS credentials, written when a job needs them and not in
  advance.

## Layout

```text
jig-logs/
  src/      the tool and its checks (index, tool, params, config), the search (search, time, query, request, response,
            failure), what the model reads (summary, line, clip), small helpers (values)
  skills/   logs/SKILL.md: how to search (an identifier first, a narrow window, then wider)
  test/     against a fake search server, a fake transport and a fake jig-core; golden request bodies in test/golden
  docs/     the detail pages below
```

## More detail

- [Query grammar](docs/query-grammar.md): what a search sends
- [Windows and buckets](docs/windows-and-buckets.md): windows, halving, budgets
- [Hit lines](docs/hit-lines.md): the result, paging, how a line is cut
- [Failures](docs/failures.md): refusals, errors, and the reasons behind a gap
- [Backends](docs/backends.md): direct or through a transport, sign-in, time
- [Not verified yet](docs/not-verified.md): what needs a real backend
