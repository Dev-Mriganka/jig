# Starting Grafana

What `/lens grafana` does, step by step. Back to the
[jig-lens overview](../README.md). `/lens datasette` does the same for
Datasette.

1. **It imports new lines,** so the dashboards have the records when they open.
2. **It asks first** whether something answers on the port. If something does
   that is not the viewer, it says so and stops. If the viewer already answers,
   it does not start another.
3. **It finds the program.** Grafana: `grafana`, else `grafana-server`, on `PATH`
   (only in absolute folders). Datasette: `datasette`. It starts the program
   detached, with a short environment (see [Viewer settings](viewer-settings.md)).
   When Grafana's home folder is beside the program, or in `share/grafana`, it
   passes `--homepath`; a packaged install's wrapper does that itself.
4. **It waits up to a minute** for the viewer to answer, which Grafana's first
   start can need on a busy machine, and says when the program stops at once or
   never answers. What it printed is in `viewer.log`.
5. **It opens the page** through `$BROWSER`, else `xdg-open`, else `open` on
   macOS, and otherwise gives the address. Grafana: `/d/jig-overview`.
   Datasette: its page for the index (`/index`).
6. **On the first start of Grafana** it says to sign in as `admin` and choose a
   new password at once (see [Viewer settings](viewer-settings.md)), and what to
   do if the dashboards report that the data source plugin is missing.

**Without the program** it says how to install it and mentions the other
viewer. For Grafana that is the plugin as well:
`grafana cli plugins install frser-sqlite-datasource`. See
[Grafana and Datasette](viewers.md#what-to-install).
