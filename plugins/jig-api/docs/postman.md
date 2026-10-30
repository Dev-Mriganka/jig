# Postman: what is read

How a Postman collection (format v2.1; v2.0 reads alike) and its environment files become saved requests. Back to the
[jig-api overview](../README.md).

```json
{ "postman": "~/work/billing.postman_collection.json",
  "environments": { "Staging": "~/work/billing-staging.postman_environment.json" } }
```

The environment's name is the one given here, not the `name` inside the file. The folder the collection file is in is the
**collection folder**: a file a request uploads must sit inside it (see [Safety](safety.md#files)). Nothing is read until a
call needs it, and the files are read again for every call, so an export that is replaced shows at once.

## Requests

| In the collection | In jig-api |
|---|---|
| Folders (`item` groups) | The folder path of each request, such as `Orders/Smoke`. They nest |
| `request.url`, a text or an object | The `raw` text if there is one, else the parts put together. A path variable (`/orders/:id`) takes the value its `url.variable` gives. A disabled query parameter is left out, and a `#fragment` is dropped |
| `header` | The enabled headers. A body adds the `Content-Type` Postman sends for it, unless the request has one |
| Body, `raw` | Text. With the language JSON it is a JSON body; XML and HTML are written with escaping for the agent's values |
| Body, `urlencoded` | A URL-encoded form; disabled fields are left out |
| Body, `formdata` | A multipart form with text and file fields. A file field with no file chosen is left out, with a note |
| Body, `file` | The whole body is a file in the collection folder |
| Body, `graphql` | A `POST` of `{"query": ..., "variables": ...}` as JSON |
| `variable` of the collection | The collection's own values, the weakest |
| `variable` of a folder or a request | Values for the requests under it. The inner one wins |
| `description` | Shown by `show`, as text or as `{ content }` |

A request's variables are the `{{names}}` in its address, headers, body and sign-in. `{{$guid}}`, `{{$timestamp}}` and
`{{$isoTimestamp}}` are made when the request is sent (`$guid` is `$uuid`). Any other `{{$name}}`, such as `{{$randomInt}}`,
needs code and refuses the request.

## Sign-in

A request signs in as its own `auth` says, else as its folder's, else as the collection's.

| Type | Sent as |
|---|---|
| `noauth` | Nothing, whatever the folder or the collection says |
| `bearer` | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic`, built from the user name and the password |
| `apikey`, in a header | The key in the header it names |
| `oauth2`, `client_credentials` or `password_credentials` | A token from the access token address, sent as a Bearer token and kept until it expires. The client authentication is HTTP Basic, or the form when the file says `body` |
| `apikey` in the query string | **Refused.** An address ends up in logs; a key is sent in a header only |
| `oauth2` with any other grant, or the token in the query, or a prefix other than Bearer | **Refused**, naming the grant: the authorization code and the implicit grant need a browser |
| `awsv4`, `digest`, `hawk`, `ntlm`, `oauth1`, `edgegrid` | **Refused**, naming the type |

An access token pasted into the export is not used, and a warning names the file and the key.

## Environments

An environment file is `values` of `{ key, value, type, enabled }`. A value that is not enabled is not a value. A variable of
the type `secret` is a secret: it comes from `api.secrets` and from nowhere else. If the file also holds a value for it, the
value is **refused**: it is not kept, never sent, and a warning names the file and the variable
(`acme-production.postman_environment.json token: is a secret with a value in the file ...`). `list` and `show` print the
warnings, and the warning never repeats the value.

## Scripts and protocols

- A **pre-request script** of the request, of a folder above it or of the collection refuses the request. The refusal names the
  request and whose script it is. An empty or disabled script is none.
- A **test script** is ignored, with a note.
- A request whose address is `ws://`, `wss://`, `grpc://` or `mqtt://`, whose method is not HTTP, or whose
  `protocolProfileBehavior` names a protocol that is not HTTP is listed and refused as unsupported.
  `followRedirects` and `strictSSL: false` are ignored with a note: redirects are never followed and certificates are always
  checked.

## Problems

A file that cannot be read or understood is a problem with its **file** and its **key**, such as `item[3].request.auth`, and the
rest of the collection still loads. `list` prints the problems under their collection. A request the tool cannot send is still
listed, with the reason, so that nobody wonders where it went.
