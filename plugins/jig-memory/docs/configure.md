# jig-memory: configure

The `memory` section of `jig.json`, field by field. The table of fields and defaults is in the [README](../README.md#configure).

- **`ticketPattern`:** a key must not touch a letter or digit on either side.
  Without a pattern, only `/ticket KEY` activates a ticket.
- **`folder`:** the default is under `XDG_DATA_HOME` when that is set. An empty
  or relative `XDG_DATA_HOME` is ignored.
- **`recall`:** an object. `enabled` false stops automatic recall and both pull
  paths (`/ticket recall` and the `ticket recall` action); there is no recall at
  all then.
  - **`enabled`:** all recall, true by default.
  - **`max`:** the most entries in one result, 3 by default.
  - **`minScore`:** the score an entry needs, 2 by default.
  - **`notes`:** search derived notes entries in automatic recall only; both pull
    paths always search them. Off by default; see
    [Recall](recall.md#measured-on-our-own-tickets).
  - **`maxNotes`:** the most derived entries in one manual result, 1 by default;
    0 turns them off even with `notes` true. Automatic recall always takes at
    most one, whatever this says.

```json
{
  "memory": {
    "ticketPattern": "[A-Z][A-Z0-9]+-\\d+",
    "folder": "~/work/tickets",
    "recall": { "max": 2, "minScore": 3, "notes": true, "maxNotes": 1 }
  }
}
```
