---
ticket: "PROJ-105"
closedAt: "2026-04-02T10:00:00.000Z"
repositories:
  - "orders-api"
keys:
  - "PROJ-88"
identifiers:
  - "InventoryClient"
  - "SocketTimeoutException"
  - "inventory.client.timeout-ms"
  - "504 /inventory/{id}/reserve"
errors:
  - "java.net.SocketTimeoutException: Read timed out"
---

## Problem
Reserving stock failed with 504 during the Monday peak, when the inventory service answered slowly.

## Cause
InventoryClient waited with the default read timeout of two seconds and had no limit on concurrent calls.

## Fix
The timeout is set with inventory.client.timeout-ms to five seconds, and a circuit breaker opens after ten failures.
