# jig-http: calling APIs

**Status: built, not yet tried against a real API.** This README is the
specification the code follows. [Not verified yet](#not-verified-yet) lists
what needs a real service.

`jig-http` gives the agent one tool, `http`, for calling named HTTP APIs. A
**target** is a name in configuration. It holds the address, the environment
and the sign-in, so the model never types a host or a credential. `jig-core`
governs every call.

## Tool: `http`

One call to a named target. Calls run one at a time, in order.

| Parameter | What it does |
|---|---|
| `target` | A name from the `http` section. An unknown name is refused with the names there are |
| `method` | `GET` reads; `POST`, `PUT`, `PATCH`, `DELETE` write |
| `path` | Starts with `/`, then at most 400 characters of letters, digits and ``. _ ~ / ! $ & ' ( ) * + , ; = : @ % -``, then at most one `?query` of the same. No `..`, also when percent-encoded once or more |
| `body` | Any JSON value, at most 256 KiB once written out; not for `GET`. `null` means no body. Sent as `application/json` |
| `headers` | At most 10. Names are letters, digits and `-`; values are 1 to 1000 printable ASCII characters |
| `timeoutSec` | How long to wait for the answer: 1 to 120, 30 by default |

A call with a missing or an unused parameter is refused with the usage line,
such as `http needs path. Usage: http {target, method, path, body?, headers?,
timeoutSec?}`.

**Refused headers.** These carry a sign-in, control the connection, or ask a
server to treat the request as another method (which would let a `GET`, a read
that nobody is asked about, act as a write): `Authorization`,
`Proxy-Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`,
`Connection`, `Upgrade`, `TE`, `Expect`, `X-HTTP-Method-Override`,
`X-HTTP-Method` and `X-Method-Override`. So is any header that the target's
sign-in service sets; that is checked when the call runs, before anything is
sent. The tool itself sends `Accept`, `User-Agent: jig-http` and, with a body,
`Content-Type: application/json`. A caller's header of the same name replaces
them.

## Rules

- **Reads and writes.** `GET` reads; every other method writes. Both act in
  the target's environment, so the rules table decides. A write to a test
  environment asks you by default, and a write to production is denied by the
  floor. A read of production is allowed, and always masked.
- **One target, one action.** A call's action is its target's name, so a rule
  such as `{ "tool": "http", "action": "orders-api", "decision": "allow" }`, or
  "Allow for this session", covers that one API and not every API in its
  environment.
- **Sign-in is added by the tool,** never typed by the model.
- **Invalid input is not asked about.** A call to a target that is not
  configured, or one whose path, body or headers break the limits above, is
  blocked with a message that says what to change. Nobody is asked about a call
  that cannot run.
- **The address is the target's.** The request goes to the base address with
  the path added to its text, so the host cannot change.
- **Redirects are never followed,** so a token or a signature cannot be sent to
  another host or in the clear. A redirect comes back as a result with its
  `location`.
- **Previews.** A call that asks shows the target, how it signs in, the method,
  the full address, the headers the model gave and the body as indented JSON,
  cut to 200 lines. The sign-in is named but never shown. The preview is made
  from the call and the configuration alone: it contacts nothing and reads no
  secret.
- **Changed since the preview.** The plan is made again right before the call
  is sent. If what would be sent now differs from the preview you approved
  (the body, the path, a header, the method, or the target's environment,
  address or sign-in), nothing is sent: "changed since the preview; run it
  again to see the new preview".
- **No resend on timeout.** A request is sent once. A write whose outcome is
  unknown (a timeout, a dropped connection, a cancelled call) is never sent
  again. The tool says that the outcome is unknown and to check with a `GET`.
  A request that failed before the server could read it (no connection, a
  certificate that is not accepted, a sign-in that failed) is reported as
  "nothing was sent". A `GET` that gets no answer says it can be sent again.
- **An error status is an answer.** A `500` to a write is a result, with a note
  that the write may still have been carried out: it is not sent again either.
- **The clock.** `timeoutSec` covers the requests, a token request included,
  and starts with the first one. Time spent waiting for a secret store to be
  unlocked is not counted.
- **Facts.** After an answer, the call's record carries the status, as the fact
  `status`.

## What the tool returns

A status line, the target, a few headers and the body. A non-2xx answer is a
normal result, not an error.

```text
POST https://billing.example.test/v1/accounts -> HTTP 201 Created
Target: billing (staging)
content-type: application/json
location: /v1/accounts/42

{
  "id": 42
}
```

| What | How it is shown |
|---|---|
| Headers | `content-type`, `location`, and trace or request ids; at most 6 |
| JSON | Re-indented with its numbers untouched, so a long id reads as the service sent it. Not cut here: `jig-core` cuts a very long result and keeps the whole text in a file |
| Other text | The first 200 lines, and a count of the rest |
| A binary body | Its size only |
| An answer over 2 MiB | Cut there, and the result says so |
| A redirect | A note that it was not followed |
| A write with a `5xx` or `408` answer | A note that it may still have been carried out |

A secret, a token or a sign-in header value that the tool sent (of 8
characters or more) is removed from the answer, in case a server repeats what
it was sent. `jig-core` masks production results and cuts long ones.

## Configure

In `~/.pi/agent/jig.json`, under `http`. An unknown field is an error, and the
tool then does nothing until the file is fixed (`/jig` lists the problems).

`targets` maps a name to a target. A name has 1 to 40 letters, digits, `.`, `_`
and `-`, and starts with a letter or a digit.

| Field of a target | Default | Meaning |
|---|---|---|
| `baseUrl` | required | The https address of the API, such as `https://api.example.test/v1`. It may have a path. No user name, query or fragment |
| `environment` | required | The environment name that rules and classification know this API by. A name `jig-core` does not know counts as production |
| `auth` | required | How requests are signed in: exactly one of the forms below |
| `description` | none | A short text. It appears in the message about an unknown target and in previews |
| `allowPlainLocal` | `false` | Allows plain `http` for `http://127.0.0.1` and `http://localhost` only, for a service that runs beside Pi. Any other `http` address is refused whatever this says |

| `auth` | Signs in with | For |
|---|---|---|
| `{ "none": true }` | Nothing | An open API, or one that the network protects |
| `{ "bearer": "<secret reference>" }` | `Authorization: Bearer`, with the secret read for every call | An API token |
| `{ "oauthPassword": { ... } }` | The OAuth 2.0 password grant, described below | An API behind an OAuth server and a service account |
| `{ "signIn": "<service name>" }` | The headers of the company sign-in service of that name, asked for again on every request | A company's single sign-on |
| `{ "transport": "<name>" }` | The company transport of that name: the whole request goes through it, and the tool holds no credential and adds no header | A company that reaches an API only through a local sign-in proxy |

A secret is a reference such as `pass:work/api-token` (see
[Secrets](../../docs/secrets.md)); a secret written into the file is refused,
and the error does not repeat it. With a sign-in service or a transport, the
system it is told is `http:<target>`.

### The OAuth password grant

| Field | Meaning |
|---|---|
| `tokenUrl` | The https address of the token endpoint. Plain `http` follows the same rule as `baseUrl` |
| `clientId` | The client's id |
| `clientSecret` | Optional, a secret reference. With it the client signs in with HTTP Basic (the id and the secret form-encoded, as RFC 6749 asks). Without it, only the id is sent |
| `username`, `password` | Secret references to the account |
| `scope` | Optional |

- The tool sends `grant_type=password` with the account, and the client id,
  as a form. It accepts a `200` answer with an `access_token` and sends it as a
  Bearer token. A token type other than `bearer` is refused.
- **The token is kept in memory** until 60 seconds before its `expires_in`. Without
  an `expires_in` it is kept until the server says otherwise. It is kept per
  target, and dropped when the sign-in settings change.
- **A `401` for a kept token** gets one new token and one repeat of the call,
  even for a write: the server turned the request down before it ran. A `401`
  for a token just issued is the answer, with a note.
- **The token is never written to disk, logged, shown or put in an error.**
  `jig-core` cannot hide it, because it did not resolve it, so the tool removes
  it from every answer itself.
- **A sign-in that fails** means nothing was sent to the API, and says why in
  one line: the endpoint's status and the standard error code (such as
  `invalid_grant`), never its own words, the account or the secrets.

