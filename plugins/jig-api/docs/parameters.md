# Parameters, and the checks on them

What each parameter of the `api` tool accepts, and what a call may not hold. Back to the [jig-api overview](../README.md).

One flat object, with `action` choosing what to do:

| Action | Needs | May also have |
|---|---|---|
| `list` | | `collection`, `folder`, `text` |
| `show` | `request` | `collection`, `folder`, `environment` |
| `run` | `request`, `environment` | `collection`, `folder`, `variables`, `timeoutSec` |
| `run-folder` | `folder`, `environment` | `collection`, `variables`, `timeoutSec` |
| `call` | `environment`, `method`, `url` | `collection`, `body`, `headers`, `timeoutSec` |

A call with a missing or an unused parameter is refused with the usage line, such as
`api run needs environment. Usage: api run {request, environment, collection?, folder?, variables?, timeoutSec?}`.
- **A parameter given as `null`** counts as unused.
- **Every other mistake** is refused with a one-line message that says what to change.
- **No call is sent** for any of them.

## Names

- **`request`** is a request's name, or its path with folders (`Orders/Get order`). A name that is in two collections or folders is
  refused with the places it is in, and `collection` or `folder` narrows it. A name that is not saved is refused with the near
  ones, or with "use list to see them".
- **`collection`** is a collection's name from the configuration. An unknown one is refused with the known ones.
- **`folder`** is a folder path, `Orders` or `Orders/Smoke`, with every request below it. For a `.http` collection the last part
  is the file: `smoke/health.http`. An unknown folder is refused with the folders there are.
- **`environment`** is the collection's own name for it, such as `Staging`. An unknown one is refused with the ones the collection
  has. `run-folder` runs every request of the folder in that environment.
- **`text`** keeps the requests whose folder, name or address holds it, ignoring case.

The reasons are cut at about 200 characters when `jig-core` shows them, so a list of choices lists the first few.

## `variables`

An object of name to value, for the variables the request uses. Values are text, numbers or booleans. See
[Variables](variables.md) for what is refused and how a value is written. For `run-folder` the values are for the whole folder:
each request gets the ones it uses, and a value that no request of the folder uses is refused.

## `call`

An ad-hoc request. The `jig-core` environment the name maps to must be in `adHoc` and must not be production, and the host must be
one of the environment's. Everything the agent writes is held to a narrow set:

- **`url`** is a whole address: `https://api.staging.example.com/v1/orders/123?expand=items`.
  - The path and the query hold at most 400 characters each, from letters, digits and `` . _ ~ / ! $ & ' ( ) * + , ; = : @ % - ``,
    with one optional `?query`, no `#fragment` and no user name or password.
  - There is no `..`, also when percent-encoded: it is searched for after decoding up to 5 times, so `%252e%252e` does not pass,
    and text that is still changing after that is refused too.
  - The path is read from the text as written: a parser would resolve `..` and hide it.
  - An address that looks like another host (`//other.example.com/x` as a path) is only a path.
- **`method`** is `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH` or `DELETE`, in capitals. The first three read.
- **`body`** is any JSON value, at most 256 KiB once written out, serialised once and compactly, sent as `application/json`. `null` and
  a missing body both mean no body. A `GET`, `HEAD` or `OPTIONS` has none: put the parameters in the `?query`.
- **`headers`** are at most 10, names of a letter and then letters, digits and `-` (at most 41 characters), values of 1 to 1000
  printable ASCII characters, a name given once. A `Content-Type` or `Accept` the caller gives replaces the tool's. These are
  refused, in any case:
  - `Authorization`, `Proxy-Authorization` and `Cookie`, because they sign in;
  - `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE` and `Expect`, because they control the
    connection;
  - `X-HTTP-Method-Override`, `X-HTTP-Method` and `X-Method-Override`, because they ask a server to treat the request as another
    method, which would let a read act as a write.
- **`collection`** makes the call sign in as that collection does (its own `auth`, with the environment's secrets), and limits the
  hosts to that collection's. Without it a call is signed in only as the environment says (see [Sign-in](auth.md)).

## `timeoutSec`

A whole number of seconds from 1 to 120. Without it the configured `timeoutSec` applies, 30 by default.

The tool itself sends `Accept: application/json, text/plain, */*` and `User-Agent: jig-api`. A saved request's own header of the
same name replaces them, and so does the sign-in's.
