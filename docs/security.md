# Security model

Small Hour assumes model input and model output are untrusted.

- Tools are an allowlist, never capability discovery. Schemas are strict by default and host parsers remain authoritative.
- Every tool is marked read or write; an omitted mode is treated as write.
- Choice-governed writes require an accepted choice and explicit host authorization for that exact call.
- The host authenticates the caller and selects `agentId`; the model never selects its own identity partition.
- A tool receives the host's `agentId`, `turnId`, `toolCallId`, and abort signal. It should scope every read and write to that context.
- Mutating tools must be idempotent. Provider retries repeat model calls; malformed models can also request the same action twice.
- Duplicate call IDs are rejected. A write that throws after starting ends the turn, preserving uncertainty and known receipts for host recovery.
- Keep credentials outside personas, memory, and tool results. Provider adapters receive credentials through normal process configuration.
- Bound memory, model hops, total model attempts, tokens, tool-result size, and wall-clock time. Every asynchronous host hook and retry wait obeys the same deadline.
- Never execute a tool on the final provider hop; reserve one hop for interpreting its result.
- Validate and moderate returned text in the host before delivering it to another person or system.
- Structured output requires a host parser; a provider schema alone cannot authorize an action or prove a selected ID is valid.
- Oversized tool results fail unless the host supplies a bounded replacement. Compaction must preserve necessary evidence.
- Turn reports and `recordReceipt()` references describe known progress; they do not roll back effects. Reconcile uncertain tools, model calls, and unrecorded accounting before retrying.
- The optional SQLite operation store makes participating local writes and their receipt atomic. It does not authenticate scopes, authorize receipt disclosure, or cover remote effects. Application authorization remains required before committing work or returning saved results.
- The optional model-step store persists explicit contracts, input text, tool arguments, progress and results. Restrict access and retention as application data. Replaying a completed result grants no new permission; incomplete steps require reconciliation before new execution. The store does not automatically retain model context or provider-native history.
- The optional spending store commits reservations before provider dispatch and retains unresolved charges. Applications authenticate scope selection, supply conservative estimates and current prices/limits, and verify reconciliation evidence. Pricing snapshots and evidence are application data; no input text or provider history is copied automatically. Bypassing its hooks, deleting accounting rows, or resetting scopes bypasses the persisted budget.
- OpenAI and compatible HTTP adapters make one request per attempt, reject redirects, and never switch to a fallback provider. A compatible endpoint receives only its explicitly supplied API key.
- Choose a trusted provider endpoint and declare its actual tool/schema capabilities. Native provider history is opaque context for that same adapter and must not be modified or mixed across providers.

The runtime deliberately has no shell, filesystem, browser, network proxy, scheduler, channel adapter, or secret store. Applications may expose narrow versions of those capabilities as tools, but the risk and authorization remain theirs.
