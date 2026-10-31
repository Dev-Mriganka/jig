---
ticket: "PROJ-122"
closedAt: "2026-07-30T10:00:00.000Z"
repositories:
  - "web-shop"
keys: []
identifiers:
  - "DatePicker"
  - "parseIsoDate"
errors: []
---

## Problem
The date picker showed the day before the chosen one for users in Safari.

## Cause
parseIsoDate built a date from the text with no time, which Safari reads as UTC midnight and shows in local time.

## Fix
The function builds the date from its year, month and day parts, in local time.
