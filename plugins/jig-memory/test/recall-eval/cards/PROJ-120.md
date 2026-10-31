---
ticket: "PROJ-120"
closedAt: "2026-07-16T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "OrderRepository"
  - "idx_orders_customer_created"
errors:
  - "WARN Slow query took 12 s: select * from orders where customer_id = ? order by created_at desc"
---

## Problem
The order list took 12 seconds for customers with many orders.

## Cause
The query filtered by customer and sorted by date with no index that covers both, so the database sorted millions of rows.

## Fix
The index idx_orders_customer_created on customer id and creation time was added, with the query unchanged.
