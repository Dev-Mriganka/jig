# Connections

The `mongo` section, the routes to a database, and how connections are kept. Back to the [jig-mongo overview](../README.md).

## The section

`connections` is by environment name, as `jig-core` names it. The name decides the rules: `jig-core` says whether it is a test
environment or production, and a name nobody defined counts as production.

A connection named `local` or `external` is refused: a database is a test or production environment, so define one in the
`environments` of `jig.json` and use its name.

| Field | |
|---|---|
| `uri` | `mongodb://host:port[,host:port]/[database]?options` or `mongodb+srv://host/...` |
| `user` | The database user: text, or a secret reference. A read-only one for production |
| `password` | A secret reference such as `pass:mongo/staging` |
| `authSource` | Optional: the database the user signs in to |
| `tls` | Optional: `true` or `false`. Certificates and host names are always checked |
| `via` | Optional route: `ssh` or `tunnel` |

- **`uri`:** no user or password in it. Such a string is refused, and the message does not repeat it. Options that carry a credential
  (`password`, `tlsCertificateKeyFilePassword`, `authMechanismProperties`) or weaken TLS (`tlsInsecure`,
  `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`) are refused.
- **`password`:** resolved when a connection is opened and redacted from every result. A value that is not a reference is refused
  without being repeated.
- **`user`:** a value that starts with the name of a secret backend and a colon (`pass:`, `env:`, `keychain:`, `op:`, `cmd:`,
  `file:`) is a reference, read when the connection opens and redacted like the password. Anything else is the user's name, as
  before.

## Several connections in one environment

A team may have two clusters in one environment, such as `orders` and `billing` in `staging`. Give `connections.<environment>` a map
of named connections instead of one connection:

```json
"connections": {
  "staging": {
    "orders":  { "uri": "mongodb://orders.staging.example.com:27017",  "user": "agent", "password": "pass:mongo/orders" },
    "billing": { "uri": "mongodb://billing.staging.example.com:27017", "user": "agent", "password": "pass:mongo/billing" }
  },
  "production": { "uri": "mongodb://db.example.com:27017", "user": "agent-readonly", "password": "pass:mongo/production" }
}
```

- **One form or the other,** per environment.
  - An object with `uri`, `user`, `password`, `authSource`, `tls` or `via` is one connection, as before.
  - Any other object is a map of names. A name is 1 to 40 letters, digits, `-` or `_`, and not `deny`, `allow` or `javascript`. An
    environment has at most ten.
- **The tool takes a `cluster` parameter** where an environment is a map, such as `{environment: "staging", cluster: "orders", ...}`.
  It is required there, and refused for an environment with one connection. The message lists the names.
- **The environment still decides the rules.** `jig-core` classifies the call by `environment`, so `staging` is a test environment
  and `production` is read-only, whatever the cluster.
- **Each connection is kept on its own,** with its own route, and a message names it as `staging/orders`.
- **Access lists are per cluster** ([Access](access.md#several-connections)).

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

- `host` and `user` are checked to be plain words, so neither can be read by ssh as an option.
- `-F /dev/null` leaves out the ssh configuration files, so a file that the agent can write cannot add a command to run.
- `StrictHostKeyChecking=yes` and `BatchMode=yes` mean an unknown host key fails the call instead of asking: connect to the bastion
  once with ssh yourself to add it to `known_hosts`.
- **The key** is resolved from its reference and written to a file of mode 0600 in a new folder of mode 0700. It is deleted as soon as
  the forward accepts connections (ssh has signed in by then) and when anything fails. It is never on a command line.
- The driver then connects to `127.0.0.1:<port>` with `directConnection`, and the certificate is still checked against the database's
  own host name, as the driver does with `servername`.
- The forward lives with the connection and stops when it is closed, when the call that started it is cancelled, and when Pi ends.
- Each failure of ssh is one line: host key not trusted, key refused, key unreadable, bastion unreachable, or a general failure with
  ssh's exit code. ssh's own text is not repeated.

## The tunnel route

`"via": { "tunnel": "corp-net" }` names a tunnel that a company plugin provides through `jig-core` (`tunnels.register`). The plugin
opens it for the database host, and it says what it is with its `kind`:

| `kind` | What the local port is | How the driver connects |
|---|---|---|
| `forward` (the default) | A port that reaches the one host and port of the `uri` | To `127.0.0.1:<port>`, with `directConnection`, as for an SSH forward |
| `socks` | A SOCKS5 proxy that reaches any host the far side can | To the real `uri`, with the driver's `proxyHost` and `proxyPort` |

- **A forward** reaches one host. A `uri` with a replica set list or `mongodb+srv`, with a forward, fails the call with a line that
  says so and offers a SOCKS proxy; the tunnel is closed.
- **A SOCKS proxy** is the way to a replica set or a `mongodb+srv` address: the driver discovers the members and reaches each one by
  its own name through the proxy, and the certificate of each is checked against its own host name.
  - **The provider is told the first host** of the `uri` and may ignore it: a proxy reaches whatever it is asked for.
  - **The driver needs the `socks` package** for this, which `jig-mongo` depends on.
  - **`mongodb+srv` addresses are looked up in this machine's DNS,** because the driver cannot send a DNS lookup through a proxy. The
    members that the lookup names are reached through the proxy.
- **No provider registered, or one that fails,** is a one-line failure that the user fixes: `no tunnel provider is registered`, or
  `the tunnel "corp-net" could not be opened: ...`. The database password is not read for a route that did not open.
- **The tunnel lives with the connection** and is closed when the connection is, once, even if the provider's `close` fails.

## How connections are kept

One connection and one route per connection (one per environment, or one per name where an environment has several), opened by the
first call that needs them, reused by the calls that follow, closed after five idle minutes and when the session ends.
- **A start that fails is not kept.** A connection that failed in use is dropped, and the next call opens a new one.
- **Production reads** come from a secondary when there is one (`secondaryPreferred`).
- **Retries of the driver are off.**
- **Time:** each call has 90 seconds in all, and a server time limit `maxTimeMS` (default 10 seconds, at most 60).

## What the model is told when a call fails

One line, with the call named. A test environment gets the server's own words for an error the tool has no wording for, cut to 160
characters. **Production never does:** a server's text can echo a value.
