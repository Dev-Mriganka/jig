# Secrets

Tools that need a password or token name it with a **reference**.
`jig-core` resolves the reference just before the tool runs. The value never
appears in:
- what the model sees;
- tool output;
- records or logs;
- command lines.

## References and backends

| Reference | Backend | Platforms | Status |
|---|---|---|---|
| `pass:work/jira-token` | [pass](https://www.passwordstore.org/), GPG-encrypted files | Linux, macOS (Homebrew) | first |
| `keychain:service/account` | macOS Keychain, through the `security` command | macOS | when needed |
| `op://vault/item/field` | 1Password CLI | Linux, macOS, Windows | when needed |
| `env:NAME` | an environment variable of the Pi process | any | when needed |

Only the backends in use are built. A new machine or employer means setting a
different reference, not changing tools.

**Jig will not build its own password manager.** A homemade password store is a
security liability, and every platform already has one with a command-line
interface.

## Rules

- **Only through `jig-core`:** a tool gets a secret by naming its reference.
  It never reads a password file itself.
- **Unlock once:** a locked store asks you to unlock it once, even when several
  calls need it at the same moment.
- **Remove on sight:** every resolved value is removed from all output before
  the model sees it.
- **Hidden from `bash`:** the secret stores themselves are hidden from the
  agent's shell by the sandbox.
- **Your own tools only:** tools from other packages keep their own credentials.
  `jig-core` can mask and record their calls, but not manage their secrets.

## Sign-in that a company provides

Some systems are not signed in to with a stored password. A single sign-on
gateway hands out a short-lived token that code has to fetch and renew. A
company plugin supplies that code as a **sign-in service**, and a tool asks for
the headers of one request by the service's name instead of naming a secret
reference.

The headers are treated like secrets: `jig-core` removes their values from
every result before the model sees it. See
[Sign-in services](../plugins/jig-core/README.md#sign-in-services).