```json
{
  "http": {
    "targets": {
      "billing": {
        "baseUrl": "https://billing.example.test/v1",
        "environment": "staging",
        "description": "Billing API, test copy",
        "auth": { "bearer": "pass:work/billing-token" }
      },
      "reports": {
        "baseUrl": "https://reports.example.test",
        "environment": "production",
        "auth": {
          "oauthPassword": {
            "tokenUrl": "https://login.example.test/oauth/token",
            "clientId": "reports-cli",
            "username": "pass:work/reports-user",
            "password": "pass:work/reports-password"
          }
        }
      }
    }
  }
}
```

Certificates are always checked. To trust a private certificate authority,
start Pi with `NODE_EXTRA_CA_CERTS` pointing at its certificate.

## Company part (in the company plugin)

- **The values of the targets:** their base addresses and their environment
  names. A target that is only reachable through a bastion host or a VPN is
  given a company transport.
- **The code a target's sign-in needs:** the sign-in services and the
  transports, registered with `jig-core` under the names a target gives.
- **The environments** those targets name, added to `jig-core`.
- **An overlay skill** that names the targets and what they are for. The model
  learns the target names from it, and from the message about an unknown one.

## Not verified yet

Written from the standards and a fake API on this machine, over plain `http`
through `allowPlainLocal`. Not tried against a real service:
- TLS to a real host, including a company certificate authority;
- a real OAuth server: whether it takes the client's id and secret as Basic
  credentials, and the shape of its errors;
- a real sign-in service and transport, which are company code;
- the review screen: the preview was checked as data, against a fake of
  `jig-core`, and not seen in the terminal.

## Layout

```text
jig-http/
  src/      the tool and its checks (index, tool, params, config, plan, preview), sending a call (http, wire, oauth,
            scrub), what the model reads (render, json)
  skills/   http/SKILL.md: how to call an API
  test/     against a fake API on this machine and a fake jig-core
```
