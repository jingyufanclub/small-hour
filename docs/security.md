# Security model

Small Hour assumes model input and model output are untrusted.

- Tools are an allowlist, never capability discovery. Schemas are strict by default and host parsers remain authoritative.
- Every tool is marked read or write; an omitted mode is treated as write.
- Choice-governed writes require an accepted choice and explicit host authorization for that exact call.
- The host authenticates the caller and selects `agentId`; the model never selects its own identity partition.
- A tool receives the host's `agentId`, `turnId`, `toolCallId`, and abort signal. It should scope every read and write to that context.
- Mutating tools must be idempotent. Provider retries repeat model calls; malformed models can also request the same action twice.
- Keep credentials outside personas, memory, and tool results. Provider adapters receive credentials through normal process configuration.
- Bound memory, model hops, tokens, tool-result size, and wall-clock time. Retry backoff obeys the same abort signal.
- Never execute a tool on the final provider hop; reserve one hop for interpreting its result.
- Validate and moderate returned text in the host before delivering it to another person or system.

The runtime deliberately has no shell, filesystem, browser, network proxy, scheduler, channel adapter, or secret store. Applications may expose narrow versions of those capabilities as tools, but the risk and authorization remain theirs.
