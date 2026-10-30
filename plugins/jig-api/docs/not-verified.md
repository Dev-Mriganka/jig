# Not verified yet

What the tests of `jig-api` do not cover, and the facts that the sources were written from. Back to the [jig-api overview](../README.md).

Written from the formats' documentation and fake services on this machine, over plain `http` through `allowPlainLocal`. Not tried
against a real service:

- **Real exports.** The fixtures are written from documentation:
  - Postman: the v2.1 schema and the documentation of the environment export;
  - `.http`: the JetBrains and VS Code documentation;
  - Bruno: Bruno's documentation, its source and the OpenCollection schema;
  - OpenAPI: the specification.

  None was exported from Postman, IntelliJ, VS Code or Bruno, or taken from a service, so a detail those tools add (an old
  export's quirks, a dialect extension, a newer Bruno field) may be read differently. A file the tool cannot read is a problem with
  its file and key, not a crash.
- **How Postman writes WebSocket and gRPC requests** into a collection file. Such a request is refused by its address scheme, its
  method or a protocol profile that names a protocol; a form this does not recognise would be refused later, as an address that is not
  http(s).
- **Bruno details inferred, not read from a rule:**
  - that a folder whose sign-in is `none` leaves the one above in force (Bruno's page says a request "inherits from that folder
    (or a parent folder higher up)" and "if no folder auth is set, from the collection");
  - the order of requests and folders sorted together by `seq`;
  - `hooks` scripts, which are treated as running before the request;
  - `credentials_placement` defaulting to the form when the file says nothing;
  - what `extends` does when a variable is secret in one environment and plain in the other (it stays secret).
- **The Bruno YAML token placement.** The schema calls `tokenConfig.placement.header` a header name, and Bruno's own reader keeps the
  prefix (`Bearer`) there. Both `Bearer` and `Authorization` are accepted; anything else refuses the request.
- **The Postman cloud against the real API.** The fetch was tried against a fake of it. The real answers were read from the
  reference:
  - a collection comes as `{ "collection": ... }` in the v2.1 format;
  - an environment comes as `{ "environment": { "values": [...] } }`;
  - a secret variable of an environment may hold no value, a masked one or a real one.

  A collection in Postman's newer git-native format is not read.
- **The Postman host.** The reference lists `https://api.postman.com` as the default and `https://api.eu.postman.com`; the older
  `api.getpostman.com` is not used.
- **Large spec files and collections:** reading is done on every call, and was only tried on fixtures of a few dozen requests.
- TLS to a real host, including a company certificate authority;
- a real OAuth server: whether it takes the client's id and secret as Basic credentials, and the shape of its errors;
- a real sign-in service and transport, which are company code;
- host names that point at a blocked address: names are not looked up (see [Safety](safety.md#addresses-that-are-never-called));
- the review screen: the preview was checked as data, against a fake of `jig-core`, and not seen in the terminal;
- the `/api refresh` screen: the command was run against a fake of Pi's command context, and not typed in the terminal.

## Facts the sources rely on

- `.bru` has dictionary, text and array blocks; a `~` before a key switches the line off ([source](https://docs.usebruno.com/bru-lang/language))
- The block names: `meta`, the verbs, `params:query`, `params:path`, `headers`, `body:json`, `body:text`, `body:xml`, `body:form-urlencoded`, `body:multipart-form`, `body:graphql`, `body:graphql:vars`, `vars:pre-request`, `vars:post-response`, `script:pre-request`, `script:post-response`, `tests`, `docs` ([source](https://docs.usebruno.com/bru-lang/tag-reference))
- The `.bru` details that its documentation does not spell out:
  - a block ends at a `}` in the first column;
  - text blocks are indented by two spaces;
  - a value in `'''` is indented by four;
  - the `auth:*` blocks and their fields;
  - `body:file`;
  - `@file(...)` and `@contentType(...)` in a value;
  - `auth { mode }` in `collection.bru` and `folder.bru`;
  - `vars:secret [...]`, `vars:externalsecrets:<manager>` and `extends` in an environment.
  - Source: Bruno's own readers, which its documentation does not spell out: https://github.com/usebruno/bruno/tree/main/packages/bruno-lang/v2/src (`bruToJson.js`, `collectionBruToJson.js`, `envToJson.js`)
- `vars:secret` lists names only, and Bruno keeps the values out of the file ([source](https://docs.usebruno.com/secrets-management/secret-variables))
- `{{process.env.NAME}}` reads a `.env` file of the collection ([source 1](https://docs.usebruno.com/variables/process-env), [source 2](https://docs.usebruno.com/secrets-management/dotenv-file))
- A request set to Inherit takes the nearest folder's sign-in, else the collection's ([source](https://docs.usebruno.com/auth/overview))
- The OAuth 2.0 client-credentials fields: access token URL, client id and secret, scope, credentials placement (body or Basic header), token in a header or the URL ([source](https://docs.usebruno.com/auth/oauth2-2.0/client-credentials))
- Pre-request variables are strings, numbers or JavaScript literals; post-response variables are expressions of `res` ([source](https://docs.usebruno.com/testing/script/vars))
- Assertions are an expression, an operator and a value ([source](https://docs.usebruno.com/testing/tests/assertions))
- OpenCollection YAML: `opencollection.yml`, `folder.yml`, `environments/*.yml`, one request per file ([source](https://docs.usebruno.com/opencollection-yaml/overview))
- A request file is `info`, `http` (`method`, `url`, `headers`, `params` with `type: query` or `path`, `body`, `auth`), `runtime` (`variables`, `scripts` of type `before-request`, `after-response`, `tests`, `assertions`) and `settings`; the body types; the auth types ([source 1](https://docs.usebruno.com/opencollection-yaml/structure-reference), [source 2](https://docs.usebruno.com/opencollection-yaml/samples))
- The OpenCollection schema:
  - auth fields beside `type`;
  - OAuth 2.0 `flow` (`client_credentials`, `resource_owner_password_credentials`, `authorization_code`, `implicit`), `credentials`, `resourceOwner`, `tokenConfig`;
  - an environment's `variables` with `{ secret: true }` for a secret, `externalSecrets`, `extends`, `dotEnvFilePath`;
  - script types including `hooks`;
  - actions with a `phase`;
  - `graphql`, `websocket` and `grpc` requests ([source](https://github.com/opencollection-dev/opencollection/blob/main/packages/oc-schema/src/opencollection.schema.json))
- How Bruno reads the YAML of an environment, a folder and the collection (`name`, `info.seq`, `request`, `extensions.bruno.ignore`) ([source](https://github.com/usebruno/bruno/tree/main/packages/bruno-filestore/src/formats/yml))
- A server's `url` may be relative and hold `{variables}` with defaults ([source](https://spec.openapis.org/oas/v3.1.0#server-object))
- A header parameter named `Accept`, `Content-Type` or `Authorization` is ignored; a path parameter is required; a parameter has a `name`, an `in` (`query`, `header`, `path`, `cookie`), a `schema` or `content` ([source](https://spec.openapis.org/oas/v3.1.0#parameter-object))
- An `operationId` is unique among the operations and case-sensitive ([source](https://spec.openapis.org/oas/v3.1.0#operation-object))
- The request body has `content` by media type, and `required` ([source](https://spec.openapis.org/oas/v3.1.0#request-body-object))
- Security schemes: `apiKey` (`in`: query, header, cookie), `http` (`scheme`), `oauth2` with the flows `implicit`, `password`, `clientCredentials`, `authorizationCode`, `openIdConnect`, `mutualTLS`;
  - a list of requirements needs one of them, the schemes of one requirement all, and `{}` makes security optional;
  - an operation's `security` replaces the spec's ([source 1](https://spec.openapis.org/oas/v3.1.0#security-scheme-object), [source 2](https://spec.openapis.org/oas/v3.1.0#security-requirement-object))
- OpenAPI 3.0 has the same objects, with `nullable` and a single `type` ([source](https://spec.openapis.org/oas/v3.0.3))
- The Postman API takes the key in the `X-API-Key` header of every request; a collection access key is read-only and for one collection ([source](https://learning.postman.com/docs/developer/postman-api/authentication/))
- `GET /collections/{collectionId}` returns `{ "collection": ... }` in the collection format v2.1; `access_key` is a query parameter; the servers are `https://api.postman.com` and `https://api.eu.postman.com`; an unknown collection is a 400 ([source](https://learning.postman.com/api-docs/api-reference/collections/get-collection))
- `GET /environments/{environmentId}` returns `{ "environment": { "values": [{ "key", "value", "type": "secret" or "default", "secret", "source", "enabled" }] } }` ([source](https://learning.postman.com/api-docs/api-reference/environments/get-environment))
- The Postman API allows 300 requests a minute for a key ([source](https://learning.postman.com/docs/developer/postman-api/postman-api-rate-limits))
- A collection access key expires after 60 days without use ([source](https://learning.postman.com/api-docs/api-reference/collection-access-keys/get-collection-access-keys))
- `yaml` (ISC, no dependencies) parses YAML 1.2 without running anything, limits aliases and reports an error's code and position ([source](https://github.com/eemeli/yaml))
