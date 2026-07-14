export type JsonSchema = Record<string, unknown>;

export interface SystemBlock {
  text: string;
  cache?: "ephemeral";
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface OpaqueProviderBlock {
  type: "opaque";
  value: unknown;
}

export type AssistantBlock = TextBlock | ToolUseBlock | OpaqueProviderBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export type ProviderMessage =
  | { role: "user"; content: string | UserBlock[] }
  | { role: "assistant"; content: string | AssistantBlock[] };

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface TokenUsage {
  model: string;
  freshInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface ProviderRequest {
  system: SystemBlock[];
  messages: ProviderMessage[];
  tools: ProviderTool[];
  maxTokens: number;
  thinking?: { enabled: true; budgetTokens: number };
  signal: AbortSignal;
}

export interface ProviderResponse {
  content: AssistantBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "unknown";
  usage?: TokenUsage;
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  isRetryable?(error: unknown): boolean;
}

export interface TurnContext {
  agentId: string;
  turnId: string;
  input: string;
  signal: AbortSignal;
}

export interface ToolContext extends TurnContext {
  toolCallId: string;
}

export interface StructuredChoiceSpec<TChoice = unknown> {
  name?: string;
  description: string;
  inputSchema: JsonSchema;
  requiredFirst?: boolean;
  onChoice?: (choice: TChoice, context: TurnContext) => void | Promise<void>;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  ok: boolean;
}

export interface TurnInput<TChoice = unknown> {
  agentId: string;
  input: string;
  turnId?: string;
  signal?: AbortSignal;
  allowedTools?: string[];
  choice?: StructuredChoiceSpec<TChoice>;
  maxTokens?: number;
  thinking?: { budgetTokens: number };
}

export interface TurnResult<TChoice = unknown> {
  output: string;
  accepted: boolean;
  issues: string[];
  choice?: TChoice;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage[];
  hops: number;
  finishReason: ProviderResponse["stopReason"] | "max_hops";
}

export class RuntimeError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
  }
}
