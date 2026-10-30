# `.http` files: the dialect that is read

How a folder of `.http` files (the request files of JetBrains IDEs, the VS Code REST Client and Visual Studio) becomes saved
requests. Back to the [jig-api overview](../README.md).

```json
{ "http": "~/work/orders-api/http" }
```

The folder is the **collection folder**. Every `.http` and `.rest` file below it is read, in a fixed order; links, hidden folders
and `node_modules` are not (a link gets a warning). A request's folder path is its sub-folders and then its file, such as
`smoke/health.http`, so `run-folder` can run one file or one folder.

## Requests

| In the file | In jig-api |
|---|---|
| `###` | Separates requests. The text after it names the request that follows |
| `# @name x`, `// @name x`, `# @name = x` | The request's name; without one it is `<file>#<n>` |
| `METHOD address`, `address` alone | The method (a `GET` when left out) and the address. ` HTTP/1.1` after it is dropped |
| Indented lines, or lines starting with `?` or `&` | The rest of a long address |
| Headers | `Name: value` lines up to the first blank line. Comments among them are skipped |
| The body | Everything after that blank line, up to a `>` or `<>` line |
| `@name = value` | A value for every request of the file. It may use other variables |
| `{{name}}` | A variable. `{{a.b}}` also reads a nested object of the environment file |

Bodies:
- **JSON, XML and HTML** by their `Content-Type`.
- **A form** (`application/x-www-form-urlencoded`) written over several lines is one line.
- **`< ./file`** as the whole body is a file. A multipart body (`boundary=...`) is read into its parts, and a part that is
  `< ./file` is a file.
- **GraphQL:** `GRAPHQL address` (JetBrains) and `X-Request-Type: GraphQL` (VS Code) post a query and the JSON variables that
  follow it as JSON.
- **A relative path** is relative to the file's folder.

## Sign-in

An `.http` request signs in with its headers: `Authorization: Bearer {{token}}`.
- **The variables** in an `Authorization`, `Proxy-Authorization` or `Cookie` header fill the sign-in, so the agent never gives
  them.
- **`Authorization: Basic user password`** and `Basic user:password` are read as a sign-in and the tool builds the header. A
  `Basic` credential that is already encoded stays a header.
- **`Digest`** is refused.

## Environments

| File | Holds |
|---|---|
| `http-client.env.json` | `{ "staging": { "baseUrl": "..." }, "production": { ... } }` |
| `http-client.private.env.json` | The same shape, and **every key is a secret** |

- **`$shared`** in `http-client.env.json` holds values for every environment. A nested object becomes dotted names. `Security`
  (JetBrains' sign-in settings) is not read, with a warning.
- **A value in `http-client.private.env.json`** is refused, like a Postman secret with a value: not kept, never sent, and a
  warning names the file and the variable.

Both are looked for in the collection folder. The environment's name is its key.

## What is refused

- **Scripts.** A pre-request script (`< {% ... %}` before the request line) refuses the request. A response handler
  (`> {% ... %}` or `> file.js`) is ignored with a note, and so is a response saved with `>>`.
- **Protocols.** `WEBSOCKET`, `GRPC`, an address that is `ws://`, `wss://` or `grpc://`, and any method but GET, HEAD, OPTIONS,
  POST, PUT, PATCH and DELETE are listed and refused.
- **Dynamic variables.** `{{$uuid}}`, `{{$timestamp}}` and `{{$isoTimestamp}}` are made when the request is sent.
  - Any other (`{{$random.integer(1, 10)}}`, `{{$env.USER}}`, `{{$auth.token(...)}}`) refuses the request.
  - So does a variable that needs another request's answer (`{{login.response.body.$.token}}`), and `<@ file`, which would fill
    variables into a file.
- Annotations such as `# @no-redirect`, `# @no-cookie-jar` and `# @timeout` change nothing: redirects are never followed, no
  cookies are kept, and the timeout is the call's.
