# jig-core: code map

Every file of `src/`, what it does and who calls it, and then one real call, a tool call through the gate, followed
through the files. Read it with the code open. Back to the [jig-core overview](../README.md).

## The files

`jig-core` is the one plugin every other plugin needs, so its files fall into a few groups: the two hooks around a
call, the parts that decide, the part that asks you, the parts that protect what comes back, the configuration and
state, and what other plugins use through `jig()`. A test (`plugins/jig-core/test/code-maps.test.ts`) fails when a file
of `src/` is missing here or a file listed here is gone, so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: builds the state and hooks `tool_call`, `tool_result`, `tool_execution_end`, `turn_end`, `/jig` | Pi, which loads it |

### The two hooks around a call

| File | What it does | Called by |
|---|---|---|
| `gate.ts` | The `tool_call` hook: classify, decide, ask the user, announce, then let the call run or block it | `index.ts` |
| `results.ts` | After a tool ran: redact, mask production data, cap, and write the call's record | `index.ts` |

### Deciding

| File | What it does | Called by |
|---|---|---|
| `classify.ts` | Where a call acts and whether it reads or writes, from the tool's own word, a rule, or a default | `commands.ts`, `config.ts` and 3 more |
| `decide.ts` | The pure decision: allow, ask or deny, from the rules table, the floor and your configuration | `commands.ts`, `config.ts` and 2 more |
| `gates.ts` | Checks that other plugins register; a gate can make a decision stricter and never looser | `gate.ts`, `state.ts` |
| `environments.ts` | The names a call can act in, and which are test and which are production | `config.ts` |
| `protected-paths.ts` | The files Pi's own file tools may not touch: credentials, Pi's settings, Jig's state | `commands.ts`, `config.ts` and 2 more |

### Asking you

| File | What it does | Called by |
|---|---|---|
| `approvals.ts` | Asking inside the waiting call: dialog, review screen or form, one question at a time | `gate.ts`, `state.ts` |
| `review.ts` | The review screen: a scrollable preview you approve with a key | `approvals.ts` |
| `preview.ts` | The one-line summary and the body of what a call will do, from the tool or from the call itself | `gate.ts` |
| `preview-html.ts` | A long preview as a local page you can read (the `o` key); it shows and never answers | `index.ts`, `state.ts` |

### Protecting what comes back

| File | What it does | Called by |
|---|---|---|
| `redact.ts` | Removes every resolved secret, in all its spellings, from a result | `secrets.ts`, `signin.ts`, `state.ts` |
| `cap.ts` | Cuts a very long result and keeps the whole text in a spill file the model can read | `index.ts`, `results.ts` |
| `records.ts` | One JSON line for every tool call and every model turn; never the arguments or the output | `approvals.ts`, `commands.ts` and 6 more |
| `mask/index.ts` | The masker: customer personal data in production results becomes tokens | `state.ts` |
| `mask/engine.ts` | Runs the passes over a value and fails closed with a fixed message | `mask/index.ts` |
| `mask/pass.ts` | One pass over a value or text: field names, embedded JSON, query strings, free text | `mask/engine.ts` |
| `mask/kinds.ts` | What a field or value is, and which field names mean what: the masking policy | the `mask/` passes |
| `mask/token.ts` | The keyed, deterministic tokens that replace a value, so a value can be followed across results | `mask/engine.ts`, `mask/host.ts`, `mask/pass.ts` |
| `mask/key.ts` | The daily key that makes the tokens, kept in a private file | `mask/index.ts` |
| `mask/host.ts` | What the text stages need from the pass that drives them, without importing it | `mask/embedded.ts`, `mask/freetext.ts` and 3 more |
| `mask/freetext.ts` | Patterns for personal data in free text: addresses, cards, phones, IPs | `mask/pass.ts` |
| `mask/credentials.ts` | High-confidence credential shapes, found in any text whatever the field name | `mask/pass.ts` |
| `mask/logfields.ts` | `key=value` fields in log lines, including unquoted phone and card values | `mask/pass.ts` |
| `mask/embedded.ts` | JSON inside text, judged by its field names; JSON it cannot delimit is refused | `mask/pass.ts` |
| `mask/jsonscan.ts` | Finding and parsing JSON embedded in log text, plain or escaped | `mask/embedded.ts`, `mask/pass.ts` |
| `mask/query.ts` | URL query values, masked by their decoded parameter names | `mask/pass.ts` |
| `mask/percent.ts` | Percent-decoding, a layer at a time, strict about what is not an escape | `mask/query.ts` |
| `mask/ip.ts` | IPv4 and IPv6 parsing and canonical text, so every spelling gives one token | `mask/freetext.ts`, `mask/token.ts` |
| `mask/phone.ts` | Phone-number facts: extensions and the digits that identify a number | `mask/freetext.ts`, `mask/pass.ts` |
| `mask/luhn.ts` | The Luhn checksum, to tell a card number from other digits | `mask/freetext.ts` |
| `mask/shelf.ts` | Holds finished text safe from later stages with placeholders, restored at the end | `mask/pass.ts` |
| `mask/limits.ts` | The budget of one masking call: bytes, depth and nodes, so one input cannot take unbounded time | `mask/pass.ts` |
| `mask/error.ts` | Why masking gave up, in fixed messages that never contain the input | the other `mask/` files |

