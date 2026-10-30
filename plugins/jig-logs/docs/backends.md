# Backends: what an adapter does

`jig-logs` searches one kind of log store at a time, named by `logs.backend.type`.
Everything that differs between stores is behind one interface, `LogBackend` in
`src/backends/backend.ts`, and each store has one file in `src/backends/`.

This page says what an adapter must do, so that a contributor can add one. Back to
the [jig-logs overview](../README.md).

## The built backends

| `type` | Store | Files | `query` is written in |
|---|---|---|---|
| `elasticsearch` (the default) | Elasticsearch and OpenSearch | `elasticsearch.ts` | Lucene (see [Query grammar](query-grammar.md)) |
| `loki` | Grafana Loki | `loki.ts`, `logql.ts` | LogQL (see [Loki](loki.md)) |

`phrase`, `match` and `exclude` are portable.
- **`phrase`:** an adapter turns it into the store's own filter.
- **`match` and `exclude`** are applied to the hits fetched, and an adapter that
  can may send them to the store too (Loki does).
- **`query`** is in the language of the store, which the model learns from the logs
  skill and from the `Next:` line of a rejected query.

Stores differ in what they can promise, and the result says so: Elasticsearch
counts exactly, and Loki cannot count, so its totals are lower bounds ("at least").

## What is shared, and what an adapter owns

The search does not know which store it talks to. It decides what to ask next; the
adapter says how to ask, and how to read the answer.

**Shared, the same for every backend:**
- the checks on a call, windows, buckets, halving and retrying, the budgets;
- paging, excerpts around a term, clipping, hit lines;
- the sender: where the credential comes from, timeouts, the size of a reply, and
  what each failure means (`jig-core` sends the request and reads the secret);
- the words of a failure, and the facts a call records.

**The adapter's:**
- the settings an environment needs, and their checks;
- the request for one bucket, and the check for data;
- how a request travels: method, path, body, headers;
- reading a reply into hits, and what an error reply means;
- the limits of the store.

## What an adapter must do

An adapter is an object of the type `LogBackend`. Its members, in the order a call
uses them:

- **`type`** is the value of `logs.backend.type` that selects it, and the key it is
  listed under in `src/backends/index.ts`.
- **`config`** names the fields it adds to `logs.backend` and to each environment,
  says what an environment needs at least (`"an index"`), and gives an example
  address for the messages.
- **`checkBackendFields`, `checkEnvironmentFields`** report every problem in its
  own fields, one message each, each starting with the key
  (`logs.environments.staging.index must be ...`). They never repeat a value that
  may be a secret.
- **`environment`** fills in the defaults and returns the environment as the search
  reads it. `jigEnvironment` defaults to the environment's name. Add no key the
  settings did not need.
- **`limits`** says the most hits one request returns and the longest time span one
  request may cover (`Number.POSITIVE_INFINITY` for none). Buckets are cut to the
  span. The hit limit is never below the tool's `size` limit, 200: a test fails if
  it is.
- **`checkQuery`** is needed only when the language of `query` can reach beyond what
  configuration allows (Loki's can name another stream selector).
  - It throws an `InputError`, a `TypeError`. It is called when the call is
    classified, so `jig-core` blocks the call without asking, and when the request
    is built.
  - Omit it when the text can only ever be a value in the request.
- **`search`** builds the request for one bucket: the time range from `from` up to,
  not including, `to`; the environment's own scope; the phrase or the query; up to
  `size` hits in the call's order. With `size` 0 it only counts; a store that cannot
  count asks for one hit.
- **`probe`** builds the check for data: the time range and the environment's scope,
  and nothing the model wrote.
- **`wire`** says how a request of one environment travels: `GET` or `POST`, a path
  that starts with `/` (and may end in a query string), an optional JSON body,
  optional headers. The sender adds `backend.url` and the sign-in, so no address or
  credential belongs in it.
- **`parse`** reads the body of a successful reply into a page.
  - It gives how many hits there are, and whether that count is exact or a lower
    bound (`gte`; a store that cannot count says `gte` whenever the request filled
    its limit).
  - It gives the hits with their time, message and other fields, and `incomplete`
    when the store says it lost data.
  - It returns `undefined` for anything that is not a result, even when only one
    part of it is wrong, so that no hit is dropped quietly. It never throws.
- **`classify`** says what an error reply means in the store's words, as a `Failure`
  (see below). Return `undefined` to leave it to the HTTP rules, which cover
  sign-in, redirects, timeouts, busy and rejected.
- **`words`** names the store in four messages: what a refused sign-in lacked access
  to, which settings to check after a 401, the `Next:` line for a rejected query,
  and the line for an HTTP 404.

A `Failure` says why a request gave no usable answer:
- **`transient(reason)`** is for a bucket that a smaller request may get past (it
  is halved and tried again).
- **`final(reason, fatal)`** is for one that halving does not help. `fatal` means
  every other window would fail the same way.

The reasons are in [Failures](failures.md#gaps-and-their-reasons); an adapter picks
the closest one and does not invent a message.

## Rules an adapter keeps

- **The model's text lands in one value of the request,** such as a phrase in a
  query clause, and never becomes a key, a field name or another clause.
- **No secret and no reply in a message.** A message names what failed (a
  status, a reason) and never repeats a header, a body, an address or the reply:
  a rejected query's text repeats the query.
- **Configuration is where scope comes from.** An index, a selector or a filter
  is written by the person who configures, never by the model.
- **No import from `jig-core`, and none from another adapter or from the search.**
  An adapter sees the shared types and helpers. A test checks this.
- **Erasable TypeScript only,** as in the rest of the plugin.

## Checklist for a new adapter

1. Write down what you rely on: the request, the reply, the errors and the limits
   of the store, each with the address of the page that states it, in
   [Not verified yet](not-verified.md). What you could not source is listed there
   as unverified.
2. Add the type to `BackendType` in `src/config.ts`, and the shape of its
   environments next to `Target`, which is a union told apart by `type` (an
   Elasticsearch environment has none). The fields of the other kinds are
   `undefined` on it, so that `index` or `selector` can be read on any target.
3. Write `src/backends/<name>.ts` and list it in `src/backends/index.ts`; an
   environment finds its backend by its `type`. Helpers for the store's language
   go in a file of their own in the folder, as `logql.ts` does. `elasticsearch.ts`
   and `loki.ts` are the two examples to read.
4. Test configuration: every field valid and invalid, a field of another type
   reported by name, the defaults.
5. Test requests with golden files in `test/golden/`: a phrase, a query, a bucket
   that only counts, the check for data. Test that hostile text stays in one value.
6. Test replies from fixtures: a result, no result, several parts, a lower-bound
   count, and replies that are not results.
7. Test errors, one mapping each, and that no message repeats the reply.
8. Run the whole tool against a fake of the store on 127.0.0.1: buckets, halving,
   paging, every way of signing in and the transport.
9. `test/backend.test.ts` checks every listed adapter against the interface; it
   needs the least a `jig.json` can say for your type, listed in that file.
10. Document it: a row in the README's Backends table, the language of `query` in
    the logs skill, and a page of its own if it has more to say.
