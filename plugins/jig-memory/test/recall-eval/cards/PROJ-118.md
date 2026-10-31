---
ticket: "PROJ-118"
closedAt: "2026-07-02T10:00:00.000Z"
repositories:
  - "invoice-service"
keys: []
identifiers:
  - "CurrencyFormatter"
errors: []
---

## Problem
Totals for JPY orders were 100 times too large on invoices.

## Cause
CurrencyFormatter assumed two decimals for every currency, and the yen has none.

## Fix
The number of decimals comes from the currency itself. A test covers JPY, EUR and KWD.
