import type { JsonSchema, ProviderTool, ToolContext } from "../types.js";
import { checkAbort } from "../deadline.js";

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mode?: "read" | "write";
  strict?: boolean;
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
    if (definition.mode !== undefined && definition.mode !== "read" && definition.mode !== "write") {
      throw new TypeError(`invalid tool mode: ${definition.mode}`);
    }
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
      .map(({ name, description, inputSchema, strict }) => ({
        name,
        description,
        inputSchema,
        strict: strict ?? true,
      }));
  }

  mode(name: string): "read" | "write" {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`unknown tool: ${name}`);
    return definition.mode ?? "write";
  }

  async execute(name: string, input: unknown, context: ToolContext, onStart?: () => void | Promise<void>, onExecute?: (parsed: unknown) => void): Promise<unknown> {
    checkAbort(context.signal);
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`unknown tool: ${name}`);
    const parsed = definition.parse ? definition.parse(input) : input;
    checkAbort(context.signal);
    await onStart?.();
    checkAbort(context.signal);
    onExecute?.(parsed);
    return await definition.execute(parsed, context);
  }
}
