# Connections

The `mongo` section, the routes to a database, and how connections are kept. Back to the [jig-mongo overview](../README.md).

## The section

`connections` is by environment name, as `jig-core` names it. The name decides the rules: `jig-core` says whether it is a test
environment or production, and a name nobody defined counts as production. A connection named `local` or `external` is refused: a
database is a test or production environment, so define one in the `environments` of `jig.json` and use its name.

| Field | |
|---|---|
| `uri` | `mongodb://host:port[,host:port]/[database]?options` or `mongodb+srv://host/...`. **No user or password in it:** such a string is refused, and the message does not repeat it. Options that carry a credential (`password`, `tlsCertificateKeyFilePassword`, `authMechanismProperties`) or weaken TLS (`tlsInsecure`, `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`) are refused |
| `user` | The database user, in plain text. For production a read-only one |
| `password` | A secret reference such as `pass:mongo/staging`, resolved when a connection is opened and redacted from every result. A value that is not a reference is refused without being repeated |
| `authSource` | Optional: the database the user signs in to |
| `tls` | Optional: `true` or `false`. Certificates and host names are always checked |
| `via` | Optional route: `ssh` or `tunnel` |

`access` is described in [Access](access.md). An environment with no `access` entry has the default of its kind: a deny list with
nothing on it in a test environment, an allow list with nothing on it (so nothing is readable) in production.

## The SSH route

```json
"via": { "ssh": { "host": "bastion.example.com", "user": "agent", "key": "pass:ssh/bastion", "port": 22 } }
```

The database must be given as one `mongodb://host:port` address: a forward reaches one host, so a list of replica set members or a
`mongodb+srv` address is refused with a route. The tool starts an SSH local forward with `jig-core`'s `exec.run`, which runs a
program from an argument list and never through a shell:

```text
ssh -N -L 127.0.0.1:<free port>:<db host>:<db port> -i <key file> -F /dev/null
    -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o BatchMode=yes -o StrictHostKeyChecking=yes
    -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 [-p <port>] <user>@<host>
```

- `host` and `user` are checked to be plain words, so neither can be read by ssh as an option. `-F /dev/null` leaves out the ssh
  configuration files, so a file that the agent can write cannot add a command to run. `StrictHostKeyChecking=yes` and `BatchMode=yes`
  mean an unknown host key fails the call instead of asking: connect to the bastion once with ssh yourself to add it to `known_hosts`.
- **The key** is resolved from its reference and written to a file of mode 0600 in a new folder of mode 0700. It is deleted as soon as
  the forward accepts connections (ssh has signed in by then) and when anything fails. It is never on a command line.
- The driver then connects to `127.0.0.1:<port>` with `directConnection`, and the certificate is still checked against the database's
  own host name, as the driver does with `servername`.
- The forward lives with the connection and stops when it is closed, when the call that started it is cancelled, and when Pi ends.
- Each failure of ssh is one line: host key not trusted, key refused, key unreadable, bastion unreachable, or a general failure with
  ssh's exit code. ssh's own text is not repeated.

## The tunnel route

`"via": { "tunnel": "corp-net" }` is accepted, for a company plugin that provides a tunnel by name. `jig-core` has no registry of
tunnels yet, so such a call fails with `no tunnel provider is registered: the route "corp-net" needs a company plugin that provides it`.

## How connections are kept

One connection and one forward per environment, opened by the first call that needs them, reused by the calls that follow, closed
after five idle minutes and when the session ends. A start that fails is not kept. A connection that failed in use is dropped, and the
next call opens a new one. Production reads come from a secondary when there is one (`secondaryPreferred`). Retries of the driver are
off. Each call has 90 seconds in all, and a server time limit `maxTimeMS` (default 10 seconds, at most 60).

## What the model is told when a call fails

One line, with the call named. A test environment gets the server's own words for an error the tool has no wording for, cut to 160
characters. **Production never does:** a server's text can echo a value.
