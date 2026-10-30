# Sign-in: the forms, and OAuth

How a request signs in, and what each form holds. Back to the [jig-api overview](../README.md).

A saved request signs in as its collection says (its own `auth`, its folder's, or the collection's; a `.http` request does it in a
header). The tool reads the secrets and builds the header, so the model never sees a credential. An environment can name a company
sign-in or transport that replaces this:

| Form | Signs in with | Where it comes from |
|---|---|---|
| none | Nothing | `noauth`, or no sign-in at all; Bruno `none`; an OpenAPI `security: []` |
| Bearer | `Authorization: Bearer <token>` | Postman and Bruno `bearer`; OpenAPI `http` `bearer`; a `.http` header |
| Basic | `Authorization: Basic <user:password>` | Postman, Bruno and OpenAPI `basic`; a `.http` `Basic user password` |
| API key | The key in the header the collection names | Postman and Bruno `apikey`, OpenAPI `apiKey`, in a header |
| OAuth | A token from the token address, sent as a Bearer token | Postman `oauth2`, Bruno `oauth2` and OpenAPI `oauth2`, `client_credentials` or the password grant |
| Sign-in service | The headers of the company service of that name, asked for again on every request | `"signIn"` in `api.environments` |
| Transport | The whole request goes through the company transport of that name | `"transport"` in `api.environments` |

```json
"environments": { "Staging": { "environment": "staging", "transport": "company-proxy" } }
```

A sign-in service or a transport replaces the request's own sign-in for every request in that environment, saved or ad hoc.

## Secrets

A credential is a variable like any other; the ones that are secrets come from `api.secrets` references (see
[Variables](variables.md#secrets)). A secret that cannot be read, or that holds a character a header cannot hold, stops the call before
anything is sent, for a write too, and the error does not repeat it. A `401` is an answer: the credential is not replaced and the call is
not sent again (except for a kept OAuth token, below). A header that the sign-in sets cannot also be given by the request: that is
checked when the call runs, before anything is sent
(`header Authorization is set by the sign-in, so the request cannot have it too`).

## A sign-in service

The service is asked for the headers of every request, by name, with the system `api:<collection>` and the full address, because it is
the one that knows when a token has expired. Its headers are sent, and the tool adds no authentication of its own. An unknown service,
or one that fails, stops the call before anything is sent.

## A transport

The whole request goes through the transport, with the system, the method, the full address, the headers and the body. The tool reads
no secret and adds no header. The answer is read as an HTTP answer: the status, the headers and a body as text, cut at 2 MiB. A
non-2xx answer is a result and a redirect is not followed. A transport carries `GET`, `POST`, `PUT`, `PATCH` and `DELETE` and a text
body: a `HEAD`, an `OPTIONS`, a file and a multipart form are refused before anything is sent. A transport that fails is reported in its own words, cut at 160
characters, and for a write the outcome is then unknown (see [Writes](writes.md#when-no-reply-comes)). A name that no company plugin
registered means that nothing was sent.

## OAuth without a browser

Bruno and OpenAPI say the same in their own words: `access_token_url` / `tokenUrl`, `client_id`, `client_secret`, `username`,
`password`, `scope`, and where the client signs in (`credentials_placement`: `basic_auth_header` or `body`; an OpenAPI client signs
in with HTTP Basic). The table is Postman's.

| Postman field | Meaning |
|---|---|
| `grant_type` | `client_credentials` or `password_credentials`. The authorization code and the implicit grant need a browser and refuse the request |
| `accessTokenUrl` | The token address, checked like the request's own: https, not a blocked address, one of the environment's hosts |
| `clientId`, `clientSecret` | The client. With a secret the client signs in with HTTP Basic (the id and the secret form-encoded, as RFC 6749 asks), or in the form when `client_authentication` is `body`. Without one, only the id is sent |
| `username`, `password` | The account, for the password grant |
| `scope` | Optional |

- **The grant.** The tool sends `grant_type` with the client (and the account), as a form. It accepts a `200` answer with an
  `access_token` of 1 to 8192 printable characters without a space, and sends it as a Bearer token. A token type other than `bearer` is
  refused. An answer of over 64 KiB is not read.
- **The token is kept in memory** until 60 seconds before its `expires_in`, which may be a number or text. A token that lives 60 seconds
  or less is never reused. Without an `expires_in`, or with one that is not a positive number, it is kept until a `401` says otherwise.
  It is kept per collection and environment, and dropped when the sign-in settings change: the address, the client id, any reference or
  the scope. The secrets are read only when a token is fetched. A failed sign-in keeps nothing, so the next call tries again.
- **A `401` for a kept token** gets one new token and one repeat of the call, even for a write: the server turned the request down
  before it ran. A `401` for a token just issued is the answer, with a note: "The server rejected a newly issued token: the account may
  lack access to this path." There is no third try. Only a `401` replaces a token: a `403` or a `500` does not.
- **The token is never written to disk, logged, shown or put in an error.** `jig-core` cannot hide it, because it did not resolve it, so
  the tool removes it from every answer itself (see [Results](results.md#what-is-removed)).
- **A sign-in that fails** means nothing was sent to the API, and says why in one line: the endpoint's status and the standard error
  code, never its own words, the account or the secrets. Only the codes of RFC 6749, section 5.2, are repeated. A redirect from the token
  endpoint is not followed, and secrets that cannot be read stop the sign-in before the endpoint is asked.
- **One deadline** covers the token request and the call together (see [Writes](writes.md#the-clock)).
