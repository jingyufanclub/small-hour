import type { ProviderMessage, TurnContext } from "../types.js";

export interface MemorySource {
  load(context: TurnContext): Promise<ProviderMessage[]>;
}

export class EmptyMemorySource implements MemorySource {
  async load(): Promise<ProviderMessage[]> {
    return [];
  }
}
