---
name: api
description: Running the team's saved API requests with the api tool - list and show them, run a read first, change one thing at a time, and check each answer. Use when the user asks to call, test or check an API, reproduce a request from a ticket, check a deploy, or smoke-test an environment.
---

# Running saved API requests

Use the `api` tool for every API call. The team's requests are saved in collections; you run them by name and fill in only their variables. The tool adds the sign-in and the host. A read runs at once. A write asks the user first and shows the exact request, and a write in production is refused.

## Find the request

1. `api list` shows the saved requests: the collection and folder, the method, the address, whether it reads or writes, and the variables it needs. Narrow it with `collection`, `folder` or `text`.
2. `api show` with `request` shows one request in full: its headers, body and variables, where each variable gets its value, and whether it is refused. Give `environment` to see the values in that environment.
3. Use only requests that exist. A wrong name is refused with the names that are close; ask the user when none fits.

## Run it

- `api run` with `request`, `environment` and `variables`. Give a value for each variable the request needs (`orderId`, a search text) and nothing else.
- A variable that is a secret, or that signs the request in, comes from the environment and the user's secret store. Never put a token, a password or a key in `variables`, and never try to set the host or the method: they are refused.
- `api run-folder` with `folder` and `environment` runs a folder in order and stops at the first failure. Use it for a smoke test after a deploy.
- `api call` is an ad-hoc request for an endpoint nobody has saved. It works only in the test environments the user allowed, never in production, and it signs in only if the environment sets a sign-in. Prefer a saved request.

## Read first, write once

1. Run a read of the resource first, to see what is there and how the API shapes it.
2. Make one write. Say what you are about to change before you call.
3. Read the status and the body of the answer. Run the read again to check the change, and only then go on.

Use known test accounts and records, never a customer's. Never run several writes at once: each one must be checked before the next.

## Reading an answer

- A non-2xx status is a result, not a failure of the tool. Reason from the status and the body: `400` and `422` mean the request was wrong, `401` and `403` the sign-in or the permissions, `404` a wrong path or id, `409` a conflict.
- A `401` or `403` is the user's to fix. Say so once. Do not look for another way around it.
- Redirects are not followed. The `location` header shows where the server points.

## When the tool refuses

The reason names what to change. The common ones:

- `no value for orderId`: the request uses a variable you did not give. Pass it in `variables`.
- `has a pre-request script`: the request needs a script from the user's API client, and scripts never run here. Tell the user; do not rebuild the request by hand.
- `cannot be sent: ...`: the request uses a protocol or sign-in this tool does not send (WebSocket, gRPC, Digest, a browser sign-in). Tell the user.
- `is not a host of Staging`: the request's address goes outside the environment's own hosts. It is the collection that needs fixing, not the call.
- `is a secret but api.secrets has no reference`: the user has to add the secret to the configuration.

## When a write gets no answer

A write that times out or loses its connection may still have gone through. The tool then says the outcome is unknown, and it never sends the write again. Run a read of the resource to see whether the change is there. Do not repeat the write until you have read the result.
