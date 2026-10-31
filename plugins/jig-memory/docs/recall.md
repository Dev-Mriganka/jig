# Recall

Recall finds the closed tickets that look like a new one and hands the agent their
cards, so a fix found once is not found again from scratch. This page covers when
it runs, how a card is scored, the threshold, the message, the index and the test
that measures it. Back to the [jig-memory overview](../README.md).

## When it runs

- **At activation.** A ticket becomes active and has no notes yet (its `notes.md`
  is missing or still the template). Recall runs once per ticket per session.
- **By hand.** `/ticket recall` scores the cards against the active ticket.
  `/ticket recall some text` scores them against that text. The result is shown to
  you and not sent to the agent.
- **Not automatically** when `recall.enabled` is false. By hand still works.

## What is known about the new ticket

- **The key,** which matters when an older card names it.
- **The text of the message that activated it,** when a message did.
- **For a run by hand on the active ticket,** its notes and evidence as well.

`jig-jira` does not publish an issue's summary or description on Pi's event bus,
so recall does not use them. `/ticket KEY` has no message, so it recalls by the key
alone.

## How a card is scored

Shared keys come first, then keyword search. The two add up to one score.

| Signal | Points |
|---|---|
| A shared ticket key, including the card's own ticket | 6 each, up to 3 |
| A shared error line | 5 times its rarity, up to 2 |
| A shared identifier | 3 times its rarity, up to 4 |
| Shared words, by BM25 | 0.5 per rare word, up to 5 in all |

- **Rarity** runs from 1 for something only one card holds down to near 0 for
  something almost every card holds. A name shared by many cards says little.
- **Error lines** are compared after the numbers, ids and timestamps are replaced,
  so the same failure on two different orders is one error line.
- **BM25** is a small keyword score written for this plugin, with no dependency.
  Its word list is lower case, without common words, and without endings such as
  `-s`, `-ed` and `-ing`; a `CamelCase` name counts whole and in its parts. Each
  word's weight is scaled so one that only one card uses is worth 1.
- **The text a card is searched by** is its three sections and its repositories.

## The threshold

A card needs `memory.recall.minScore` points, **2.5** unless you change it. The
number follows from the table above:

- One rare shared identifier, error line or key passes alone.
- A name shared by most cards does not: it is worth less than half a point.
- Words alone need about five rare ones, since they are the weakest signal.

Raise it if recall brings cards that do not help; lower it if it stays silent when
a card would have. The cards that pass are cut to `memory.recall.max`, 3 unless set.

## The message

One custom message, never the system prompt, so the cache stays valid. It is
appended without starting a turn. For each card it gives the ticket, why it
matched and its Cause and Fix lines:

```text
[recall PROJ-130] 2 earlier tickets may relate. Cards: <folder>/<KEY>/card.md.
They are hints: check them against this ticket before relying on them.

PROJ-88: shares OrderService, NullPointerException
  Cause: OrderMapper.toDto read the customer's name without a null check.
  Fix: The mapper returns an empty name when the customer is missing.
```

When no card passes, no message is sent. `/ticket recall` says so in words.

## The index

`.cards.json` in the folder of all tickets holds, for every card, its keys,
identifiers, error lines (as compared), term counts, and its Cause and Fix lines.
Recall reads that one file and not the cards.

- **Rebuilt by itself** when it is missing or unreadable, or when a card's size or
  modification time differs from the index. Only those cards are read again.
- **A card that fails the check** is left out, and its stamp is kept so it is not
  read again until it changes.
- **A copy,** like the lens index: delete it and the next recall makes it again.

A test builds 1,000 generated cards and recalls over them.

## The recall test

`test/recall-eval/` holds invented cards and queries with the cards each should
find. It is the measurement that decides whether keys and keywords are enough,
before embeddings are considered.

- **The cards** are fictional and generic: an orders service, a payments worker, a
  reporting job, flaky CI, a timeout, a null value in a mapper, a wrong time zone,
  a migration, and others.
- **The queries** are written like the text of a new ticket. Some share a name with
  their card, some only share the idea, and some have no card to find.
- **The test** computes recall at 3 and precision with the default settings, prints
  them, and fails when either drops below a floor.

Invented tickets cannot say how recall does on real ones. The floor guards the
scoring against a change that makes it worse; it is not a claim about real tickets.
