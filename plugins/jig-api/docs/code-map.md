# jig-api: code map

Every file of `src/`, what it does and who calls it, and then one real call, `api run` of a saved request, followed
through the files. Read it with the code open. Back to the [jig-api overview](../README.md).

## The files

The plugin reads your collections into one list of saved requests (`sources/`), plans a request from a saved one
(`planning.ts`), and sends the plan through `jig-core` (`engine/`). A test (`plugins/jig-core/test/code-maps.test.ts`)
fails when a file of `src/` is missing here or a file listed here is gone, so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: registers the `api` section, the tool's declaration, the tool and `/api refresh` | Pi, which loads it |

### The tool and its commands

| File | What it does | Called by |
|---|---|---|
| `tool.ts` | The `api` tool: classify and preview a call, run `list`, `show`, `run`, `run-folder`, `call` | `index.ts`, `refresh.ts` |
| `params.ts` | The parameters, as one flat object; the action list, usage lines and checks all come from one table | `tool.ts` |
| `ad-hoc.ts` | The checks on an ad-hoc `call`, the one request the agent writes itself | `planning.ts` |
| `show.ts` | What `list` and `show` print: the saved requests, and one request in full | `tool.ts` |
| `refresh.ts` | `/api refresh`: fetches Postman cloud collections to their local copy | `index.ts` |

### Planning a request

| File | What it does | Called by |
|---|---|---|
| `planning.ts` | From a saved request, an environment and the agent's values to the plan; every refusal lives here | `tool.ts` |
| `resolve.ts` | Fills `{{variables}}` in a fixed order; what the agent gives is written so it stays a value | `planning.ts`, `show.ts` |
| `optional.ts` | Leaves out a query pair, header or JSON property whose optional variable nobody gave | `planning.ts` |
| `template.ts` | Finding `{{name}}` variables in a text, and telling the generated ones from the rest | `resolve.ts`, `sources/bruno-request.ts` and 4 more |
| `catalog.ts` | The collections as configured, and how a call finds a request, a folder or an environment | `planning.ts`, `show.ts`, `tool.ts` |

### The model and the configuration

| File | What it does | Called by |
|---|---|---|
| `model.ts` | What every source turns its files into: requests, environments, problems. No file format here | `catalog.ts`, `planning.ts`, `resolve.ts` and every source |
| `config.ts` | The `api` section of `jig.json`: collections, environment mapping, secrets, switches | `ad-hoc.ts`, `catalog.ts` and 7 more |
| `reference.ts` | What a secret reference looks like, and a refusal for a pasted token | `config.ts`, `sources/postman-cloud.ts` |

### The engine (engine/)

| File | What it does | Called by |
|---|---|---|
| `engine/plan.ts` | A plan: what one request will send, with a fingerprint of everything you are shown | `engine/http.ts`, `engine/preview.ts` and 7 more |
| `engine/preview.ts` | What you read before a request that asks: the method, address, headers, body, sign-in by name | `tool.ts` |
| `engine/text.ts` | Text not all known yet: secrets, generated values and file bytes filled in only when it is sent | `engine/http.ts`, `engine/plan.ts` and 4 more |
| `engine/http.ts` | Sends a plan: fills the pieces, reads the credential, makes the exchange, scrubs the answer | `engine/render.ts`, `refresh.ts` and 2 more |
| `engine/wire.ts` | One exchange through `jig().http.request`, and what each way it can end means | `engine/http.ts`, `engine/render.ts` and 3 more |
| `engine/address.ts` | Which addresses may never be called, checked for every request whatever the configuration says | `engine/http.ts`, `engine/wire.ts`, `planning.ts` |
| `engine/render.ts` | What the model reads of an answer: a status line, a few headers, the body | `engine/preview.ts`, `tool.ts` |
| `engine/scrub.ts` | Removes from an answer what this plugin sent, so a server that echoes it leaks nothing | `engine/http.ts` |
| `engine/json.ts` | Re-indents JSON without reading its numbers, so a long id stays exact | `engine/preview.ts`, `engine/render.ts` |
| `engine/values.ts` | The invalid-input error and ways to put a value into a message | almost every file |

### Sources: the adapters (sources/)

