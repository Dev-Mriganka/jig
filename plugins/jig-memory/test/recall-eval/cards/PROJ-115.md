---
ticket: "PROJ-115"
closedAt: "2026-06-11T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "ORDERS_DB_URL"
  - "IllegalStateException"
errors:
  - "IllegalStateException: Missing required property ORDERS_DB_URL"
---

## Problem
After a configuration change the pods restarted in a loop and never became ready.

## Cause
The new chart renamed the database variable, and the application still read ORDERS_DB_URL, which was no longer set.

## Fix
The variable keeps its old name in the chart, and startup reports every missing property at once.
