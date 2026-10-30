# Safety: what the tool refuses, and why

The rules of the [overview](../README.md#rules) in detail. Every refusal here is invalid input: a `TypeError`, which `jig-core` takes
to mean that nobody should be asked, so the call is blocked with the reason. Nothing is sent.

## Hosts

An environment's hosts are the hosts that its addresses come to in it: for each address of the collection (and each token address
of a sign-in) whose host comes from a variable, the host that variable gives in that environment. So `{{baseUrl}}/orders` in
`Staging` is the host `baseUrl` has in `Staging`.

- A request whose final host is not one of its environment's hosts is refused, naming the host and the ones the environment has.
  A request with a host written out (`https://api.example.com/orders`) is allowed only if the environment holds the same host,
  and so is refused in every other environment. A request takes its host from its environment.
- An environment that gives no address a host from a variable has no hosts: nothing in it runs.
- The port is part of the host; case and a default port are not.
- A sign-in's token address is checked the same way before the client's secret or password is sent anywhere.
- An ad-hoc `call` goes only to a host of the environment it names (of the collection it names, if it names one).

## Addresses that are never called

| Address | Why |
|---|---|
| Link-local, `169.254.0.0/16` | Includes the metadata service of AWS, Azure, Google Cloud and DigitalOcean, and ECS task credentials |
| `fd00:ec2::254`, `100.100.100.200`, `192.0.0.192` | The metadata services of AWS over IPv6, Alibaba Cloud and Oracle Cloud |
| `metadata.google.internal`, `metadata.goog`, `metadata`, `instance-data` | The same services, by name |
| `fe80::/10`, and an IPv4 address written inside an IPv6 one | Link-local; the embedded address is checked |
| `localhost`, `127.0.0.1` | This machine: refused unless `allowPlainLocal` is true. Then `http` and `https` are allowed |
| Any other form of this machine: `127.0.0.2`, `[::1]`, `0.0.0.0`, `*.localhost` | Refused whatever the configuration says |
| `http://` to anything else | Everything is https |
| An address with a user name or a password | Refused |

The check reads the address as written (every spelling of an IPv4 address is read as the same address). A host name is not looked
up, so a name that points at a blocked address is not caught; the names an environment may use are the ones the team wrote in its
own files. The function that sends asks again for every request, whatever plan it was given.

## Redirects and cookies

A redirect is never followed, so a token or a signature cannot go to another host or in the clear; it comes back as a result with
its `location`. There is no cookie jar: a cookie a server sets is removed from the answer and is never sent back, though a
request may carry a `Cookie` header its collection gives it.

## Files

A file a request uploads (a form file, a whole body, a part of a multipart body) must resolve, after following links, to a path
inside the collection folder: the folder of a Postman collection file, or the `.http` folder. A path outside it, a link out of it
(to the file, or to a folder that holds it), a missing file, a folder, and a file over 10 MiB are refused with the reason. The file
is read when the plan is made; the preview names it with its size and a digest, and the digest is in the fingerprint, so a file
that changed while you read is "changed since the preview" and is not sent.

## Scripts and protocols

Scripts never run. A request that a pre-request script applies to is refused with its name and whose script it is. A test script or
a response handler is ignored with a note. WebSocket, gRPC and MQTT are listed and refused as unsupported, as are the sign-in types
that need a browser, code or another request's answer. Each is named, so a reader knows what is missing.

## The agent

The agent fills variables and nothing else. It cannot give a secret, a variable that signs in, a variable outside the request, or
any part of the host; it cannot choose the method or the headers of a saved request. Its values are written as values
([Variables](variables.md)). It can send an ad-hoc `call` only where the configuration lists the `jig-core` environment in
`adHoc`, never in an environment that is production (asked of `jig-core`, so a company's own name for it counts), and never in a
name that `api.environments` does not map, which counts as production. A name in `reads` cannot make `call` a read: only the
method does.

## Limits

A saved request's body is at most 1 MiB of text, or 20 MiB with files; a call's JSON body at most 256 KiB, with at most 10 headers;
an answer is cut at 2 MiB; a Postman collection file is at most 32 MiB and an environment export 2 MiB; a `.http` file and an
environment file of a `.http` folder at most 1 MiB; at most 500 `.http` files.
