# Credential sources: where a request's login comes from

Jig never signs in, and never stores a credential. The tool that owns a login
does it: `gh` for GitHub, the Postman CLI for Postman, Pi's `/mcp login` for MCP
servers, a company plugin's sign-in service for its own systems.

`jig-core` only **reads a credential that already exists**, from a source you
configured, and attaches it to a request, so the plugin that sends the request
never sees the value. It also keeps the credential stores and its own files away
from the agent (see [Protected paths](configuration.md#protected-paths)).

Back to the [jig-core overview](../README.md). The decision is in
[Decisions](../../../docs/decisions.md).

A plugin sends a request with `jig().http.request(request, signal)` and names
where its credential comes from in `auth`. There are four places.

| `auth` | Where the credential comes from | Who signs in |
|---|---|---|
| `{ bearer }`, `{ basic }`, `{ header }` or `{ query }` | A **secret reference**: a store, a variable, a file or a command, read just before the request | The tool or person that put the secret there |
| `{ signIn: name }` | A company plugin's **sign-in service**, which returns the headers of each request | The company's service |
| `transport: name` (instead of `auth`) | A company plugin's **transport**, which carries the whole request and holds the session | The company's proxy |
| `{ oauth: { ... } }` | A **token endpoint**: a client-credentials or password grant, with a secret reference | The token endpoint; no browser is involved |

## The request

```ts
const reply = await jig().http.request(
  {
    system: "orders-api",                       // as sign-in services and transports are told it
    url: "https://api.staging.example.com/v1/orders?page=2",
    method: "GET",
    headers: { Accept: "application/json" },
    auth: { bearer: "env:LOGS_TOKEN" },
    timeoutMs: 20_000,                          // default 30 s, at most 10 minutes
    maxBytes: 1024 * 1024,                      // default 4 MiB, at most 64 MiB
  },
  signal,
);
// reply: { status, headers, cookies, body, bytes, truncated, binary }
```

- **A redirect is never followed.** It would carry the credential to an address
  nobody configured. A 3xx comes back as a reply, and `reply.headers.location`
  holds where it points, so a plugin can word its own error.
- **The reply is capped.** It is read as it arrives and cut at `maxBytes`, with
  `truncated: true`; no request is ever refused for size here, a plugin that
  wants a refusal checks `truncated`. `binary` is true when the first 4 KiB hold
  a NUL byte.
- **The credential is removed from the reply.** A server may echo what it was
  sent, so every credential that went out (a value of 8 characters or more) is
  replaced by `[redacted]` in the body, the headers and the cookies, as it is,
  inside JSON text and URL-encoded. `jig-core` also hides it from every later
  tool result.
- **A secret is read once for requests that share a signal.** The several
  requests of one call pass the same `signal` (`AbortSignal.any([])` makes one
  when the call has none), so a store that is locked asks you to unlock it once
  and a search of many buckets does not run the backend for each.
  - A failed read is not kept, and a request with no signal reads every time.
  - A sign-in service is asked for every request, because it knows when a token
    has run out.
- **A request is sent once.** Nothing is retried, except one resend after a 401
  for an OAuth token that came from the cache: the server turned it down for an
  expired token before it acted, so a write is not repeated.
- **A header that the credential also sets replaces the request's** (ignoring
  case). A request can say `onHeaderClash: "refuse"` to get an `invalid_request`
  error instead, so that one of the two never silently wins. `defaultHeaders`
  (an `Accept`, a `User-Agent`) always give way, to the request's `headers` and
  to the credential's.
- **The time limit starts after the credential is in hand.** A secret store may
  wait for you to unlock it, and that is not the server's time. A transport or a
  fetch that ignores its signal still times out.
- **`transport` and `auth` do not go together:** a transport signs in itself. A
  transport carries `GET`, `POST`, `PUT`, `PATCH` and `DELETE` and a text body.

### When a request fails

A request that gets no reply throws one error type, `HttpError`, with a `code`
and `notSent`. Its message never holds a header value, a credential, the query
of the address, or the address itself.

| `code` | Meaning | `notSent` |
|---|---|---|
| `invalid_request` | The request is wrong (address, method, `auth`, a header, a transport that cannot carry it) | yes |
| `auth_failed` | The credential could not be read or made (a missing secret, a failed sign-in, a refused grant) | yes |
| `no_transport` | No transport has that name | yes |
| `ECONNREFUSED`, `ENOTFOUND` and other connect codes | The connection was never made | yes |
| a TLS code such as `CERT_HAS_EXPIRED` | The certificate was not accepted. Certificate checks are never turned off | yes |
| `ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, other system codes, `network_error` | The connection failed or broke, and the server may have acted | no |
| `transport_failed` | A transport threw or answered wrongly | no |
| `timeout` | No answer within `timeoutMs` | no (yes when it ran out before anything was sent) |
| `aborted` | The call was cancelled. `error.cause` is the signal's reason | no (yes when it was cancelled before anything was sent) |

`notSent` is what a plugin needs for a write: when it is true, nothing happened
on the other side, so it is safe to say so, and to send again.

- **`auth_failed`** carries the reason as its message, without the reference.
- **The connect codes** are `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`,
  `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT` and `bad_port`.

## A secret reference

`{ bearer: "env:LOGS_TOKEN" }` and the other three shapes name a secret by
reference. `jig-core` resolves it with an allowed backend just before the
request, registers the value with the redactor, and puts it in the header or the
query.

The reference is never repeated in an error. The backends are listed in the
[configuration reference](configuration.md#secret-references).

```json
{ "secrets": { "backends": ["pass", "env", "cmd"], "commands": { "gh": ["gh", "auth", "token"] } } }
```

```ts
// A token in a variable of the Pi process
auth: { bearer: "env:LOGS_TOKEN" }

// The token of a tool that owns the login: `gh auth token`, declared by name
auth: { bearer: "cmd:gh" }

// A user name in the open and a password in the store
auth: { basic: { user: "svc-orders", password: "pass:work/orders-password" } }

// An API key in a header of its own, or after a scheme word
auth: { header: { name: "X-Api-Key", value: "op://work/orders-api/key" } }
auth: { header: { name: "Authorization", value: "env:LOGS_TOKEN", prefix: "ApiKey " } }

// A key in the query of the address
auth: { query: { name: "api_key", value: "file:~/.config/orders-api/key" } }
```

- **`cmd:<name>`** runs a command you declared by name in `secrets.commands`
  (or a company plugin declared with `config.addSecretCommands`), with no
  shell, and uses its trimmed standard output.
  - Delegating the login to `gh` means `gh auth token` is the credential, and
    Jig holds no token file of its own.
  - An undeclared name is refused, so a model cannot slip in a command of its
    own through a parameter.
- **`file:<absolute path>`** reads the first line of a file you point it at.
  Use it for a file another tool keeps up to date. It never reads Pi's agent
  folder.
- **Only configuration names a reference.** A reference comes from your
  `jig.json` or a company plugin, never from a tool parameter the model fills.

## A sign-in service

Some systems are signed in to by code, not by a stored password: a single
sign-on gateway, for example. A company plugin supplies that code as a
**sign-in service**, and a request names it with `auth: { signIn: "corp-sso" }`.

The headers it returns are added to the request, and `jig-core` asks it again
for the next request, because the service decides when a token has expired.
The details are in [Sign-in services](#sign-in-services) below.

## A transport

A company that keeps the session in a local sign-in proxy supplies a
**transport**, and a request names it with `transport: "corp-proxy"` instead of
`auth`. The request is carried by the proxy, and the tool never holds a
credential. The details are in [Transports](#transports) below.

## A token endpoint (OAuth, with no browser)

```ts
auth: {
  oauth: {
    grant: "client_credentials",
    tokenUrl: "https://auth.staging.example.com/oauth/token",
    clientId: "orders-client",
    clientSecret: { ref: "env:ORDERS_CLIENT_SECRET" },
    scope: "orders.read",
    cache: "orders-api/staging",
  },
}
```

- **Two grants only:** `client_credentials` (RFC 6749, section 4.4) and
  `password` (section 4.3, with `username` and `password`). A grant that needs a
  browser (the authorization code, the implicit grant) is not here, and no
  plugin can ask for one.
- **A value is plain text or `{ ref }`.** The client's secret and the password
  are read from a secret reference and never pass through the plugin.
- **A client with a secret signs in with HTTP Basic,** as RFC 6749 asks, unless
  `clientAuth` is `"body"`.
- **The token is kept in memory,** until a minute before it expires, and never
  written anywhere. It is reused for the same settings and the same `cache`
  label, and replaced after a 401. It is sent as a bearer token, and hidden like
  a secret. Only bearer tokens are accepted.
- **A failure says only the standard's words.** The token endpoint's own text is
  never repeated; the error codes of RFC 6749, section 5.2, are.

## Sign-in services

A company plugin supplies the code that signs a request in, such as for a single
sign-on gateway, as a **sign-in service**.
- **The company plugin registers it** with `signIn.register(name, service)`.
  Registering the same name again replaces the service.
- **A request asks for it by name,** with `auth: { signIn: name }` in
  `http.request`, and the headers are added to the request without the plugin
  seeing them.
  - `signIn.headers(name, { system, url, method, headers, body }, signal)` is
    the call underneath.
  - Tools such as `jig-jira` and `jig-logs` use it when their configuration
    names a sign-in service instead of a secret reference.
  - The answer is the headers that authenticate that one request. Ask again for
    the next request: the service decides when a token has expired.
- **The service sees the whole request,** so it can sign it. A scheme that signs
  the method, the path and the body (an HMAC scheme, AWS Signature Version 4)
  would otherwise sign a POST as a GET, and the server would answer 401.

  | Field | What it holds |
  |---|---|
  | `system` | The system, as the tool calls it, such as `orders-api` |
  | `url` | The full address, with its query |
  | `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS` |
  | `headers` | The headers the request carries, without the credential |
  | `body` | The body as sent, text or bytes; absent when there is none |

  - **`headers`** are the caller's defaults, replaced by its own headers of the
    same name (ignoring case). The network adds `Host`, `Content-Length` and, for
    a text body with none, `Content-Type: text/plain;charset=UTF-8`. A service
    that signs the content type returns it among its headers.
  - **The service reads, and does not change,** the body and the headers. The
    headers are a frozen copy, and the body is the one that is sent.
  - **A request with no method or no headers is refused** before the service
    is asked, so a service never signs a guess.
- **The values are hidden like secrets.** Each header value is registered with
  the redactor before it is returned, so it is removed from every later result
  with the same encodings as a secret (see
  [What happens to a result](results.md)).
  - The token in an `Authorization` header is hidden on its own too, in case a
    server repeats it without the scheme.
  - An empty value is not registered.
- **An error never shows a value.** An unknown name is an error that lists the
  names registered. A service that throws is an error that names the service
  and carries its message. A header whose value is not a string is an error
  that names the header.

```ts
// A service that signs the method, the path with its query, and a hash of the body
jig().signIn.register("corp-hmac", {
  async headers(request) {
    const url = new URL(request.url);
    const body = createHash("sha256").update(request.body ?? "").digest("hex");
    const text = [request.method, url.pathname + url.search, body].join("\n");
    const key = await jig().secrets.resolve("env:ORDERS_SIGNING_KEY");
    return { "X-Signature": createHmac("sha256", key).update(text).digest("hex") };
  },
});
```

## Transports

Some companies keep the session for their systems in a local sign-in proxy:
the agent's tools must send requests through it, and never hold a token at
all. A company plugin supplies that path as a **transport**.
- **The company plugin registers it** with `transports.register(name,
  transport)`. Registering the same name again replaces it.
- **A request is sent through it by name,** with `transport: name` in
  `http.request`. `transports.request(name, { system, method, url, headers, body,
  maxBytes, timeoutMs }, signal)` is the call underneath. Tools build the same
  HTTP request either way, so only the path changes.
- **The transport is told the caller's limits:** `maxBytes`, the most reply bytes
  the caller reads (4 MiB unless its request says otherwise), and `timeoutMs`, how
  long the whole request may take (30 seconds unless it says otherwise). The
  `signal` fires when the time is over, so a transport that honours it needs
  nothing more; the number is for one that sets a limit of its own.
  - **Stop one byte past `maxBytes`,** not at it, so that a reply of exactly that
    size and a longer one look different. `jig-core` cuts the reply to
    `maxBytes` and sets `truncated` when it was longer.
  - **A caller of `transports.request` that leaves a limit out** gets the defaults.
- **The answer is checked:** a status from 100 to 599, headers as text (their
  names in lower case) and a text body. Anything else is an error that names
  the transport.
- **A header sent more than once may be returned as a list,** one entry for each
  time: `"set-cookie": ["a=1", "b=2"]`. The tool still gets one text, folded with
  `, ` as a reply from the network is, and a `set-cookie` list becomes the cookies
  as they are, so a date with a comma in it is never split.
- **Errors never repeat the request.** Its URL or body may hold data that is
  masked only in the tool's result.
- **The result is governed like any other:** it goes through the result hook,
  so it is redacted, masked where needed and capped.
