# Small Hour working rules

Small Hour is a provider-neutral TypeScript runtime for application-defined LLM workflows. Its bounded execution core supplies instructions, selected context, and registered tools or a structured output contract. Optional durable components preserve completed work and support recovery without taking over application decisions.

Keep ownership explicit:

- The application owns workflow definitions, domain facts, authorization, memory selection, secrets, side-effect implementations, and product behavior. Models perform the interpretation, selection, and generation tasks assigned by the application.
- The runtime owns the provider call loop, within-turn tool dispatch, retries, timeouts, usage reporting, and output checks.
- Durable components are opt-in and share the application's storage. Local operation receipts own atomic local replay. Model-step checkpoints preserve completed results and available progress; incomplete work requires application reconciliation. Model-spending hooks own committed reservation and settlement mechanics; applications supply scopes, estimates, prices, limits and reconciliation evidence. Model steps and spending require independent short transactions. These stores do not own scheduling or delivery. The optional task runner owns durable claims, ordered execution, concurrency scopes, cancellation, bounded local retries and fixed-output dispatch through explicit sink contracts; applications explicitly submit tasks, define eligibility and invoke the runner. Incomplete model work is never automatically replayed.
- New durable state, workers, recovery policies, and adapters require a selected, bounded Linear contract. Give each effect and retry one authority; SDK retries stay disabled. Preserve accepted IDs and results through recovery.
- Never add unrestricted shell, filesystem, browser, channel, or credential access, autonomous task creation, model-authored workflows, or self-written skills.
- Never add a growing transcript store. Memory is supplied fresh by the host on every turn.
- Tool implementations are application-owned. Local transaction callbacks must be synchronous database work. Remote effects require explicit idempotency or reconciliation contracts.
- Keep provider-specific code under `src/providers/`.
- Do not add a publication license until the repository owner chooses one.

Run `npm run check` before calling a change complete.

Define workflow outcomes and forbidden effects before implementation, then write tests at the real persistence, execution, or delivery boundary. Mocked model output proves mechanics only. Review architecture, ownership, failure/restart behavior, simplicity, and crustiness; keep comments only for non-obvious constraints. Work one selected ticket at a time and leave dependent slices parked until it is finished and reviewed.

Public documentation stays neutral and concise. Describe current capabilities, setup, contracts and consumer obligations; keep pages suitable for a five-minute scan. Exclude character framing, consumer-specific examples, comparison pitches and revision history.
