# jig-http: calling APIs

**Status: built.** Tested against a fake API on this machine, over plain `http`
through `allowPlainLocal`. Not tried against a real service, a real OAuth server
or a real sign-in service yet (see [Not verified yet](docs/not-verified.md)).

`jig-http` gives the agent one tool, `http`, for calling named HTTP APIs. A
**target** is a name in configuration that holds the address, the environment
and the sign-in, so the model never types a host or a credential, and `jig-core`
governs every call. For example, `POST /v1/accounts` to the target `billing-api`
in `staging` shows you the method, the full address and the body, and is sent
only after you press `y`.

## Tool: `http`

One call to a named target. Calls run one at a time, in order. `GET` reads;
`POST`, `PUT`, `PATCH` and `DELETE` write.

| Parameter | Kind | What it does |
|---|---|---|
| `target` | required | A name from the `http` section. An unknown name is refused with the names there are |
| `method` | required | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | required | Starts with `/`, then at most 400 characters and at most one `?query`. No `..`, also when percent-encoded. The characters allowed are in [Parameters](docs/parameters.md) |
| `body` | optional | Any JSON value, at most 256 KiB once written out; not for `GET`. Sent as `application/json` |
| `headers` | optional | At most 10, such as `{"X-Request-Id": "t1"}`. Headers that carry a sign-in or control the connection are refused |
| `timeoutSec` | optional | How long to wait for the answer: 1 to 120, 30 by default |

A call with a missing or an unused parameter is refused with the usage line, such
as `http needs path. Usage: http {target, method, path, body?, headers?,
timeoutSec?}`. A non-2xx answer is a normal result, not an error (see
[Results](docs/results.md)).

## Rules

- **Reads and writes.** `GET` reads; every other method writes. Both act in the
  target's environment, so the [rules table](../../docs/permissions.md) decides.
  A write to a test environment asks you by default, and a write to production
  is denied by the floor. A read of production is allowed, and always masked.
- **One target, one action.** A call's action is its target's name, so a rule
  such as `{ "tool": "http", "action": "orders-api", "decision": "allow" }`, or
  "Allow for this session", covers that one API and not every API in its
  environment.
- **Sign-in is added by the tool,** never typed by the model.
- **Invalid input is not asked about.** A call that names a target that is not
  configured, or breaks a limit, is blocked with a message that says what to
  change.
- **The address is the target's.** The path is added to the text of the base
  address, so the host cannot change. Redirects are never followed, so a token
  or a signature cannot go to another host or in the clear; a redirect comes back
  as a result with its `location`.
- **Previews.** A call that asks shows the target, how it signs in (named, never
  shown), the method, the full address, the headers and the body. If what would
  be sent now differs from what you approved, nothing is sent: "changed since the
  preview; run it again to see the new preview".
- **No resend.** A request is sent once. A write whose outcome is unknown (a
  timeout, a dropped connection, a cancelled call) is never sent again; the tool
  says so, and to check with a `GET`. An error status is a result, with a note
  that a write may still have happened.
- **Facts.** After an answer, the call's record carries the status, as the fact
  `status`.

## Configure

In `~/.pi/agent/jig.json`, under `http`. An unknown field is an error, and the
tool then does nothing until the file is fixed (`/jig` lists the problems).
`targets` maps a name to a target, 1 to 100 of them. A name has 1 to 40 letters,
digits, `.`, `_` and `-`, and starts with a letter or a digit. A target has these
fields:

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | The https address of the API, such as `https://billing-api.staging.example.com/v1`. It may have a path. No user name, password, query or fragment |
| `environment` | required | The environment name that rules and classification know this API by: letters, digits, `_` and `-`, starting with a letter, up to 40 characters. A name `jig-core` does not know counts as production |
| `auth` | required | How requests are signed in: exactly one of `none`, `bearer`, `oauthPassword`, `signIn` or `transport` (see [Sign-in](docs/auth.md)) |
| `description` | none | A short text of up to 200 characters. It appears in the message about an unknown target and in previews |
| `allowPlainLocal` | `false` | Allows plain `http` for `http://127.0.0.1` and `http://localhost` only, for a service that runs beside Pi. Any other `http` address is refused whatever this says |

```json
{
  "http": {
    "targets": {
      "billing-api": {
        "baseUrl": "https://billing-api.staging.example.com/v1",
        "environment": "staging",
        "description": "Billing API, test copy",
        "auth": { "bearer": "pass:work/billing-token" }
      }
    }
  }
}
```

Certificates are always checked. To trust a private certificate authority, start
Pi with `NODE_EXTRA_CA_CERTS` pointing at its certificate.

## Company part (in the company plugin)

- the targets: their base addresses and environment names, with a company
  transport for an API that is reachable only through a bastion host or a VPN;
- the code a target's sign-in needs: company sign-in services (for example a
  single sign-on gateway) and transports, registered with `jig-core` under the
  names a target gives;
- the environments those targets name, added to `jig-core`;
- an overlay skill that names the targets and what they are for. The model
  learns the target names from it, and from the message about an unknown one.

## Layout

```text
jig-http/
  src/      the tool and its checks (index, tool, params, config, plan, preview), sending a call (http, wire, oauth,
            scrub), what the model reads (render, json), small helpers (values)
  skills/   http/SKILL.md: how to call an API
  test/     against a fake API on this machine and a fake jig-core
  docs/     the detail pages below
```

## More detail

- [Parameters](docs/parameters.md): the checks on a path, a body and headers
- [Sign-in](docs/auth.md): the five forms, secrets and the OAuth password grant
- [Results](docs/results.md): what the tool returns, and what is removed from it
- [Writes](docs/writes.md): previews, "changed since the preview", lost replies
- [Not verified yet](docs/not-verified.md): what needs a real service
