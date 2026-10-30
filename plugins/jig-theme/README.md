# jig-theme: palettes, a footer, and your own colours

**Status: built.** Tested with a fake Pi and Pi's own theme validator and resource
loader, and seen in Pi 1.4.0's terminal on Linux (tmux, a temporary agent folder, no
model): the six palettes, a palette written from `jig.json`, the live list, the footer
shrinking with the pane, and answers drawn from a stored session.

Not tried yet: macOS, Windows, a terminal without truecolor, and answers streaming from a
live model.

`jig-theme` changes how Pi looks, and nothing else. It brings:
- **six palettes,** shipped as ordinary Pi themes, so they appear in Pi's
  `/settings` next to `dark` and `light`;
- **your own palettes,** written in `jig.json` as a few colours over one of
  the six;
- **a one-line footer:** model, thinking level, context size, prompt-cache
  time left, cost and tokens. You choose its parts and their order, and other
  plugins can add theirs;
- **answers in the theme's text colour,** so they stand apart from thinking.

```text
Claude Opus 5.5 · high · ctx 182k · cache 3:41 · est. $4.21 · ↑12.4k ↓3.1k
```

![A palette's seventeen named colours go through one role map into a Pi theme with every role filled; your palette in jig.json takes a built-in one as its base, changes a few colours, and is written to Pi's themes folder](../../docs/img/theme-palettes.svg)

*How a palette becomes a theme. Each palette names seventeen colours, and one role map spreads them over all of Pi's roles. Your own palette starts from a built-in one and changes only what you list.*

## Palettes

| Palette | Look |
|---|---|
| `jig-lime` | dark, lime with cyan and pink |
| `jig-signal` | dark, cyan with blue and violet |
| `jig-ember` | dark, amber with coral |
| `jig-orchid` | dark, violet with pink and blue |
| `jig-mono` | dark, greys with one accent, the highest contrast |
| `jig-paper` | light, dark ink on warm white |

Each palette names seventeen colours, such as `text`, `muted`, `accent`, `link`,
`heading`, `warning` and `error`. One role map turns them into all of Pi's roles.

Body text keeps a 7:1 contrast on its backgrounds, and muted text 4.5:1, with one named
exception. The names, the map and the rules are in [Palettes](docs/palettes.md).

## Your own palettes

Write them in `~/.pi/agent/jig.json`, under `theme`. Each one starts from a
built-in palette and changes only what you list:

```json
{
  "theme": {
    "palettes": {
      "sea": {
        "base": "jig-signal",
        "vars": { "accent": "#4FD6BE", "heading": "#C099FF" },
        "colors": { "mdCode": "#FFB454" }
      }
    }
  }
}
```

- `vars` changes the palette's named colours, and every role that uses them.
- `colors` sets single Pi roles, after the map.
- A colour is any form Pi accepts: hex, `oklch()`, `okhsl()`, a 256-colour index, or `""`.

At the start of a session in a terminal, and on `/theme reload`, each palette is written
to `~/.pi/agent/themes/<name>.json`, where Pi finds it. Pi reloads the theme in use
when its file changes, so a change shows at once.

A file it did not write, or that you changed, is never overwritten
([Your palettes](docs/your-palettes.md)).

## The footer

The parts are `model`, `thinking`, `context`, `cache`, `cost` and `tokens`, then `branch` and `cwd`,
`statuses` (what other extensions set with Pi's `setStatus`) and `plugins` (parts other plugins add, below).
- **Off by default:** `branch` and `cwd`.
- **Colours:** `context` is amber from 150k tokens or 70% of the window and red from 250k or 90%; `cache` is amber in
  its last minute, and reads `cache cold` once it has expired.
- **Unknowns:** `ctx ?` right after a compaction, and `est. $?` when a model has no price.

On a narrow terminal the footer drops parts in the `dropFirst` order, and cuts the model's name to what is left, not below 8
cells until nothing else can go. Every part, colour and limit is in [The footer](docs/footer.md).

**Adding a part from another plugin.** Emit on Pi's event bus. Nothing needs to import
`jig-theme`, and nothing breaks without it. `tone` is `normal`, `muted`, `accent`,
`success`, `warning` or `error`, and an empty `label` removes the part:

```ts
pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });
```

## Commands

| Command | What it does |
|---|---|
| `/theme` | Lists every theme Pi has, with a colour swatch each; moving shows it live |
| `/theme <name>` | Switches to that theme and keeps it, as `/settings` does |
| `/theme reload` | Reloads Pi, which reads `jig.json` again and writes your palettes |
| `/theme footer on` / `off` | Shows or hides the Jig footer for this session |

In the list, Enter keeps a theme and Esc puts back the one you had. `/theme reload` says what it wrote.

Anything else shows the usage line, `Usage: /theme [name | reload | footer on|off]`,
and does nothing. Without a terminal, `/theme` and `/theme <name>` say they need one.

## Rules

- **Pi's own themes.** Palettes are theme files in Pi's format. They work in `/settings`, in Pi's HTML export, and without the
  rest of Jig.
- **Only files it wrote.** `jig-theme` writes and deletes only theme files it wrote itself and nobody has changed since.
- **Looks only.** It reads the session and the extension statuses, and writes only theme files. It has no tools, so the model
  never sees it.
- **Never in the way.** No footer in subagent children, without a terminal, or with `JIG_THEME_FOOTER=0`. If a Pi update changes
  what the answer colour depends on, answers keep Pi's default colour.

## Configure

In `~/.pi/agent/jig.json`, under `theme`. Every field is optional. `jig-core`
checks the section at session start; a mistake names the key, and the defaults
apply.

| Field | Default | Meaning |
|---|---|---|
| `palettes` | none | Your palettes, above |
| `footer.enabled` | `true` | `false` keeps Pi's own footer |
| `footer.segments` | `["model", "thinking", "context", "cache", "cost", "tokens", "plugins", "statuses"]` | The parts, in order |
| `footer.dropFirst` | `["tokens", "cache", "branch", "cwd", "plugins"]` | What a narrow terminal gives up first |
| `answerColor` | `"text"` | The Pi role answers are drawn in; `false` leaves Pi's default |

The footer's colours, context limits, cost decimals and separator are in
[The footer](docs/footer.md#configure).

## Company part (in the company plugin)

- a company palette, through `jig-core`'s section defaults;
- footer defaults, such as which parts to show;
- footer parts of its own, such as the month's model spend, through
  `jig-theme:segment`.

## Layout

```text
jig-theme/
  src/      the roles and the 17 colours (roles, palettes), a palette to a theme (build), your palettes on disk
            (config, write, apply), the footer (footer, segments, session, cache, usage, width), answer-text.ts, the /theme command
  themes/   the six as Pi theme files, made by scripts/build-themes.ts
  test/     golden roles, contrast, Pi's validator and loader, the writer, the footer at every width, the command
  docs/     the detail pages below
```

## More detail

- [Palettes](docs/palettes.md): the named colours, the role map, the contrast rules
- [Your palettes](docs/your-palettes.md): fields, names, when files are written and left alone
- [The footer](docs/footer.md): every part, the colours, narrow terminals, parts from other plugins
