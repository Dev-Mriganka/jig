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
