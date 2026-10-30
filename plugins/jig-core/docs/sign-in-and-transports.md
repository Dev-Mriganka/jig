# Sign-in services and transports

How a company plugin gives `jig-core` the way into its own systems: code that
signs requests in, or a path that carries them. Back to the
[jig-core overview](../README.md).

## Sign-in services

Some systems are signed in to by code, not by a stored password: a single
sign-on gateway, for example. A company plugin supplies that code as a
**sign-in service**.
- **The company plugin registers it** with `signIn.register(name, service)`.
  Registering the same name again replaces the service.
- **A tool asks for it by name,** with `signIn.headers(name, { system, url },
  signal)`, when its configuration names a sign-in service instead of a secret
  reference. Tools such as `jig-jira` and `jig-logs` do this. The answer is the
  headers that authenticate that one request. Ask again for the next request:
  the service decides when a token has expired.
- **The values are hidden like secrets.** Each header value is registered with
  the redactor before it is returned, so it is removed from every later result
  with the same encodings as a secret (see
  [What happens to a result](results.md)). The token in an
  `Authorization` header is hidden on its own too, in case a server repeats it
  without the scheme. An empty value is not registered.
- **An error never shows a value.** An unknown name is an error that lists the
  names registered. A service that throws is an error that names the service
  and carries its message. A header whose value is not a string is an error
  that names the header.

## Transports

Some companies keep the session for their systems in a local sign-in proxy:
the agent's tools must send requests through it, and never hold a token at
all. A company plugin supplies that path as a **transport**.
- **The company plugin registers it** with `transports.register(name,
  transport)`. Registering the same name again replaces it.
- **A tool sends through it by name,** with `transports.request(name, { system,
  method, url, headers, body }, signal)`, when its configuration names a
  transport. Tools build the same HTTP request either way, so only the path
  changes.
- **The answer is checked:** a status from 100 to 599, headers as text (their
  names in lower case) and a text body. Anything else is an error that names
  the transport.
- **Errors never repeat the request.** Its URL or body may hold data that is
  masked only in the tool's result.
- **The result is governed like any other:** it goes through the result hook,
  so it is redacted, masked where needed and capped.
