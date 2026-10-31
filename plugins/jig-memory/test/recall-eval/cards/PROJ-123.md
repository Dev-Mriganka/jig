---
ticket: "PROJ-123"
closedAt: "2026-08-06T10:00:00.000Z"
repositories:
  - "shipping-service"
keys: []
identifiers:
  - "ShipmentMapper"
  - "NullPointerException"
errors:
  - "ERROR NullPointerException: Cannot invoke \"String.trim()\" because \"line2\" is null"
---

## Problem
Creating a shipment failed when the address had no second line.

## Cause
ShipmentMapper trimmed the second address line without checking that it exists.

## Fix
Missing address lines map to an empty string, and a test creates a shipment with only one line.
