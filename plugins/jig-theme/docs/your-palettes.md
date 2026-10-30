# Your palettes

How to write a palette of your own, when it is written to disk, and when it is left
alone. Back to the [jig-theme overview](../README.md).

## A palette in jig.json

In `~/.pi/agent/jig.json`, under `theme.palettes`. The key is the palette's name:

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

| Field | Meaning |
|---|---|
| `base` | Required. One of `jig-lime`, `jig-signal`, `jig-ember`, `jig-orchid`, `jig-mono`, `jig-paper`. The palette starts as a copy of it, and is light or dark as it is |
| `vars` | Optional. Replaces named colours of the base (the [seventeen](palettes.md#the-seventeen-colours)). Every role that uses a colour follows it |
| `colors` | Optional. Sets single Pi roles, after the [role map](palettes.md#the-role-map). The base's own hand-set roles are kept unless you set them again |

A colour is any form Pi accepts: `#4FD6BE` or `#4FD`, `oklch(62% 0.1 200)`,
`okhsl(250 60% 55%)`, a 256-colour index (`39`), the name of one of the palette's own
colours (`"accent"`), or `""` for the terminal's own. A colour that names another
colour must not lead back to itself.

## Names

A palette's name is also its file name, so it is held to a few rules:

| Rule | Why |
|---|---|
| Lower-case letters, digits and `-`, starting with a letter or digit, at most 40 characters | It is a file name, and nothing can leave the themes folder through it |
| Not `system`, `dark` or `light` | Pi's own themes |
| Not one of the six, `reload` or `footer` | The six are shipped; `reload` and `footer` are words of `/theme` |
| Not a name another theme has | Checked when the palette is written. A theme from another package or from a project is left alone, and the palette is not written, with a warning that names it |
| At most 20 palettes | The folder is not a place for hundreds |

A palette that breaks a rule is a configuration error: `jig-core` reports it with the
key, for example `theme.palettes.sea.vars.nope: not a palette colour`, and every
`theme` setting stays at its default until it is mended. A message never repeats a
value.

## How a palette becomes a theme

The base's colours, with yours laid over them, go through the same role map as the six.
Then the base's hand-set roles, with yours laid over those. The result is a complete
Pi theme file named after the palette, with the colours as `vars`, so it works in
`/settings`, in Pi's HTML export, and without the rest of Jig.

`jig-lime` and `jig-signal` set some roles by hand (see
[the six](palettes.md#the-six)). A change to one of their `vars` does not reach those
roles; set them in `colors`.

## When it is written

At the start of a session in a terminal, and on `/theme reload`. Not in print or RPC
runs, and not in a child that another session started, so a child never writes the
parent's files a second time.

The file is `<agentDir>/themes/<name>.json`, where `<agentDir>` is `~/.pi/agent`, or
what `PI_CODING_AGENT_DIR` names. It is written beside itself under a temporary name
and moved into place, so Pi, which watches the folder, never reads half a theme. After
writing, `jig-theme` asks Pi to load each palette, and names one that Pi cannot.

## What it will not overwrite

The themes folder is also where you put themes by hand, so `jig-theme` only touches a
file it can prove is its own. `<agentDir>/jig-theme/written.json` records the SHA-256
of every file it wrote. It writes over a file, or deletes it, only when the file is
absent or still has the recorded hash. Otherwise it leaves the file and says so, once
for each start of a session:

| Warning | What happened | What to do |
|---|---|---|
| `themes/<name>.json was changed by hand; jig-theme leaves it` | The file is not what was written | Keep your version and remove the palette from `jig.json`, or delete the file and run `/theme reload` |
| `themes/<name>.json is not one jig-theme wrote; jig-theme leaves it` | A file of that name was there first | Rename the palette, or move the file |
| `themes/<name>.json is not a plain file; jig-theme leaves it` | It is a link, for example into your dotfiles, or a folder | Rename the palette |
| `the theme name "<name>" is taken by another theme; jig-theme does not write it` | Another package or project has a theme of that name | Rename the palette |
| `themes/<name>.json could not be written (EACCES)` | The folder cannot be written to, with the error code | Fix the permissions |
| `jig-theme/written.json cannot be read; ...` | The record is damaged, so no file counts as written by `jig-theme`, and a new record is made | None. Files you had are left as they are |
| `Pi cannot load the theme "<name>"; check its base, vars and colors` | Pi refused the file, for example for a colour it cannot read | Mend the colour in `jig.json` |

A file that holds exactly what would be written is taken as written by `jig-theme`.
A palette you remove from `jig.json` has its file deleted when the file is still as
written. If you changed it, it is left, said once, and is yours from then on.

## When Pi has the old colours

Pi reads the themes folder when it starts and when it reloads, and knows a palette
that changed after that by its old colours until its file changes again.
`jig-theme` makes that happen for the palette you are using, and for one you choose
with `/theme`, by writing its file once more as it is. A change shows at once.

`/settings` is Pi's own, and shows a palette that changed since Pi last loaded it by
its old colours until you run `/reload`. When that applies, a start says which
palettes, in one line.

## `/theme reload`

`jig.json` is read when a session starts, and that is also when palettes are written.
`/theme reload` is therefore a reload of Pi, with a line afterwards that says what was
written and removed. Run it after you change `theme` in `jig.json`.

## If it does not work

| You see | Likely cause |
|---|---|
| The palette is not in `/theme` | `jig-core` found an error in `theme`, so all of it was dropped: look at the start-up report, or run `/jig` |
| The palette is in the list, but its colours are the base's | The colour is in `colors` under a name that is not a role, or in `vars` under a name that is not a palette colour: both are reported as errors |
| A role does not follow a `vars` change | The base sets that role by hand (`jig-lime`, `jig-signal`): set it in `colors` |
| `jig.json` changed and nothing happened | A session has to start, or `/theme reload` run |
| A colour is not what you wrote | The terminal has fewer colours than the theme: Pi approximates for 256 colours. Check `COLORTERM=truecolor` |
