# Cards

A card is a short file that sums up a closed ticket, so a later ticket can find
it. This page covers the file, what the plugin fills in, what the agent writes,
how `/ticket close` runs and what is rejected. Back to the
[jig-memory overview](../README.md).

## The file

`card.md` sits in the ticket's folder. It is front matter, then three sections:

```text
---
ticket: "PROJ-123"
closedAt: "2026-10-31T10:15:00.000Z"
repositories:
  - "orders-api"
keys:
  - "PROJ-98"
identifiers:
  - "OrderService"
  - "NullPointerException"
  - "500 /orders/{id}/cancel"
errors:
  - "NullPointerException: customer is null in OrderMapper.toDto"
---

## Problem
Cancelling an order with no customer returned 500.

## Cause
OrderMapper.toDto read the customer's name without a null check.

## Fix
The mapper returns an empty name when the customer is missing; a test covers it.
```

Cards are written from the notes and evidence, which `jig-core` already masked
where needed. The plugin adds nothing from anywhere else, and neither may the
agent.

## What the plugin fills in

| Field | What it holds |
|---|---|
| `ticket` | The key. It must match the folder |
| `closedAt` | The time of the close, in ISO form |
| `repositories` | The folder names of the paths in `ticket.json`, each once |
| `keys` | Other ticket keys named in the notes and evidence, up to 20 |
| `identifiers` | Names and keys found by the patterns below, up to 30 |
| `errors` | Distinct error lines from the evidence, up to 10, each cut to 160 characters |

- **Keys** use the `ticketPattern` from the `memory` section. Without one, any
  `ABC-123` shape counts. Either way `UTF-8`, `SHA-256`, `RFC-7231` and similar
  are skipped, because two cards that both name `UTF-8` would otherwise share a key.
- **Identifiers** come from the notes first, the most often named first, then
  from names that only the evidence holds.
- **The patterns** are few and tested, as the table says.

| Kind | What matches | Example |
|---|---|---|
| Class or type | `CamelCase` of two parts or more, exception names included | `OrderService`, `NullPointerException` |
| Function | `camelCase`, or `snake_case` followed by `(` | `handlePayment`, `process_payment(` |
| Status and path | A 4xx or 5xx status and a path on one line, within 40 characters | `502 /orders/{id}/cancel` |
| Config key | A dotted lower-case key followed by `=` or `:`, or `UPPER_SNAKE` with two underscores | `spring.datasource.url`, `ORDERS_DB_URL` |

In a path, a segment of digits or a UUID is written `{id}` and a query string is
dropped. Product names such as `GitHub` and file names such as `config.yaml` are
not identifiers. A token that looks like a random string, such as a token or a
hash, is skipped.

An **error line** is a line of evidence that holds one of these:
- an exception or error name, such as `NullPointerException` or `TypeError`;
- `Caused by`, or an upper-case level: `ERROR`, `FATAL`, `SEVERE`, `CRITICAL`, `PANIC`;
- `failed`, `timed out`, `connection refused` or `permission denied`.

A stack frame (`at ...`) is not an error line. A leading timestamp is dropped, and
lines that differ only in numbers, ids or bracketed thread names count as one. The
ten most frequent stay.

## What the agent writes

The body has exactly three sections, `## Problem`, `## Cause` and `## Fix`, each
filled and each at most 400 characters. Nothing else may be in the body. The
agent writes them from the notes, and leaves the front matter alone.

## How a close runs

1. **`/ticket close [KEY]`** picks the ticket: the one named, or the active one.
   Its folder must hold notes that were changed or saved evidence. A ticket that
   is still the empty template has nothing to put on a card.
2. **The plugin drafts `card.md`:** the front matter is filled and each section
   says `(not filled yet)`. A card that exists is replaced.
3. **The plugin sends one message** asking the agent to fill the three sections.
   It goes as a follow-up: the agent that is busy finishes its run first, and an
   idle agent starts at once.
4. **When the agent has settled,** the plugin reads the file back and checks it.
5. **A card that passes** is indexed for recall. If the ticket was the active
   one, it is switched off, as `/ticket off` does.

A card that does not pass gets one correction message that says what to fix. If
the second try fails too, you get a warning with the same list, and the card
stays on disk but recall ignores it. Fix it by hand and it is used from the next
recall on. A run you aborted gets a notice and no correction.

## What the check rejects

- **A section that is missing,** empty or still `(not filled yet)`.
- **A section over 400 characters,** or text outside the three sections.
- **Front matter that is damaged.** When the sections are fine and the front
  matter is not, the plugin writes its drafted front matter back.

## Reopening

`/ticket KEY` makes a closed ticket active again, with its notes and evidence as
they were. Its card stays, and still serves recall, until the next
`/ticket close` replaces it with a fresh draft.
