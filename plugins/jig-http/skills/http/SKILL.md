---
name: http
description: Calling named HTTP APIs with the http tool - read with GET first, change one thing at a time, and check each answer. Use when the user asks to call, test or inspect an API endpoint, reproduce a request, or check what an API returns.
---

# Calling an API

Use the `http` tool for every HTTP call. You give a `target`, a `method`, a `path` and, for a write, a `body`. The tool adds the sign-in. A `GET` reads. `POST`, `PUT`, `PATCH` and `DELETE` write: they ask the user first, and a write to production is refused.

## Before you call

- Use only the targets that are configured. A wrong `target` is refused with the names there are; ask the user when none fits.
- `path` starts with `/`, has at most one `?query` and no `..`. The target holds the base address, so leave it out of the path.
- Use known test accounts and records, never a customer's.

## Read first, write once

1. `GET` the resource first. See what is there and how the API shapes it.
2. Make one write. Say what you are about to change before you call.
3. Read the status and the body of the answer. `GET` the resource again to check the change, and only then go on.

Never run several writes at once: each one must be checked before the next.

## Reading an answer

- A non-2xx status is a result, not a failure of the tool. Reason from the status and the body: `400` and `422` mean the request was wrong, `401` and `403` the sign-in or the permissions, `404` a wrong path or id, `409` a conflict.
- A `401` or `403` is the user's to fix. Say so once. Do not look for another way around it.
- Redirects are not followed. The `location` header shows where the server points.

## When a write gets no answer

A write that times out or loses its connection may still have gone through. The tool then says the outcome is unknown, and it never sends the write again. `GET` the resource to see whether the change is there. Do not repeat the write until you have read the result.

## Credentials

Never put a token, a password or a key in a header, the path or the body. The tool signs requests in by itself, and refuses `Authorization`, `Cookie` and the other headers that carry a sign-in or control the connection.
