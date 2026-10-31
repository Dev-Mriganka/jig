---
ticket: "PROJ-124"
closedAt: "2026-08-13T10:00:00.000Z"
repositories:
  - "orders-api"
keys:
  - "PROJ-105"
identifiers:
  - "HikariPool"
  - "SQLTransientConnectionException"
  - "spring.datasource.hikari.maximum-pool-size"
errors:
  - "SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms"
---

## Problem
Requests hung for 30 seconds and then failed because no database connection was available.

## Cause
A report query never closed its result set when the file write failed, and each failure kept one connection for good.

## Fix
The query is in a try-with-resources block, the pool size stays at 20, and a leak warning is logged after 60 seconds.
