# The contract for plugins

What other plugins get from `jig-core`. Back to the
[jig-core overview](../README.md).

Plugins import only this contract, never each other. A plugin imports the
contract's types, and reaches `jig-core` at run time through `jig()`, or through
`withJig(use)` from its factory, which waits when Pi loads the plugin before
`jig-core`. `jig()` throws when `jig-core` is not loaded, so a Jig tool fails
closed instead of running ungoverned.

## For a Jig tool

- how the tool declares the environment and effect of each action;
- how it asks for a secret, or for the sign-in a company provides;
- how it gives a preview for the review screen;
- how it adds facts to its record.

## For every plugin

- the watch engine: what to poll, how often, and when the watch is done;
- the record format;
- its own section of `jig.json`: the plugin registers the section and a check,
  and reads the section back (see the
  [configuration reference](configuration.md#sections-of-other-plugins));
- the events published on Pi's event bus, so other plugins can react to calls,
  decisions and results.

## The calls

| Call | What it gives a plugin |
|---|---|
| `declareTool(declaration)` | How the tool's calls are classified (`classify`, pure and fast, because it runs before every call; a `TypeError` from it means invalid input), an optional `preview` for the review screen, and whether the tool masks its own results. Declaring a tool again replaces the declaration |
| `approvedPreview(toolCallId)` | The preview you approved for this call, or nothing when the call did not ask. A tool compares it with what it would do now, and refuses with "changed since the preview" when they differ |
| `addFacts(toolCallId, facts)` | Facts for this call's record |
| `setTicket(key)` | The ticket the session works on. Records carry it |
| `secrets.resolve(ref)` | The value of a secret reference, from an allowed backend. It is hidden from every result afterwards |
| `signIn`, `transports` | A company's sign-in service or transport, by name (see [Sign-in services and transports](sign-in-and-transports.md)) |
| `mask.text`, `mask.value` | The masker, for a tool that masks its own results (see [Masking](masking.md)) |
| `watches` | `registerKind`, `start`, `list` and `stop` (see [Watches](watches.md)) |
| `environments` | `kindOf(name)`: the kind of an environment (`local`, `external`, `test` or `production`), built in, configured or added by a company plugin. A name nobody defined counts as production. A tool uses it to refuse an action by kind, such as never in production, whatever a company names its environments |
| `config` | What a company plugin adds at start-up (`addEnvironments`, `addRules`, `addClassifyRules`, `addMaskFields`), and a plugin's own section (`registerSection`, `section`) |
| `exec` | `run` and `git`, which start programs without a shell (see [Running programs](running-programs.md)) |

## Events

On Pi's event bus:

| Event | When | What it carries |
|---|---|---|
| `jig:decision` | After every decision on a call | The tool call id, tool, action, environment and its kind, effect, the decision and where it came from, and your answer when the call asked |
| `jig:watch-done` | When a watch ends | The watch and its cleaned result (see [Events](watches.md#events) in Watches) |

A listener that fails does not change a decision.
