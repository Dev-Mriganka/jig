---
ticket: "PROJ-108"
closedAt: "2026-04-23T10:00:00.000Z"
repositories:
  - "invoice-service"
keys: []
identifiers:
  - "PriceMapper"
  - "BigDecimal"
errors: []
---

## Problem
Invoice lines showed prices with three decimals, such as 12.500, after a library upgrade.

## Cause
PriceMapper created BigDecimal values from doubles, and the new library kept their scale.

## Fix
The mapper sets the scale to two with half-up rounding. A test pins the printed format.
