# Later

What `jig-lens` does not do yet. Back to the [jig-lens overview](../README.md).

- **OpenTelemetry export to MLflow,** for trace waterfalls. Each call becomes an
  `execute_tool` span and each turn a `chat` span, grouped by session.
- **Datasette charts,** through `datasette-dashboards`.
- **What the summary and the dashboards do not show yet** is listed in
  [The summary](summary.md#not-shown-yet).

## The harness watching itself

![Codebase and runtime sensors feed the coding agent, and harness sensors built from your sessions and tickets feed you](../../../docs/img/harness-loop.svg)

*Sensors that run outside any one change, in [Böckeler's](https://martinfowler.com/articles/harness-engineering.html) layout, with a third row of our own: the harness watching itself. Codebase and runtime sensors feed the coding agent; harness sensors, built from the records and closed tickets, feed you, because changes to the harness are yours to approve.*
