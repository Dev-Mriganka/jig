# Viewer settings

How `jig-lens` runs Grafana and Datasette, and why. Back to the
[jig-lens overview](../README.md). Only the port is yours to set (see
Configure there); everything here is fixed.

## Grafana

Grafana runs with:
- `127.0.0.1` only, on the port from configuration;
- usage reports, update checks, plugin update checks and feedback links
  switched off (Grafana's `[analytics]` settings). The news feed, the avatar
  lookup and the download of preinstalled apps are off too, because a default
  Grafana 13 fetches them from the internet;
- its sign-in on and anonymous access off. On first start you sign in as
  `admin`, whose initial password is `admin`, and Grafana asks you to set a new
  one; do not skip that step. Until you do, any program on the machine can sign
  in. Jig never sets or stores it, and `/lens grafana` says so the first time;
- one data source, which opens only the index, read-only (`mode=ro`);
- dashboards that the browser cannot save over. Save a copy under another name
  to keep a change;
- a short environment: `PATH`, `HOME` and the like, not Pi's. An API key, or a
  `GF_` setting such as an admin password, in the shell does not reach it.

Installing the plugin contacts grafana.com once. After that, nothing leaves the
machine.

## Datasette

Datasette, as the fallback, runs with arbitrary SQL turned off
(`allow_sql: false`), so the page runs only the queries kept in this plugin and
its own table pages. It gets the same short environment.

## Why the sign-in stays on

The agent's shell can reach `127.0.0.1`; that is also why approvals never
happen in the browser. Anyone who can query a Grafana data source can send it
any SQL, and SQLite's `ATTACH` opens other database files that Grafana can read.
Open access would let the agent read, through Grafana, files that the sandbox
hides from it.

## One port

Both viewers use the one port, from the `port` setting. When something else
answers on it, `/lens grafana` and `/lens datasette` say so and stop. Grafana and
Datasette share it, so stop one before starting the other, or choose another
port.

## The `viewer` setting is gone

The `lens` section of `jig.json` used to have a `viewer` field, `grafana` or
`datasette`, which chose the program `/lens` started. The command names the
viewer now (`/lens grafana`, `/lens datasette`), and nothing else needed the
setting, so it was removed. Only `port` is left.

A `viewer` left in `jig.json` is reported as a mistake that says what replaced
it:

```text
lens.viewer: removed, because /lens grafana and /lens datasette choose the viewer; delete it
```

Until it is deleted, `jig-core` ignores the whole `lens` section, so `port` is
back to its default, 3300.
