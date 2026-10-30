# Hit lines, and how they are cut

What a result looks like, how the fetched hits are chosen and paged, and how a
long message is cut to a line. Back to the [jig-logs overview](../README.md).

## A result

Plain text: a header, then what is missing or worth knowing, then one line per
hit, `time message`. This is `order: "desc"`, `size: 3`, `exclude: ["Heartbeat"]`,
`around: "A-1204"` and `chars: 160` on an order id:

```text
production 2026-10-16T09:30:00Z..2026-10-16T10:30:00Z: complete, 412 hits, 3 fetched (newest first), 2 shown, 1 bucket
{…} is a JSON body cut for length, not hidden: rerun with chars: 4000 (or around: "<term>") to see it; in production, personal values are masked and IDs are kept.
2 of 3 fetched hits contain none of 1 exclude term (case-insensitive, fetched hits only). The window holds 412 hits and only 3 were fetched, so more may exist: narrow the window or search for something more exact, and search again.
Hits 1-2 of 2 matching hits, none after these:
2026-10-16T10:28:13.500Z …"quantity":4,"price":19.99},{"sku":"A-1204","quantity":4,"price":19.99},{"sku":"A-1205","quantity":4,"price":19.99}, {…}
2026-10-16T10:27:56.500Z …"quantity":4,"price":19.99},{"sku":"A-1204","quantity":4,"price":19.99},{"sku":"A-1205","quantity":4,"price":19.99}, {…}
```

| Line | When it appears | What it says |
|---|---|---|
| The header | Always | The environment, the window, the [status](windows-and-buckets.md#the-status), how many hits the window holds (`at least 412 hits` is a lower bound), how many were fetched and how many are shown, and how many buckets were searched, with how many were split after a timeout. With no hit fetched it stops after the hit count and the buckets. When no window could be searched it reads `failed, no window could be searched` |
| `Gaps:` and `Next:` | A window was not fully searched | The parts that were not searched, why, and what to change. Neighbouring gaps with the same reason read as one. Up to 5 are listed, then `(+N more)`; there is a `Next:` line for each of up to 3 reasons (see [Failures](failures.md#gaps-and-their-reasons)) |
| `Availability:` | Nothing was found | Whether the window holds any documents at all: `the window holds 8123 documents in this environment without your phrase or query`, `no documents at all in this environment and window`, or `unknown` with the reason. It always adds that this proves nothing about retention |
| The cut notice | A hit on this page shows `{…}` or `[…]` | That a body was cut for length, not hidden (see [Cutting a line](#cutting-a-line)) |
| The filter line | `match` or `exclude` was given | How many of the fetched hits passed, as in the sample. When the window holds more hits than were fetched, it says that more may exist |
| The page line | A filter is given, or the page does not show every fetched hit | Which hits are on the page and which `offset` comes next, such as `Hits 21-40 of 45 fetched hits, 5 more: call again with offset 40:`, or `Hit 25 of 25 matching hits, none after these:` for one hit |

An `offset` past the end gets `offset 99 is past the end: there are only 45
fetched hits (offsets 0 to 44).` and no hit lines. With a filter, the hits are
called `matching` and not `fetched`.

## Choosing and paging hits

`match`, `exclude`, `around`, `chars` and `offset` are applied after the search
and are never sent to it. The same search with another view costs the same.

- **`match` and `exclude` read the whole message,** ignoring case, and not only
  the characters a line keeps, so a term near the end of a long message still
  finds it. They choose among the hits already fetched and do not look at the
  rest of the window. To search a whole window for an identifier, put it in
  `phrase`.
- **Their texts are never repeated** in the result, nor is the text of `around`.
  The filter line counts them (`1 match term`, `2 exclude terms`): a text that
  opens a JSON body would make `jig-core`'s masker replace the line that repeats
  it.
- **`offset` counts among the hits that pass the filters.** A page holds up to
  20 hits, and fewer when `chars` is large, because a page may also hold about
  24 000 characters: each hit counts its characters plus 80 for its time. For
  example, `chars: 2000` gives 11 hits a page and `chars: 4000` gives 5.
- **A call with another `offset` repeats the same search** and shows the next
  hits, so every page asks the backend the same question.

## A line

A line is the hit's time, a space, and its message.
- **The time** is the hit's time field as the backend gives it, cut to 64
  characters. A date field stored as epoch milliseconds is shown as an instant. A
  hit without a time is its message alone.
- **The message** is the message field as one line: control characters, line
  breaks and tabs become one space. A hostile message cannot carry a terminal
  escape sequence, a line break or a separator into a line. A hit that lacks the
  field is an empty line, not an error.
- **A dotted field name** such as `log.message` is found whether the document
  stores the dotted name or nests it.
- **A leading timestamp** is dropped from the message when it is the hit's own
  time, in brackets or bare: the same second and, as far as both give one, the
  same fraction. The line already starts with that time. A timestamp that
  differs is information and stays.

## How long a line is

- **`chars` is 300 by default.** When `chars` is not given and 3 or fewer hits
  are on the page, a line keeps up to 4000: a call that asks for so few wants to
  read them. The count is of the hits on the page, after `match`, `exclude` and
  `offset`.
- **Plain text cut at the limit ends in `…`.**
- **`around` shows a window of `chars` characters** around the first place the
  text occurs, ignoring case, with a quarter of them before it. The text is
  plain text, not a pattern. The window starts and ends with `…` where it cuts,
  and starts at a word when a space or a comma is within 24 characters. A message
  without the text shows its first characters, and a message that fits is shown
  whole.

## Cutting a line

`jig-core` masks production text line by line, and withholds a line whose
structure it cannot read: JSON cut off in the middle of an object, a quoted value
that never closes, a half percent escape. So a cut never leaves such a structure
open.
- **A structure still open at the limit is dropped whole.** It is shown as `{…}`
  for an object, `[…]` for a list, and `…` for a quoted `key="value` that never
  closes. JSON that closes before the limit is kept. JSON that was serialised
  into a string, with escaped quotes, is recognised the same way.
- **A word at the limit is dropped whole** when it starts within 64 characters
  of it, so a phone number or a `key=value` is never half shown. A percent escape
  and a surrogate pair are not split either. A text that is one long word is cut.
- **A window around a term is judged on its own text,** because it starts in the
  middle of a message: a JSON segment in it must close and parse there.
- **The complete message stays in the backend.** Nothing is hidden: `{…}` means
  cut for length. One notice says so before the hits, once however many hits on
  the page are cut. For a list it reads `[…] is a JSON list`. When `chars` is
  already 4000, it no longer offers `chars` and reads `{…} is a JSON body longer
  than 4000 characters, cut for length, not hidden: use around: "<term>" for the
  part you need`.

## What a program reads

The result's `details` carry the counts and the windows, and never a message:
`status`, `total`, `fetched`, `shown`, `matched` (only when `match` or `exclude`
was given), `buckets`, `splits` and `windows`.
