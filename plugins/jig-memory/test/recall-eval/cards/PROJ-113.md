---
ticket: "PROJ-113"
closedAt: "2026-05-28T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "OrderSearchService"
  - "GET /orders"
errors: []
---

## Problem
Searching orders sorted by creation date skipped some orders when moving to the next page.

## Cause
Many orders share one creation timestamp, and the sort had no tie-breaker, so the database returned them in a changing order.

## Fix
The sort adds the order id as the second key. A test pages through 500 orders created in the same second.
