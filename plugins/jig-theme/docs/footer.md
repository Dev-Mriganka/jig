# The footer

Every part of the footer, its colour, how it gives way on a narrow terminal, and how
other plugins add parts. Back to the [jig-theme overview](../README.md).

```text
Claude Opus 5.5 · high · ctx 182k · cache 3:41 · est. $4.21 · ↑12.4k ↓3.1k
```

It is one row, drawn in the colours of the theme in use, and it replaces Pi's own
two-line footer.

## The parts

| Part | Shows | Colour | On by default |
|---|---|---|---|
| `model` | The model's name, or its id; `No model` when there is none | `mdHeading` | yes |
| `thinking` | The thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `warning` | yes |
| `context` | The context size in tokens, `ctx 182k`. With only a share known, `ctx 42%`. Right after a compaction, before Pi has measured it, `ctx ?`. Past the window, `ctx 210k OVER` | `toolTitle`, `warning` from the warn limits, `error` from the high limits | yes |
| `cache` | The time left on the model's prompt cache, `cache 3:41`, counting down every second while it is warm. `cache cold` once it has expired, after a model switch, or after a compaction. Hidden when there is nothing to say: no reply yet, or the last reply used no cache | `muted`, `warning` in the last minute | yes |
| `cost` | The session's estimated cost, `est. $4.21`, over every reply, tool result, summary and cache refresh in the session. `est. $?` as soon as one of them had no price | `mdQuoteBorder` | yes |
| `tokens` | Tokens in, with cache writes, and out: `↑12.4k ↓3.1k` | `muted` | yes |
| `branch` | The git branch Pi shows, and nothing outside a repository | `accent` | no |
| `cwd` | The name of the folder Pi runs in, without its path | `muted` | no |
| `statuses` | What other extensions set with Pi's `setStatus`, one part each, in the order of their keys, with escapes removed | `success` | yes |
| `plugins` | Parts other plugins add ([below](#parts-from-other-plugins)) | `text`, or the part's own tone | yes |

The colours are Pi's text roles, so they are the colours of the palette in use:
`mdHeading` is a palette's `heading`, `toolTitle` its `info`, `mdQuoteBorder` its
`link`. The separator is drawn in `muted`.

Context is coloured by the worse of two measures: its size in tokens, which matters on a
very large window where a share never warns although every turn is already costly, and
its share of the window, which still protects a small one.

| Limit | Default | From it the part is drawn in |
|---|---|---|
| `warnTokens` | 150000 | `warning` |
| `highTokens` | 250000 | `error` |
| `warnPercent` | 70 | `warning` |
| `highPercent` | 90 | `error` |

## Narrow terminals

The footer is one row and never wider than the terminal. When the parts do not fit, it
gives parts up in the order of `dropFirst`, a whole part at a time, and the model's name
is cut last:

1. **The model's name is cut** to what is left of the row, with `…`, as long as at
   least 8 cells of it remain. A name that fits whole is never cut, and one shorter than
   8 cells is not cut for another part's sake.
2. **Below 8 cells, the next part in `dropFirst` goes** and the name grows back.
3. **When nothing in `dropFirst` is left** and the row is still too narrow, the name may
   be cut to fewer than 8 cells, and then each remaining part is cut in turn.

A part that is not in `dropFirst` is kept until the last step. With all ten parts, a
model called `Claude Opus 4.6 (US)`, and the default `dropFirst`:

| Width | Footer |
|---|---|
| 80 | `Claude Opus 4.6 (US) · medium · ctx 0 · est. $0.00 · ↑0 ↓0 · feature/demo · work` |
| 60 | `Claude … · medium · ctx 0 · est. $0.00 · feature/demo · work` |
| 48 | `Claude Opu… · medium · ctx 0 · est. $0.00 · work` |
| 36 | `Claud… · medium · ctx 0 · est. $0.00` |
| 24 | `Claude Opus 4.6 (US) · …` |

Width is counted in cells, as the terminal draws them: an accented letter is one, a
wide character or an emoji two, and a combining mark none.

## Turning it off

The footer is not shown, and Pi's own stays:
- with `footer.enabled: false`;
- with `JIG_THEME_FOOTER=0` in the environment;
- in a subagent child, which `PI_SUBAGENT_ID` or `PI_SUBAGENT_CHILD=1` marks;
- without a terminal, in print and RPC runs;
- for the rest of a session after `/theme footer off`. `/theme footer on` shows it
  again, even when `footer.enabled` is `false`, but not where it is never shown.

## Configure

In `~/.pi/agent/jig.json`, under `theme.footer`. Every field is optional. `jig-core`
checks them when a session starts, and a mistake names the key.

```json
{
  "theme": {
    "footer": {
      "segments": ["model", "thinking", "context", "cost", "branch", "plugins"],
      "dropFirst": ["branch", "plugins"],
      "colors": { "model": "accent", "cost": "mdCode" },
      "context": { "warnTokens": 100000, "highTokens": 200000 },
      "costDecimals": 3,
      "separator": " | "
    }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps Pi's own footer |
| `segments` | `["model", "thinking", "context", "cache", "cost", "tokens", "plugins", "statuses"]` | The parts, in order. A part listed once. A name that is not a part is an error. At least one |
| `dropFirst` | `["tokens", "cache", "branch", "cwd", "plugins"]` | What a narrow terminal gives up first, in order. A part you leave out is kept |
| `colors` | the colours above | A part to a Pi text role, for example `{ "model": "accent" }`. A background role is an error |
| `context.warnTokens`, `context.highTokens` | 150000, 250000 | Whole numbers from 1000 to 10000000, the first below the second |
| `context.warnPercent`, `context.highPercent` | 70, 90 | Whole numbers from 1 to 100, the first below the second |
| `costDecimals` | 2 | Decimals of the cost, from 2 to 4 |
| `separator` | `" · "` | Between parts, 1 to 5 cells wide, with no control characters |

The colour of `context` is its normal one; the warn and high colours stay `warning` and
`error`. The colour of `plugins` is what a part of the normal tone takes.

## Parts from other plugins

A plugin adds a part by emitting on Pi's event bus. It imports nothing from
`jig-theme`, and nothing breaks without it: an event nobody listens to does nothing.

```ts
// when the plugin's figure changes
pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });

// when it has nothing to say
pi.events.emit("jig-theme:segment", { id: "spend", label: "" });
```

| Field | Meaning |
|---|---|
| `id` | Required. Up to 40 letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit. One part for each id; a new event for the same id replaces it |
| `label` | The text. An empty or missing label removes the part |
| `tone` | `normal`, `muted`, `accent`, `success`, `warning` or `error`. Anything else is `normal`. A tone is a Pi text role: `normal` takes the colour set for `plugins`, the others `muted`, `accent`, `success`, `warning` and `error` |
| `order` | A number, 0 when missing. Parts are shown by `order`, then by `id` |

The text comes from other code, so it is checked before it is drawn: terminal escapes,
control characters and bidirectional controls are removed, the label is cut to 40 cells,
and an event that is not an object with a string `id` is ignored. At most 12 parts are
kept; the 13th id is ignored until one is removed. An event that changes nothing does
not redraw the footer.

All plugin parts sit together, at the place of `plugins` in `segments`, and go
together when `plugins` is given up on a narrow terminal. A part sent before the session
starts is kept and shown. Parts are not kept across a reload: a plugin sends its parts
again when it starts, as it would at any start.

A company plugin can show, for example, a model spend this way, without `jig-theme` knowing
anything about it.
