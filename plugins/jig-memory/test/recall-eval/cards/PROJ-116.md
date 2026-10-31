---
ticket: "PROJ-116"
closedAt: "2026-06-18T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "MdcTaskDecorator"
  - "CorrelationIdFilter"
errors: []
---

## Problem
Log lines written by background tasks had no correlation id, so a request could not be followed through them.

## Cause
The correlation id lives in the logging context of the request thread, and the task executor's threads never got a copy.

## Fix
MdcTaskDecorator copies the context into every task, and a test checks the id in an async method.
