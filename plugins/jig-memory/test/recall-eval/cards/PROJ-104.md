---
ticket: "PROJ-104"
closedAt: "2026-03-25T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "OrderRepositoryIT"
  - "TestContainersConfig"
  - "spring.datasource.url"
errors:
  - "FAILED OrderRepositoryIT.shouldSaveOrder - Connection refused"
---

## Problem
An integration test failed at random on CI with connection refused, and passed when rerun.

## Cause
Parallel jobs on one runner shared a fixed database port, so a second job started its container on a taken port.

## Fix
The container uses a random port, taken from the container itself, and every test class gets its own schema.