### Configuration and state

| File | What it does | Called by |
|---|---|---|
| `config.ts` | `jig.json` and what company plugins add; an error never makes the plugin guess | `api.ts`, `commands.ts` and 4 more |
| `section-defaults.ts` | A company's defaults for a plugin's section, with your own laid over them | `api.ts`, `config.ts` |
| `state.ts` | What jig-core keeps while Pi runs: tools, configuration, questions, one record per call in flight | `api.ts`, `commands.ts` and 3 more |
| `paths.ts` | Where jig-core keeps things: the state folder, records, spill files, previews, the key | `cap.ts`, `index.ts` and 4 more |
| `commands.ts` | The `/jig` commands: status, rules, records | `index.ts` |

### What other plugins use

| File | What it does | Called by |
|---|---|---|
| `contract.ts` | The types plugins share with jig-core: tool declarations, records, events, watches. Types only | most files, as types |
| `client.ts` | How a plugin reaches jig-core at run time: `jig()` and `withJig()` | `index.ts`, and every other plugin |
| `api.ts` | The API behind `jig()`: each function is a thin step onto the state | `index.ts` |
| `secrets.ts` | Resolves a reference such as `pass:work/token` just before a tool needs it | `state.ts` |
| `signin.ts` | Sign-in services: how a company plugin signs requests in to its own systems | `state.ts` |
| `transports.ts` | How a company plugin carries requests to its own systems itself | `state.ts` |
| `tunnels.ts` | How a company plugin gives a tool a network route of its own, such as a database behind a jump host | `state.ts` |
| `exec.ts` | Runs programs for tools: an argument list, never a shell, with a timeout and a minimal environment | `api.ts`, `preview-html.ts`, `secrets.ts` |
| `git-config-guard.ts` | Refuses a repository whose own configuration would run a command when git runs | `exec.ts` |

### The request kit (kit/)

| File | What it does | Called by |
|---|---|---|
| `kit/http.ts` | One HTTP request with the credential read for it: address checks, sign-in, transport, limits | `state.ts` |
| `kit/oauth.ts` | OAuth 2.0 without a browser: client credentials or a password, token kept in memory | `kit/http.ts` |
| `kit/http-error.ts` | The one error a request throws | `kit/http.ts`, `kit/oauth.ts` |
| `kit/abort.ts` | Waiting for work that may ignore its signal | `kit/http.ts` |
| `kit/text.ts` | Putting values and names into messages without surprises | `signin.ts`, `transports.ts`, `tunnels.ts` |
| `kit/values.ts` | Small stateless helpers that plugins share, such as the invalid-input error | `config.ts`, `kit/http.ts`, `kit/oauth.ts`, the watch files |

### Watches (watch/)

