---
name: mongo
description: Using the mongo tool to look at MongoDB and, in a test environment, change it - count before find, explain before blaming the database, preview every write, never write to production. Use when the user asks about data in MongoDB, why a query is slow, what an order or document looks like, or to fix test data.
---

# Looking at MongoDB, and changing it in a test environment

Use the `mongo` tool for every MongoDB question. It connects as the user configured, hides what the access lists hide, and asks the user before it writes. A read runs at once. A write to a test environment shows the user a preview first. A write to production is refused, always.

## Start by looking

1. `databases`, then `collections` for a database, show what exists. Do not guess a name: a name that is denied or not allowed is refused with what is allowed.
2. `schema` shows the field names and types of a collection from a sample. Use it before you write a filter, so the field names are real.
3. `indexes` shows what a query can use. `stats` shows how big a collection is.

## Count before you find

- `count` with your filter first. It is exact and cheap. If it says 40000, narrow the filter before you `find`.
- `find` with a small `limit`, and a `projection` of the fields you need. A result at its limit says "possibly partial": narrow the filter or raise `limit`, do not assume you saw everything.
- Ids and dates in a result are Extended JSON, such as `{"$oid": "..."}`. Copy them as they are into the next filter. A plain string will not match an ObjectId.
- `distinct` lists the values of a field. `sample` shows a few random documents. `aggregate` runs a pipeline when a filter cannot say it.

## Explain before you blame the database

A slow query is usually a missing index. Run `explain` with the same filter and sort. `COLLSCAN` means the whole collection was read; `IXSCAN(name)` means an index was used. Compare the documents examined with the documents returned: a big gap means the index does not fit the filter. Check `indexes` before you suggest a new one, and say what you found rather than "the database is slow".

## What you will not see

Fields whose names look like credentials (password, secret, token, apiKey) are never returned and cannot be named, in any environment. The user's lists hide more. In production only the listed fields exist: you get nothing else, and a pipeline that names another field is refused. A refusal names what is allowed. Use that list, and do not try to reach a hidden field by renaming it, `$getField`, `$lookup` or `$replaceRoot`: the same check applies.

## Changing test data

1. Read first: `count` and `find` the documents you mean to change.
2. Say what you are about to change, and why. Then make one write: `update`, `replace`, `delete`, `insert`, `bulk`, `create-index` or `drop-index`.
3. The user sees a preview with the filter, the change and how many documents match, counted just before. Make the filter as narrow as the task needs, usually an `_id`.
4. Use `which: "one"` unless the task is a real change to many. A filter that is empty is refused. More than 1000 documents is refused unless you raise `limit` on purpose.
5. After the write, read the document again and check the change.

If the tool says "changed since the preview", the count moved while the user read it. Nothing was sent. Look again and make the write again.

If a write ends with "no answer" or "the outcome is unknown", the tool did not send it again, and neither must you. Read the data first. The message tells you what it read.

## Never production

A write, an index change, `$out` and `$merge` are refused in production before anyone is asked. Do not look for another way. If production data needs fixing, write down the exact filter and change for a person to run, and say that you did not run it.

## When the tool refuses

The reason names what to change. The common ones:

- `X is not in the allow list` or `X is denied by the access list`: that collection or field is not for you. Use what the message lists.
- `looks like a credential`: a field with that name is always denied. Leave it out.
- `the filter is empty, so it would change every document`: say which documents.
- `the filter matches more than 1000 documents`: narrow the filter, or raise `limit` if you mean it.
- `runs JavaScript on the server`: `$where`, `$function` and `$accumulator` are not allowed. Use a filter or pipeline operators.
- `no tunnel provider is registered`, `the bastion refused the SSH key`, `cannot reach the ... database`: the route is the user's to fix. Say so once, and do not retry blindly.
