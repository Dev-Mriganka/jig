---
ticket: "PROJ-107"
closedAt: "2026-04-16T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "V42__add_status_column"
  - "FlywayException"
errors:
  - "FlywayException: Migration V42__add_status_column failed: lock timeout exceeded"
---

## Problem
A database migration that adds a column to the orders table failed on a production-sized copy with a lock timeout.

## Cause
The migration rewrote the whole table in one statement and held the lock for minutes.

## Fix
The column is added as nullable, filled in batches of 10,000 rows by a job, and made required in a later migration.
