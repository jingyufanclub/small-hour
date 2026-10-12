# Upgrade from earlier versions

Start with the [current installation and storage upgrade](releases.md). Apply the requirements for every version you cross. Keep a database backup, the prior package pin, and handlers for existing workflow versions.

## 0.9.0

Managed Anthropic connections require an explicit `apiKey` or `ANTHROPIC_API_KEY`. Custom endpoint, authentication, headers, or SDK logging require your own explicit `client`. Blank keys and nonblank `ANTHROPIC_CUSTOM_HEADERS` fail. Review [provider configuration](providers.md#anthropic); rollback restores the previous SDK defaults. No storage migration.

## 0.8.0

Supply `allowedTools` on ordinary turns with registered tools, and synchronous `parse` on every tool. Use `ModelSafeToolError` only for deliberately shareable feedback; arbitrary exceptions no longer reach the model. See [tools](embedding.md#context-and-tools).

Update workflow versions when changing selection or validation. Completed replay does not rerun tool checks or sanitize old results. No storage migration; rollback restores permissive defaults and error disclosure, so preserve application protections.

## 0.7.0

Spending can reserve against several budgets. Single-scope quotes remain valid; `ModelSpendQuote` is a union. Narrow `quote.scopes` when reading it and use a type intersection when extending it.

The scope migration requires SQLite 3.35+. It validates saved calls, creates budget memberships, and removes the old parent `scope` column while preserving charges, quotes, and uncertainty. Current initialization uses a savepoint and imports no external history. Stop callers and back up first. Older writers cannot safely use this layout; follow current rollback rules.

## 0.6.0–0.6.1

Traced model reports require compatible readers; older versions may reject records or drop trace metadata. Turning tracing off does not remove saved metadata. No table migration.

Anthropic `temperature` needs model support, cannot combine with thinking, and belongs in the workflow revision. No backfill.

## 0.5.0

Upgrade Node to 26.10+ and reinstall dependencies. Native application dependencies may need rebuilding. OpenAI uses its official SDK; no storage migration.

## 0.4.0

`TurnContext.input` can contain text/image blocks. Narrow before using string methods. Older checkpoint readers reject image input; keep compatible handlers. Bind retrieved images to immutable references. No schema migration.

## 0.3.0

Adaptive Anthropic thinking uses a total output ceiling and cannot combine with manual thinking budgets. Keep its model/mode/effort settings in workflow revisions; older adapters cannot run those configurations. No schema migration.

## 0.2.0

Handle `context_limit` and `pause` in stop-reason switches. Anthropic refusal raises `provider_refused`; context exhaustion/pause remain `incomplete_stop`. `ModelCallRecord` is a union; extend it with an intersection. Older records can lack stop evidence; it is not backfilled.

Model recovery requires initial opt-in, effect-free callbacks, and explicit tool exclusion. Existing steps cannot gain it later. Use new task versions and retain old handlers. Recovery never clears uncertain spending. See [recovery](model-recovery.md).