| File | What it does | Called by |
|---|---|---|
| `sources/source.ts` | The interface every source implements: a name, a check of its configuration, a `load` | `config.ts`, `sources/bruno.ts` and 5 more |
| `sources/index.ts` | The sources there are; adding one is adding its file here | `config.ts` |
| `sources/postman.ts` | Postman: a collection exported as JSON, and environments exported beside it | `sources/index.ts`, `sources/postman-cloud.ts` |
| `sources/postman-request.ts` | One Postman item read as a saved request, and the walk of folders that finds them | `sources/postman.ts` |
| `sources/postman-auth.ts` | Postman `auth` blocks, for the sign-ins that need no browser | `sources/postman-request.ts`, `sources/postman.ts` |
| `sources/postman-body.ts` | A Postman request body read as a body with its content type | `sources/postman-request.ts` |
| `sources/postman-values.ts` | The small readers every Postman part uses: text, descriptions, key-value lists | `sources/postman-auth.ts`, `sources/postman-body.ts` and 2 more |
| `sources/postman-cloud.ts` | A Postman workspace fetched with an API key to a local copy that is read like an export | `sources/index.ts` |
| `sources/http-file.ts` | `.http` files of JetBrains, VS Code and Visual Studio kept in a folder in git | `sources/index.ts` |
| `sources/bruno.ts` | Bruno: checks the configuration and loads a collection folder, in either of Bruno's formats | `sources/index.ts` |
| `sources/bruno-tree.ts` | The folder as a tree of requests and folders, put in Bruno's order and built level by level | `sources/bruno.ts` |
| `sources/bruno-request.ts` | One Bruno request as a saved request, with what the folders above it set | `sources/bruno-tree.ts`, `sources/bruno.ts` |
| `sources/bruno-environments.ts` | Bruno environments: files read, `extends` merged, secrets turned into names with no value | `sources/bruno.ts` |
| `sources/bruno-reading.ts` | What reading a Bruno folder keeps track of, and the helpers every part uses | `sources/bruno-environments.ts`, `sources/bruno-request.ts` and 2 more |
| `sources/bruno-bru.ts` | The `.bru` language, read for what this plugin uses | `sources/bruno-environments.ts`, `sources/bruno-tree.ts` |
| `sources/bruno-yaml.ts` | Bruno's OpenCollection YAML, read for what this plugin uses | `sources/bruno-environments.ts`, `sources/bruno-tree.ts`, `sources/bruno.ts` |
| `sources/bruno-types.ts` | What a Bruno file says, in one shape whichever language it was written in | `sources/bruno-bru.ts`, `sources/bruno-environments.ts` and 4 more |
| `sources/openapi.ts` | OpenAPI: checks the configuration and loads a spec as saved requests, opt-in and held tighter | `sources/index.ts` |
| `sources/openapi-spec.ts` | The spec document as data: read as JSON or YAML, `$ref`s followed inside it | `sources/openapi-operation.ts`, `sources/openapi-security.ts`, `sources/openapi.ts` |
| `sources/openapi-security.ts` | Security schemes: which can be sent, which slots they fill, which a request's requirements mean | `sources/openapi-operation.ts`, `sources/openapi.ts` |
| `sources/openapi-operation.ts` | One operation as a saved request: parameters, JSON body, address, sign-in, refusals | `sources/openapi.ts` |
| `sources/openapi-body.ts` | A JSON body described by a schema, as a template with one variable per value | `sources/openapi-operation.ts`, `sources/openapi-spec.ts` |

### Sources: shared (sources/)

| File | What it does | Called by |
|---|---|---|
| `sources/files.ts` | Reading files for the sources, and keeping a file reference inside its collection's folder | `planning.ts`, `sources/bruno-environments.ts` and 8 more |
| `sources/texts.ts` | The texts of a request in which a `{{variable}}` may stand | `sources/bruno-request.ts`, `sources/openapi-operation.ts`, `sources/postman-request.ts` |
| `sources/yaml.ts` | Reading YAML for the sources that need it; a bad file is a problem, never quoted | `sources/bruno-environments.ts`, `sources/bruno-tree.ts` and 2 more |
| `state.ts` | Where jig-api keeps what it fetches: the `api/` folder under jig-core's state folder | `sources/postman-cloud.ts` |

## How a call flows: `api run` of a saved request

The agent runs your saved **Create order** (a `POST`) in `staging`, giving `orderId=123`. A saved **Get order** takes
the same path, except that a read does not ask (steps 3 and 4).

1. **Reading the call.** `jig-core` calls `classify` in `tool.ts`. It parses the input with `parseCall` in
   `params.ts`, and loads the settings with `settingsOf` in `config.ts`.
2. **Finding the request.** `contextOf` builds the catalog (`catalog.ts`), which loads each configured collection by
   calling its source: for a Postman export, `load` in `sources/postman.ts`, which walks the items with
   `sources/postman-request.ts` and returns the shapes of `model.ts`. `catalog.request` finds the request by name.
3. **Planning.** `planRequest` in `planning.ts` turns the saved request, the environment and your values into a
   plan. It refuses a request with a script or an unsupported feature, takes the agent's values with `agentValues`
   and fills the variables with `createResolver` (`resolve.ts`), leaves out optional parts nobody gave
   (`optional.ts`), pins the host to the environment's hosts and refuses blocked addresses
   (`engine/address.ts`), and picks the sign-in. A secret stays a reference, never a value.
4. **The class.** The plan is sealed with a fingerprint (`engine/plan.ts`). `classify` returns the request's name as
   the action, the environment as `jig-core` knows it, and `write` for a `POST` (a `GET` is a read unless the
   configuration lists it in `reads`, which `show.ts` checks).
5. **The question.** `jig-core` decides: a write to a test environment asks. It calls `preview` in `tool.ts`, which
   plans again and returns `previewOf` (`engine/preview.ts`): the method, the full address, the headers and the body,
   with secrets shown by the name of their variable. You answer `y` in Pi.
6. **The guard.** `execute` in `tool.ts` plans a third time and calls `guard`, which compares the fingerprint you
   approved with the plan now. If the collection changed meanwhile, nothing is sent.
7. **Sending.** `http.send` in `engine/http.ts` fills the plan's pieces: secrets are read through `jig().secrets`,
   generated values are made, files are read. A credential that is a reference goes to `jig-core` as one. Then
   `exchange` in `engine/wire.ts` checks the address once more and calls `jig().http.request`, where `jig-core` reads
   the credential, adds the sign-in, sends the request once and never follows a redirect.
8. **Scrubbing.** `engine/scrub.ts` removes from the answer every credential this plugin sent, in case the server echoes
   it. A non-2xx answer is a result, not an error.
9. **The text for the model.** `renderResult` in `engine/render.ts` writes the status line, a few headers and the
   body (`engine/json.ts` keeps long ids exact). `tool.ts` returns it with the status as a fact for the record.
10. **After the tool.** `jig-core`'s `tool_result` hook redacts, masks if the environment is production, and caps the
    text, and its record notes the call.

If the reply is lost (a timeout or a broken connection after the request left), `describeFailure` in `tool.ts`
reports the outcome as unknown for a write, and the request is never sent again.

Back to the [jig-api overview](../README.md).
