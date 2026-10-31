---
ticket: "PROJ-106"
closedAt: "2026-04-09T10:00:00.000Z"
repositories:
  - "reporting-job"
keys: []
identifiers:
  - "DailyTotalsCalculator"
  - "ZoneId"
  - "accounts.timezone"
errors: []
---

## Problem
Daily totals were off by one day for customers in Sydney: orders after 10:00 UTC counted for the previous day.

## Cause
DailyTotalsCalculator cut the day at midnight in the server's time zone, not the account's.

## Fix
The day boundary uses the ZoneId from accounts.timezone. A test covers Sydney and Los Angeles.
