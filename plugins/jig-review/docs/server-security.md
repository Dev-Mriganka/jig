# Server security

What stands between the review page and anything else on this machine. Back to the
[jig-review overview](../README.md).

The agent's shell shares this machine's network, so a server on `127.0.0.1` cannot count on being
unreachable. This server assumes the agent can send it any request, and refuses all but yours.

## The rules, in the order they are checked

- **Listens on `127.0.0.1`, on a random port, for this Pi session only.** It stops when the session ends
  - *Why:* no other interface, no fixed port to find.
- **The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`**
  - *Why:* a page on another name that is pointed at this port (DNS rebinding) is refused.
- **The link's secret is swapped for a cookie, once.** `?k=<secret>` sets `jig_review` (HttpOnly, SameSite=Lax) and redirects to the same address without it
  - *Why:* the secret leaves the address bar and history.
- **Every other request needs that cookie** (compared in constant time)
  - *Why:* no other page and no other local process can use the server.
- **A write needs an `Origin` that is this server's own,** when it sends one
  - *Why:* another site's page cannot post to it.
- **A body over 1 MiB is refused**
  - *Why:* no memory to exhaust.
- **No route approves because it was asked.** Approval needs a passkey signature, or a `y` in Pi ([Passkeys](passkeys.md))
  - *Why:* a stolen cookie can comment as you; it cannot approve.

SameSite is `Lax` and not `Strict` because `Strict` is not sent on the redirect that follows opening the
link from outside the browser.

Every response carries `Content-Security-Policy: default-src 'self'; …; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

The page loads only its own files and may talk only to its own server. Responses that a handler builds itself (a file, the
event stream) get the headers too.

## The link

- The link is `http://localhost:<port>/review/<id>/files?k=<secret>`. It is shown to you in Pi and
  passed to your browser. `localhost` is used, not `127.0.0.1`, because a passkey's relying party id
  cannot be an IP address.
- **The tool result never contains the link,** nor the port, nor the secret. The agent is told only
  that the review opened.
- **A comment you send from the page reaches the agent as your own message,** which is why only this
  page may send one.
- The link can appear in the argument list of the program that opens the browser, and so in a
  process listing. That is why approval does not depend on the secret.

## What is served

Only the built files of the page, from `web/dist/`.
- **A request that leaves that folder** (`..`, or the same encoded) is a 404.
- **A path the page's own router knows,** such as a review's address, gets the index, so a reload keeps the page.
- **The page's API routes** are listed in the tests, which fail when a route is added or removed without the server and the page
  agreeing.

## Known limits

- **`localhost` may resolve to `::1` first.** The server listens on IPv4 only, so a browser then falls back
  to `127.0.0.1`. A program that bound `[::1]` on the same port would receive the first request, secret
  included. A leaked secret cannot approve, but it can comment as you.
- **Anything running as you can read the cookie from the browser's profile** or the link from Pi's
  terminal. That is outside what a local server can defend, and is why approval needs your device.
- **WSL.** The page is reached from a Windows browser through WSL's localhost forwarding. That is not
  verified yet ([Not verified yet](not-verified.md)).
