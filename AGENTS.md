# Small Hour working rules

Small Hour is a compact, provider-neutral TypeScript runtime for persistent character agents. It gives a model a persona, a bounded memory view, and explicitly registered tools for one turn.

Keep the package boundary narrow:

- The host owns persistence, authorization, scheduling, delivery, secrets, and side effects.
- The runtime owns the provider call loop, within-turn tool dispatch, retries, timeouts, usage reporting, and output checks.
- Never add unrestricted shell, filesystem, browser, channel, credential, or workflow features.
- Never add a growing transcript store. Memory is supplied fresh by the host on every turn.
- Tool implementations must be host-owned and idempotent when they mutate state.
- Keep provider-specific code under `src/providers/`.
- Do not add a publication license until the repository owner chooses one.

Run `npm run check` before calling a change complete.
