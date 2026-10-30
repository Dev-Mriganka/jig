# Parameters, and the checks on them

What each parameter of the `http` tool accepts, and what a call may not hold.
Back to the [jig-http overview](../README.md).

A call with a missing or an unused parameter is refused with the usage line, such
as `http needs path. Usage: http {target, method, path, body?, headers?,
timeoutSec?}`. A parameter given as `null` counts as unused. Every other mistake
is refused with a one-line message that says what to change. No call is sent for
any of them.

## Target

A name from the `http` section. A name that is not there, or no name at all, is
refused with the names there are:

```text
http: no target named "nope". Known targets: orders-api (staging: Orders, test copy), billing-api (production)
```

Each target is shown with its environment and the first 40 characters of its
description. The list is cut after about 120 characters, with a count of the
rest, because `jig-core` shows the reason of a blocked call to the model cut at
200 characters. Without an `http` section the message is `http is not set up: add
an "http" section with "targets" to jig.json (/jig lists configuration
problems)`.

## Method

Exactly `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, in capitals; anything else is
refused. `jig-core` classifies every method that is not exactly `GET` as a write,
so no spelling turns a write into a read.

## Path

Starts with `/`, then at most 400 characters of letters, digits and ``. _ ~ / ! $
& ' ( ) * + , ; = : @ % -``, then at most one `?query` of the same characters and
the same length. There is no fragment.
- **No `..`,** also when percent-encoded once or more. The path is decoded up to
  5 times to look for it, so `%252e%252e` does not pass as a name, and text that
  is still changing after that is refused too. One encoded dot, or encoded text
  that is not dots, is fine.
- **The host cannot change.** The path is added to the text of the base address,
  so a path that looks like another host, such as `//other.example.com/x`, is only
  a path on this host. The path of the base address stays in front of it.
- **The refusal** quotes the path, cut short, and says what is allowed.

## Body

Serialised once and compactly. The size limit is counted in bytes and not in
characters. `null` and a missing body both mean no body, because models often
send `null` for a parameter they do not use. A `GET` takes no body: put the
parameters in the path's `?query`. What is not JSON is refused.

## Headers

An object of name to value, kept in the order given.
- **Names** are a letter, then letters, digits and `-`, at most 41 characters in
  all. A name given twice, in any case, is refused.
- **Values** are 1 to 1000 printable ASCII characters.
- **Refused headers** are the ones that a value from the model would break or
  smuggle with, in any case:

  | Why | Headers |
  |---|---|
  | They carry a sign-in | `Authorization`, `Proxy-Authorization`, `Cookie` |
  | They control the connection or the framing of the request | `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Expect` |
  | They ask a server to treat the request as another method, which would let a `GET`, a read that nobody is asked about, act as a write | `X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override` |

  So is any header that the target's sign-in service sets. That is checked when
  the call runs, before anything is sent. The message reads `header Authorization
  is set by the tool or controls the connection, so it cannot be given`.

The tool itself sends `Accept: application/json, text/plain, */*`, `User-Agent:
jig-http` and, with a body, `Content-Type: application/json`. A caller's header
of the same name replaces them, and so does a header of the sign-in service.
