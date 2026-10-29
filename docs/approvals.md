# Approvals

When a rule says **ask**, `jig-core` asks you inside the tool call that is
waiting. Your answer is what lets the call run.

## The one rule

**You approve inside the waiting call; the browser only shows.**

An approval given inside the waiting call cannot be forged or replayed: no token
exists that the agent could reuse. A browser button would be a web endpoint on
this machine, and the agent's shell shares the network with it. An earlier
code-review page had exactly that weakness: its link reached the agent.

So the browser can render long text for you to read, and you approve with `y`
in Pi.

## Three kinds of question

| Kind | When | What you see | How you answer |
|---|---|---|---|
| Dialog | short, one-line confirmations | the action in one line | `y` or `n` |
| Review screen | long previews: diffs, Jira text, PR descriptions | a scrollable, coloured preview; `o` opens it rendered in the browser | `y` approves, `n` or Esc declines |
| Form | decisions with more than yes or no, such as choosing an option or filling a field | several questions on one screen, with options and free text | submit or cancel |

A rule can choose which kind its calls use. For example, Jira comments use
the review screen with a rendered preview.

The form will be built on an existing Pi package rather than from scratch. The
candidates are being compared (see [Reuse](reuse.md)), starting with
`@juicesharp/rpiv-ask-user-question`, which you already use.

## Rendered previews

Rich text is shown rendered before it is sent. That covers:
- Jira comments, descriptions and new issues;
- GitHub PR descriptions and PR comments.

The source is always one tab away. Status changes, field updates and deploys
keep the short dialog.

## What is recorded

Every question asked:
- which tool and action;
- which kind of question;
- your answer;
- how long the call waited for you.

That makes "time spent waiting for you" and "how often you were asked" visible
in `jig-lens`.

## Later

- **A "waiting for you" list across sessions,** for when you work on one
  ticket while another waits.
- **Approving from another session.** Still inside a waiting call, never through
  the browser.
