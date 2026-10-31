---
ticket: "PROJ-111"
closedAt: "2026-05-14T10:00:00.000Z"
repositories:
  - "catalog-api"
keys: []
identifiers:
  - "PriceCache"
  - "CacheEvictionListener"
errors: []
---

## Problem
Shoppers saw the old price for up to ten minutes after an editor changed it.

## Cause
PriceCache kept entries for ten minutes, and nothing removed an entry when the price was updated.

## Fix
CacheEvictionListener removes the entry on every price update, and the time to live drops to one minute.
