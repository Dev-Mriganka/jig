# From the records to the index

How `jig-lens` gets `jig-core`'s records into its index, and what it does when
something is wrong. Back to the [jig-lens overview](../README.md), which has the
picture.

In text, the same picture:

```text
 jig-core ── appends ──▶ records/<day>.jsonl     owned by jig-core: the source
                               │
                               │ jig-lens imports new lines
                               ▼
                         lens/index.sqlite        owned by jig-lens: a copy it can rebuild
                               │
                               ├─ read-only SQL ──▶ /lens summary in Pi
                               │
                               │ read-only SQL
                               ▼
                         Grafana on 127.0.0.1     dashboards kept as files in this plugin (optional)
                               │
                               ▼
                         your browser
```

- **The record files stay the source.** Appending a line is the cheapest write
  that cannot break a tool call, and it keeps `jig-core` free of a database.
  `jig-lens` only opens them for reading.
- **The index is a copy for querying.** Delete it and `/lens rebuild` makes it
  again, so its tables can change without migrations.
- **Imports are incremental and safe to repeat.** `jig-lens` remembers how far
  it has read each file and inserts by record id, so two sessions importing at
  once, or a rebuild, cannot count anything twice.
  - Only complete lines are imported; a line still being written waits for the
    next import.
  - A file is one transaction, and it moves the file's offset too.
- **A line that is not a record is skipped,** counted, and shown by `/lens
  status`. It never stops the import. A record file that cannot be read is
  reported and the others are still imported.
- **Imports run** at the end of each agent run in any session that loads
  `jig-lens`, and when you run `/lens`. One that fails is said once, in the
  session.
- **Rows older than the records' retention** are removed at import. The index
  keeps 90 days, the default of `records.retentionDays`, by the rule `jig-core`
  deletes files by: a day's rows go when the day is more than 90 days before
  today. A plugin cannot read `jig-core`'s setting, so a value changed there does
  not change this one.
- **A viewer is one process for every session.** It is started detached, so it
  keeps running when Pi exits and another session finds it already there. Jig
  does not stop it; `/lens grafana` prints its process number when it starts it.
  Grafana and Datasette share the one port, so only one runs at a time.
