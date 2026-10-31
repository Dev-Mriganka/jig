---
ticket: "PROJ-101"
closedAt: "2026-03-04T10:00:00.000Z"
repositories:
  - "orders-api"
keys:
  - "PROJ-64"
identifiers:
  - "OrderMapper"
  - "OrderService"
  - "NullPointerException"
  - "500 /orders/{id}/cancel"
errors:
  - "ERROR NullPointerException: Cannot invoke \"Customer.getName()\" because \"customer\" is null"
---

## Problem
Cancelling an order that has no customer record, as guest checkout creates, returned 500.

## Cause
OrderMapper.toDto read the customer's name without a null check, and OrderService passed it the guest order unchanged.

## Fix
The mapper returns an empty name when the customer is missing. A test cancels a guest order.
