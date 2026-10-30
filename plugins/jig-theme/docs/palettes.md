# Palettes

The colours a palette names, the one role map that spreads them over Pi's roles, the
contrast rules, and the six palettes. Back to the
[jig-theme overview](../README.md).

## The seventeen colours

A palette is these seventeen names with a colour each, and nothing more. A colour is
any form Pi's theme format accepts; the six use `#RRGGBB`, so that their contrast can
be measured.

| Colour | What it is for |
|---|---|
| `bg` | the page, and the boxes tool calls are drawn in |
| `panel` | your messages and the cards of an HTML export |
| `selected` | the selected item of a list, and a search match |
| `errorBg` | the box of a tool call that failed |
| `text` | answers, and the brightest text |
| `soft` | your messages, code blocks, tool output and variables in code |
| `muted` | secondary text: link addresses, diff context, punctuation, quotes, thinking |
| `dim` | the faintest text: comments in code |
| `border` | borders, code block fences and rules |
| `borderMuted` | the quietest borders, and the scrollbar track |
| `accent` | the main colour: selection, list bullets, the label of a message |
| `link` | links, types in code, the quote bar, low thinking |
| `heading` | headings, keywords in code, high thinking |
| `info` | tool titles, function names, minimal thinking |
| `success` | success, added lines, strings in code, medium thinking |
| `warning` | warnings, inline code, numbers in code, high thinking, bash mode |
| `error` | errors, removed lines, the highest thinking level |

The names are the keys of `vars` in a theme file, and of `vars` in
[your own palette](your-palettes.md).

## The role map

Pi's theme format has 56 roles. One map says which of the seventeen colours each role
takes, so that a new palette is seventeen choices and not 56. Each theme file keeps the
colours as `vars` and has every role point at one of them by name, so a theme you read
says which colour it uses.

| Area | Role | Colour |
|---|---|---|
| General | `accent` | `accent` |
|  | `border` | `border` |
|  | `borderAccent` | `accent` |
|  | `borderMuted` | `borderMuted` |
|  | `success` | `success` |
|  | `error` | `error` |
|  | `warning` | `warning` |
|  | `muted` | `muted` |
|  | `dim` | `dim` |
|  | `text` | `text` |
| Selection and scrolling | `scrollbarTrack` | `borderMuted` |
|  | `scrollbarThumb` | `muted` |
|  | `selectedBg` | `selected` |
|  | `searchMatchBg` | `selected` |
|  | `searchMatchText` | `soft` |
| Messages | `thinkingText` | `muted` |
|  | `userMessageBg` | `panel` |
|  | `userMessageText` | `soft` |
|  | `customMessageBg` | `panel` |
|  | `customMessageText` | `soft` |
|  | `customMessageLabel` | `accent` |
| Tool boxes | `toolPendingBg` | `bg` |
|  | `toolSuccessBg` | `bg` |
|  | `toolErrorBg` | `errorBg` |
|  | `toolTitle` | `info` |
|  | `toolOutput` | `soft` |
| Markdown | `mdHeading` | `heading` |
|  | `mdLink` | `link` |
|  | `mdLinkUrl` | `muted` |
|  | `mdCode` | `warning` |
|  | `mdCodeBlock` | `soft` |
|  | `mdCodeBlockBorder` | `border` |
|  | `mdQuote` | `muted` |
|  | `mdQuoteBorder` | `link` |
|  | `mdHr` | `border` |
|  | `mdListBullet` | `accent` |
| Diffs | `toolDiffAdded` | `success` |
|  | `toolDiffRemoved` | `error` |
|  | `toolDiffContext` | `muted` |
| Code | `syntaxComment` | `dim` |
|  | `syntaxKeyword` | `heading` |
|  | `syntaxFunction` | `info` |
|  | `syntaxVariable` | `soft` |
|  | `syntaxString` | `success` |
|  | `syntaxNumber` | `warning` |
|  | `syntaxType` | `link` |
|  | `syntaxOperator` | `heading` |
|  | `syntaxPunctuation` | `muted` |
| Editor | `thinkingOff` | `border` |
|  | `thinkingMinimal` | `info` |
|  | `thinkingLow` | `link` |
|  | `thinkingMedium` | `success` |
|  | `thinkingHigh` | `warning` |
|  | `thinkingXhigh` | `heading` |
|  | `thinkingMax` | `error` |
|  | `bashMode` | `warning` |

The HTML export takes `pageBg` from `bg`, `cardBg` from the colour of `userMessageBg`
and `infoBg` from the colour of `customMessageBg`, which is what Pi does itself when it
is not told.

A palette can set a single role where the map is not right for it. That is `colors` in
a palette, and it is the same `colors` you write in [your own](your-palettes.md).

## Contrast

Text on a background is measured by the WCAG 2 contrast ratio, from the relative
luminance of the two colours. A test does it for every palette, on every background its
text sits on. A role whose background is `""`, the terminal's own, is measured on `bg`.

| Text | Ratio | Roles |
|---|---|---|
| Body text | 7:1 | `text` and six more (below) |
| Muted text | 4.5:1 | `muted` and six more (below) |
| Words in colour | 4.5:1 | `accent` and seventeen more (below) |

- **Body text:** `text`, `userMessageText`, `customMessageText`, `toolOutput`, `mdCodeBlock`, `syntaxVariable`, `searchMatchText`.
- **Muted text:** `muted`, `mdLinkUrl`, `toolDiffContext`, `syntaxPunctuation`, `thinkingText`, `dim`, `syntaxComment`.
- **Words in colour:** `accent`, `success`, `error`, `warning`, `toolTitle`, `mdHeading`, `mdLink`, `mdCode`, `mdListBullet`,
  `customMessageLabel`, `toolDiffAdded`, `toolDiffRemoved`, `syntaxKeyword`, `syntaxFunction`, `syntaxString`, `syntaxNumber`,
  `syntaxType`, `syntaxOperator`.

