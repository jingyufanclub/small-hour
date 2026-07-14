import type { SystemBlock, TurnContext } from "../types.js";

export interface PersonaSource {
  load(context: TurnContext): Promise<string | SystemBlock[]>;
}

export class StaticPersonaSource implements PersonaSource {
  constructor(private readonly persona: string | SystemBlock[]) {}

  async load(): Promise<string | SystemBlock[]> {
    return this.persona;
  }
}
