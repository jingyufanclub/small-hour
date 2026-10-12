# Save a database change once

Use `SqliteOperationStore` when a repeated request must return the original result without repeating a committed database change.

For example, your app marks a document as processed. Small Hour saves that change and its **receipt** together. The receipt identifies the operation and preserves its result.

Import the store from `small-hour/durable/sqlite`, supply an existing synchronous SQLite connection, and call `initialize()`. The connection interface supports `node:sqlite` and `better-sqlite3`; Small Hour opens no connection.

## Identity and results

| Method | Behavior |
| --- | --- |
| `commit(request, { execute, parseResult })` | Run new work or reuse its receipt. Returns `{ receipt, replayed }`. |
| `find(request, parseResult)` | Read a validated receipt without execution, or return `undefined`. |

`request` supplies nonempty `scope`, `id`, `kind`, `version`, and JSON `input`. Together, scope and ID identify the operation. Reusing that identity with changed input, kind, or version raises `contract_conflict` before execution.

Inputs/results must be plain JSON: finite numbers, strings, booleans, null, dense arrays, and plain objects. Object-key order is insignificant; array order matters. There is no automatic size limit or truncation.

`parseResult` validates both new and saved results synchronously. It must preserve their exact JSON values. Invalid new results raise `invalid_result`; invalid saved receipts raise `invalid_receipt`. Neither authorizes repeating the effect.

## What commits together?

`commit()` reserves the identity and calls `execute(database)` inside a SQLite savepoint. Database changes, the result, and any [enqueued delivery](delivery.md) on that same connection commit or roll back together. Concurrent duplicates serialize through SQLite.

If your app already opened a transaction, **its final commit still controls everything**. A returned receipt remains provisional until then; the same connection can see provisional work.

Executors and parsers must be synchronous. Keep model calls, sends, filesystem writes, and transaction-control statements outside them. A database rollback cannot undo external work. Async callbacks are rejected; rollback cannot stop a promise that already started.

The receipt table and `small_hour_operation` savepoint are reserved for Small Hour. Storage/busy errors propagate without retries.

## After a crash

Committed work has its receipt. Uncommitted database work can run again. A receipt proves the local result; it does not prove a remote effect or current permission to disclose it.

Your app checks permission and keeps receipts throughout the duplicate-request window. Deleting them removes protection. Use [timestamps](storage-schema.md#lifecycle-timestamps) for record history, and follow [upgrade requirements](releases.md#0100) for existing data.