Each role is measured on the backgrounds it sits on:
- `text` and `muted` are measured on all of them, a selected row and a search match too.
- `userMessageText` is measured on your messages and the export's cards, `customMessageText` on custom messages, and
  `toolOutput` on the three tool boxes.
- The other body and muted roles are measured on the page, your messages, custom messages and the tool boxes. `thinkingText` is
  measured on the page.
- Words in colour are measured on the page, your messages and a failed tool box.

`jig-mono` goes further: its muted text keeps 7:1 and its body text 12:1.

Borders, rules and the thinking-level bars are not text, and have no ratio. They are
chosen to be seen, and to be quiet.

**One exception, and it is named.** `jig-signal` was drawn before these rules, and its
`dim` and `syntaxComment` (`#586779`) are 3.2:1 on the page and 3.0:1 on your messages,
under 4.5:1. They are kept as drawn. The test lists them, and fails when they no longer
need the exception.

## The six

| Colour | `jig-lime` | `jig-signal` | `jig-ember` | `jig-orchid` | `jig-mono` | `jig-paper` |
|---|---|---|---|---|---|---|
| `bg` | `#11160F` | `#0E1520` | `#17120E` | `#15111F` | `#0C0C0C` | `#FAF6EE` |
| `panel` | `#171D14` | `#111C2A` | `#211A14` | `#1D1830` | `#161616` | `#F1EADB` |
| `selected` | `#283322` | `#1B2A3D` | `#33271C` | `#2D2548` | `#2A2A2A` | `#E5DAC3` |
| `errorBg` | `#22171C` | `#241820` | `#2E1715` | `#2B1522` | `#251616` | `#FBE3DF` |
| `text` | `#FFFFFF` | `#FFFFFF` | `#FFF8F0` | `#FBF8FF` | `#FFFFFF` | `#1B1712` |
| `soft` | `#E4E8DD` | `#D8E1EA` | `#EBDFD1` | `#E3DDF2` | `#F0F0F0` | `#2E2820` |
| `muted` | `#A5AE9A` | `#8292A6` | `#BBA994` | `#B1A8CC` | `#BEBEBE` | `#5A5144` |
| `dim` | `#929D86` | `#586779` | `#A39380` | `#9A92B6` | `#A8A8A8` | `#6A6050` |
| `border` | `#46513A` | `#273344` | `#5A4634` | `#4A4070` | `#5A5A5A` | `#B8AA90` |
| `borderMuted` | `#35402C` | `#1D2734` | `#3A2D22` | `#2F2749` | `#343434` | `#DDD2BD` |
| `accent` | `#C4F36B` | `#55DDE0` | `#FFAE42` | `#B794F6` | `#5CE1E6` | `#9C4208` |
| `link` | `#73DFEB` | `#55DDE0` | `#7FD6C2` | `#6EC1FF` | `#5CE1E6` | `#0B6A94` |
| `heading` | `#ED9EE8` | `#C099FF` | `#FF8C75` | `#F78FC3` | `#FFFFFF` | `#862A74` |
| `info` | `#73DFEB` | `#78A9FF` | `#8FB8E8` | `#9DA9FF` | `#D2D2D2` | `#2A55A0` |
| `success` | `#C4F36B` | `#7BD88F` | `#A5D86E` | `#7EE0B0` | `#5CE1E6` | `#25702A` |
| `warning` | `#FFD080` | `#FFB454` | `#FFD166` | `#FFC777` | `#FFD166` | `#8A5600` |
| `error` | `#FF8095` | `#FF6B7A` | `#FF6B6B` | `#FF7A93` | `#FF6B6B` | `#B3261E` |


- **`jig-lime`:** dark, a lime accent with cyan and pink on an olive black. It sets 15
  roles itself, among them its slate-blue rules and the colour of inline code.
- **`jig-signal`:** dark, cyan with blue and violet on a navy black. It sets 14 roles
  itself, among them the cool-grey rules it shares with `jig-lime`, and tool boxes with
  no background of their own.
- **`jig-ember`:** dark, amber and coral on a warm brown black, with aqua links and a
  steel blue for tool titles and function names.
- **`jig-orchid`:** dark, violet, pink and blue on a purple black, with mint for success.
- **`jig-mono`:** dark, greys and one accent, cyan, on a near black, for the highest
  contrast. Success is the accent and not green, so a diff reads as cyan and red, which
  colour-blindness does not hide. Red and amber are kept for what needs attention.
- **`jig-paper`:** light, dark ink on a warm white, with deeper colours so that they
  hold their contrast on a light page.

`jig-lime` and `jig-signal` set roles by hand because they were drawn before the role
map and match the themes they came from role for role; a test compares every role with
a copy of each. The other four set none: they are the map and their seventeen colours.

When you base your own palette on one of the first two, a role they set by hand does not
follow your `vars`; set it in your `colors`.

## Adding a palette to the plugin

1. Add its seventeen colours to `src/palettes.ts`, with the name `jig-<name>`.
2. Run `node plugins/jig-theme/scripts/build-themes.ts`, which writes
   `themes/jig-<name>.json`, and commit the file.
3. Run the tests. They check that the file is what the builder makes, that every role
   Pi requires is there, that Pi's own validator accepts it, and the contrast rules.

Nothing else lists the palettes: the package manifest takes every file in `themes/`.
