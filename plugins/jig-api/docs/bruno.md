# Bruno: what is read

How a Bruno collection, kept as a folder in git, becomes saved requests. Back to the [jig-api overview](../README.md).

```json
{ "bruno": "~/work/orders-api/bruno" }
```

The folder is the **collection folder**: a file a request uploads must sit inside it (see [Safety](safety.md#files)). The files
are read again for every call.

## Which format

The root file decides, and only the files of that format are read.

| Root file | Format | Request files | Folder files | Environments |
|---|---|---|---|---|
| `opencollection.yml` | OpenCollection YAML, the default of a new collection since Bruno 3.1 | `*.yml` | `folder.yml` | `environments/*.yml` |
| `bruno.json` | The `.bru` language | `*.bru` | `folder.bru`, and `collection.bru` at the root | `environments/*.bru` |

A folder with neither is a problem. Hidden folders, `node_modules`, links and the folders that `bruno.json` (`ignore`) or
`extensions.bruno.ignore` of the YAML file name are not read. A YAML collection may also hold its folders and requests inline,
under `items:` of the root file. Requests are in Bruno's order: by `seq`, then by name; a folder sorts among the requests by its own `seq`.

## Requests

| In Bruno | In jig-api |
|---|---|
| Folders | The folder path of each request, named as the folder file names it, such as `Partner/Nested` |
| HTTP and GraphQL requests | A request. A GraphQL request is a `POST` of `{"query": ..., "variables": ...}` |
| The address | As written, with a `#fragment` dropped. `:id` takes the value of its path parameter, or becomes a variable `{{id}}` when the file gives none |
| Query parameters | They are the address's query string, as Bruno keeps them there |
| Headers | The collection's, then the folder's, then the request's. A request's replaces the same header above it, whatever the case |
| Body: JSON, text, XML | Raw text, written with escaping for the agent's values; Bruno's content type is added |
| Body: form-urlencoded, multipart | Forms. A multipart value `@file(a\|b)` is files, with `@contentType(...)` kept |
| Body: file | The whole body is a file |
| `docs` | Shown by `show` |
| Switched off (`~` in `.bru`, `disabled: true` in YAML) | Left out |

A body of the type `sparql` is refused. `{{$guid}}`, `{{$timestamp}}` and `{{$isoTimestamp}}` are made when the request is sent;
any other `{{$name}}`, such as `{{$randomInt}}`, refuses the request.

## Variables

The collection's `vars:pre-request` are its own values, the weakest. A folder's and a request's are values for the requests below
them. A name that starts with `@` is local to the request, and the `@` is dropped. The values are text: Bruno allows a JavaScript
literal there, and nothing is evaluated. The environment's values win over all of these ([Variables](variables.md)).

## Sign-in

A request signs in as its own `auth` says. `auth: inherit` takes the nearest folder that sets a sign-in, else the collection's.
A request without an `auth` has none. A folder whose sign-in is `none` or `inherit` leaves the one above in force.

| Bruno | Sent as |
|---|---|
| `bearer`, `basic` | A Bearer token, HTTP Basic |
| `apikey`, placed in the header | The key in the header it names |
| `oauth2`, `client_credentials` or `password` | A token from the access token address, sent as a Bearer token ([Sign-in](auth.md)). The client signs in with HTTP Basic when the file says `basic_auth_header`, else in the form, which is Bruno's own default |
| `apikey` in the query string, or `oauth2` with the token in the query string or a prefix other than Bearer | **Refused** |
| `oauth2` with `authorization_code`, `implicit` or another grant | **Refused**, naming the grant: they need a browser |
| `digest`, `ntlm`, `awsv4`, `oauth1`, `wsse`, `akamai-edgegrid` | **Refused**, naming the type |

A refusal in a folder refuses only the requests that inherit it. The additional parameters of an OAuth token request are not sent,
with a note.

## Secrets and environments

An environment is `environments/<name>`: the name is the `name:` of a YAML file, else the file's. Its variables are `vars { }` in
`.bru` and `variables:` in YAML. `extends` takes the variables of another environment first.

- **Secret.** A name in `vars:secret [ ]` (`.bru`) or with `secret: true` (YAML) is a secret: it comes from `api.secrets` and from
  nowhere else. A value written for it in a file is **refused**: not kept, never sent, and a warning names the file and the variable.
  The same name in `vars` and in `vars:secret` is such a value.
- **Secret managers.** A variable of `vars:externalsecrets:<manager>` or `externalSecrets:` is a secret, and is not fetched from the
  manager: give it in `api.secrets`. A warning says so.
- **`{{process.env.NAME}}`** is a secret, in a request and inside the value of another variable. Bruno reads it from a `.env` file;
  no `.env` file is ever read here. Give it in `api.secrets` under that exact name: `"process.env.NAME": "pass:work/name"`.
  `dotEnvFilePath` is ignored, with a warning.

## Scripts, asserts and protocols

- A **pre-request script** (`script:pre-request`, `before-request`, `hooks`, or an action that runs before the request) of the
  request, of a folder above it or of the collection refuses the request, naming whose it is.
- A **post-response script**, **tests**, **post-response variables** and a `followRedirects` setting are ignored, with a note.
- **Asserts** are read and shown by `show` as `expression operator value`. Nothing checks them yet.
- WebSocket and gRPC requests are listed and refused as unsupported, as are methods other than `GET`, `HEAD`, `OPTIONS`, `POST`,
  `PUT`, `PATCH` and `DELETE`.

## Problems

A file that cannot be read is a problem with its **file** and its **key** (`line 12` for YAML and `.bru` syntax), and the rest of
the collection loads. A message never quotes the file: a line of an environment may hold a secret. A file over 1 MiB is refused, and
at most 1000 request files, 12 folders deep, are read.