| File | What it does | Called by |
|---|---|---|
| `watch/engine.ts` | The watch engine: polls each watch, saves it, and tells the agent once when it ends | `state.ts`, `watch/tool.ts` |
| `watch/tool.ts` | The `watch` tool: lists and stops the watches of every plugin | `index.ts` |
| `watch/store.ts` | Saved watches: one small JSON file each, so a restart of Pi picks them up | `state.ts`, `watch/engine.ts` |
| `watch/outbox.ts` | Telling the agent without flooding it: batches and spaces the messages | `watch/engine.ts` |
| `watch/message.ts` | What the agent is told when watches end, in plain words | `watch/engine.ts` |
| `watch/clean.ts` | Cleans what a watch says before anyone reads it | `commands.ts`, `watch/engine.ts`, `watch/store.ts` |
| `watch/format.ts` | How long a watch has run, as a short phrase | `watch/engine.ts`, `watch/tool.ts` |
| `watch/timers.ts` | The timers the engine uses, behind a small interface a test can drive by hand | `state.ts`, `watch/engine.ts`, `watch/outbox.ts` |

### Helpers

| File | What it does | Called by |
|---|---|---|
| `errors.ts` | The message of anything that was thrown; code can throw a string or an object | most files |

## How a call flows: `git push` through the gate

The agent asks for `git push` of a branch. These are the steps, in order.

1. **The hook.** Pi is about to run the tool, so it calls the `tool_call` handler that `index.ts` registered. That is
   `gate` in `gate.ts`. Any failure inside it blocks the call with "jig-core could not decide", because a tool must
   never run when `jig-core` cannot tell whether it may.
2. **Classify.** `classify` in `classify.ts` works out where the call acts and whether it reads or writes. The first
   answer wins: the tool's own declaration, then a classification rule in `config.ts`, then the built-in defaults for
   Pi's own tools, then the tool's hints, then the unknown default. `jig-git` declared `git push` when it loaded
   (`api.ts` keeps the declarations in `state.ts`), as a write to `external`.
3. **Decide.** `decide` in `decide.ts` runs five steps, each of which can only change what the step before gave: the
   rules table (a write to `external` asks), the tool's own minimum, the first rule of your configuration that
   matches, a session allow, and last the floor, which configuration can never lower. `environments.ts` says which
   kind of environment `external` is, and `protected-paths.ts` is part of the floor for Pi's file tools.
4. **Gates.** The decision is not `deny`, so `gates.ts` asks each gate other plugins registered. `jig-workflow`'s
   gate, if it is loaded, may hold the call. A gate can turn `allow` into `ask`, or `ask` into `deny`, never the
   reverse.
5. **Ask.** The decision is `ask`, so `askUser` in `gate.ts` builds the preview (`preview.ts` calls `jig-git`'s own
   preview: the commits that would be sent) and `approvals.ts` puts the question to you. A long preview uses
   `review.ts`; `preview-html.ts` can show it in the browser, which only shows. You answer `y` in Pi. A `n` blocks the
   call, with your reason.
6. **Announce.** `announce` tells other plugins about the decision on the event bus. The call is remembered in
   `state.ts` with its class, its decision and the preview you approved, which the tool can read back.
7. **The tool runs.** `jig-git` checks that what it is about to push is still what you approved, then runs git
   through `exec.ts`: an argument list, never a shell, with a timeout and a short environment, and a repository whose own
   configuration would run a command is refused (`git-config-guard.ts`).
8. **The result.** Pi calls the `tool_result` handler, `toolResult` in `results.ts`. It redacts every secret
   `secrets.ts` resolved (`redact.ts`), masks customer data if the environment is production (`mask/`), and cuts a
   very long text, keeping the whole of it in a spill file (`cap.ts`). A failure here withholds the result and never
   passes it on unchecked.
9. **The record.** At `tool_execution_end`, `records.ts` writes one line: the tool, the environment, the effect, the
   decision, your answer, how long it waited for you, the outcome and the duration. `jig-lens` reads these lines.
10. **The model.** The result that is left goes to the model.

Back to the [jig-core overview](../README.md).
