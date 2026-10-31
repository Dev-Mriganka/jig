# What asks, what is blocked

How `jig-core` decides a call, and the screens that ask you. Back to the
[jig-core overview](../README.md). Environments, rules and the floor are in
[Permissions](../../../docs/permissions.md); why you answer inside the waiting
call is in [Approvals](../../../docs/approvals.md).

The default table of decisions is in
[Permissions](../../../docs/permissions.md#the-rules-table).

Unknown tools ask until a rule or the tool's own hints classify them. With no
screen to ask on, "ask" becomes "deny".

A call is decided in this order, and each step can only change what the step
before it gave:
1. the table, or "ask" for a tool nothing classified;
2. the tool's own `atLeast`, which can only be stricter;
3. the first matching rule, which can be stricter or looser;
4. a session allow, which turns an ask into an allow;
5. the floor: a production write is denied, an unknown tool is allowed only by
   a rule that names it exactly, an ask with no screen is denied, and a call to
   one of Pi's file tools that touches a protected path is denied (see
   [Protected paths](configuration.md#protected-paths));
6. the gates other plugins registered, for a call that is not denied yet. They
   can only make it stricter: an allow becomes an ask or a deny, an ask becomes
   a deny, and an ask with no screen is a deny again (see
   [Gates](plugin-contract.md#gates)).

## The screens

- **Dialog:** Pi's selector with the header and the summary. Allow, Allow for
  this session, or Decline.
- **Review screen:** for a preview with a body, or when a rule or the tool asks
  for it, in the terminal interface. A scrollable preview (up and down, PgUp
  and PgDn, Home and End).
  - `y` allows, `s` allows for the session, `n` or Esc declines, `o` opens the
    rendered preview in the browser.
  - The browser only shows: the page is a local file with no script and no
    form, and the answer is always given in Pi.
- **Form:** shown with Pi's selector in this version.
- **Hosts without the terminal interface (RPC)** use the selector for every
  kind. A review question then shows the first 20 lines of the body in it, and
  at most 2 000 characters of them.
- **After Decline,** you may type a reason of up to 500 characters. The model
  reads it. It is not recorded.
- **One question at a time.** Calls from one message can run together, so
  questions wait in a queue.
- **A preview** that a tool builds gets 15 seconds. If it fails you see
  "preview unavailable: <reason>" and can still decide. A tool without a
  preview gets a summary made from the call, with its arguments cut to 200
  characters.
- **Invalid input is not asked about.** A tool's `classify` or preview that
  throws a `TypeError` says the input is invalid: the call is blocked with the
  tool's message, recorded with the error kind `invalid`, and nobody is asked.
  - `classify` matters for reads, which never ask and so never build a preview.
  - Any other error from either is a fault in the tool.
- **A tool's own page.** A tool can render its preview itself, such as Jira
  wiki markup turned into HTML. `o` then opens that page. Tags that could run,
  load or navigate are removed from it, and the page's policy blocks scripts
  and requests as well.
