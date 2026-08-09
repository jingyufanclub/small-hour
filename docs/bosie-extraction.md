# Bosie extraction map

Small Hour begins from the live loop in Bosie's `server/runtime.ts`, but the public package is not a copy of Bosie.

## Extracted mechanism

| Bosie mechanism | Small Hour boundary |
| --- | --- |
| Anthropic message/tool loop | `SmallHourRuntime` plus `AnthropicProvider` |
| per-bosie SOUL loader | `PersonaSource` interface |
| bounded SQLite conversation window | `MemorySource` interface |
| fixed interior tool list and dispatcher | `ToolRegistry` plus per-turn `allowedTools` |
| transient retry | `RetryPolicy` |
| six-hop cap and 4,000-character tool results | visible runtime limits |
| usage rows | `UsageSink` interface |
| `bosie_choose` first-call decision | optional structured `choice` tool |
| spoken-line scrub and length contract | `OutputPolicy` hook |

## Stays in Bosie

- SQLite schema and all queries;
- SOUL contents, voice rules, feral stance, and expression logic;
- recent-window anti-parrot selection;
- fan club, status, profile, notes, journal, and history endpoints;
- channel delivery, moderation, proactive scheduling, and world clock;
- action receipts, narration jobs, and every other durable workflow;
- model choice, prompt composition, and cost tables specific to Bosie.

## Adoption path

1. Keep Bosie's current runtime untouched while Small Hour's fake-provider contracts settle.
2. Add a Bosie-local adapter implementing persona, memory, tools, usage, and output policy.
3. Compare current and extracted paths in dry-run mode using identical prompt packs.
4. Verify voice, tool ordering, latency, and token accounting before switching any live call.
5. Pin Small Hour to a commit or version; never make Bosie follow an unpinned moving package.

Publication remains separate from extraction. The repository is private and has no license until that decision is made.

## Generic hardening sync

The 2026-08-09 audit compared this extraction with Bosie's later live runtime. Small Hour now carries the reusable
lessons: strict provider schemas, connection-aware retries, abortable backoff, valid bounded tool-result envelopes,
complete-stop enforcement, a reserved post-tool hop, explicit reply/silence/rejection status, and read-before-choice
with host-authorized writes. Bosie's grounding envelopes, voice repair, entity provenance, game tools, and durable
telemetry remain host-specific and intentionally stay out of this package.
