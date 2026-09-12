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
- Reports and receipts describe known progress, not rollback. Reconcile uncertain tools, model calls, and unrecorded accounting before retrying.
- OpenAI and compatible HTTP adapters make one request per attempt, reject redirects, and never switch to a fallback provider. A compatible endpoint receives only its explicitly supplied API key.
- Choose a trusted provider endpoint and declare its actual tool/schema capabilities. Native provider history is opaque context for that same adapter and must not be modified or mixed across providers.

The runtime deliberately has no shell, filesystem, browser, network proxy, scheduler, channel adapter, or secret store. Applications may expose narrow versions of those capabilities as tools, but the risk and authorization remain theirs.
