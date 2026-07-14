import type { JsonSchema, ProviderTool, ToolContext } from "../types.js";

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mode?: "read" | "write";
  parse?: (input: unknown) => TInput;
  execute(input: TInput, context: ToolContext): Promise<TResult> | TResult;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any, any>>();

  constructor(definitions: ToolDefinition<any, any>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<TInput, TResult>(definition: ToolDefinition<TInput, TResult>): this {
    if (!definition.name.trim()) throw new TypeError("tool name is required");
    if (this.definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
    this.definitions.set(definition.name, definition);
    return this;
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  providerTools(allowed?: string[]): ProviderTool[] {
    const allow = allowed ? new Set(allowed) : null;
    if (allow) {
      for (const name of allow) {
        if (!this.definitions.has(name)) throw new Error(`unknown allowed tool: ${name}`);
      }
    }

    return [...this.definitions.values()]
      .filter((definition) => !allow || allow.has(definition.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`unknown tool: ${name}`);
    const parsed = definition.parse ? definition.parse(input) : input;
    return await definition.execute(parsed, context);
  }
}
