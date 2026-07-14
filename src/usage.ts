import type { TokenUsage, TurnContext } from "./types.js";

export interface UsageSink {
  record(usage: TokenUsage, context: TurnContext): void | Promise<void>;
}

export class NoopUsageSink implements UsageSink {
  record(): void {}
}
