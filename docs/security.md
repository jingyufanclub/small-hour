# Security responsibilities

Small Hour limits how a model can use the functions your app provides. **Your app must still decide who may read, change, or receive each piece of data.** Model input and output are untrusted.

## Before a request runs

| Boundary | What to configure |
| --- | --- |
| Identity | Authenticate callers in your app. `agentId` and storage scopes are identifiers, not credentials. |
| Tools | Register narrow functions with real synchronous `parse` validation. Explicitly select `allowedTools`; omission fails when tools are registered. |
| Permission | Check current access inside tools, including reads. A tool list, schema, or accepted choice does not authorize a record. |
| Limits | Set call, time, token, context, and result-size limits for the workflow. |
| Money | Install admission/accounting hooks. Supply authorized scopes, prices, estimates, and limits; see [spending](model-spending.md). |
| Output | Check accuracy, disclosure, and destination requirements. The default text policy accepts completed text. |
| Provider | Use trusted endpoints and verified model capabilities; see [providers](providers.md). |

Managed Anthropic/OpenAI clients use fixed official endpoints, selected API keys, and disabled SDK logging/retries. All adapters request redirect rejection; native fetch enforces it. App-supplied clients/fetch implementations can ignore options, so review their credentials, headers, logging, and transport behavior.

Small Hour supplies no unrestricted shell, browser, filesystem, or credential tools. Any such access comes from your app's functions.

## Keep private information private

Recoverable tool errors use generic text and fixed codes. Only `ModelSafeToolError` exposes an explicitly selected message. Exception causes and stacks are not forwarded to the model; treat terminal `RuntimeError.cause` as private.

This does not redact explicit input, memory, tool results, or [captured traces](tracing.md). Keep credentials out of them. Choose appropriate content capture, redaction, retention, and access rules.

## Protect saved work

Optional [storage](storage.md) uses your SQLite connection. Your app controls database access, backups, durability settings, busy timeout, and connection lifetime.

| Component | Potentially sensitive saved data |
| --- | --- |
| Local operations | Contract and result. |
| Model steps | Explicit text/images, configuration, reports, tool arguments, and result. |
| Spending | Identities, limits, prices, usage, and reconciliation evidence. |
| Tasks/delivery | Inputs, destinations, payloads, schedule, claims, and delivery evidence. |

Retrieved memory and provider-native history are not automatically copied into durable storage. Authenticate inspection, cancellation, reconciliation, and disclosure APIs. A saved result does not grant current permission to reveal it.

## Handle uncertainty safely

Keep operation IDs stable across repeated requests. Retain receipts and spending records throughout the recovery window; deleting them removes duplicate protection or cost history.

Cancellation and lease expiry cannot undo work already started. Claims protect runner-owned local commits; remote services need actual duplicate protection and effect-boundary authorization. Verify reconciliation evidence and rule out late contradictory effects.

Follow [upgrade and rollback requirements](releases.md). After an unconfirmed rollback, restore or replace the database connection before recovery.
