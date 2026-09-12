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
  strict?: boolean;
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
  outputSchema?: JsonSchema;
  signal: AbortSignal;
}

export interface ProviderResponse {
  content: AssistantBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "content_filter" | "unknown";
  usage?: TokenUsage;
  requestId?: string;
}

export interface ModelProvider {
  readonly name: string;
  readonly model?: string;
  readonly capabilities?: { structuredOutput?: boolean; tools?: boolean; thinkingBudget?: boolean };
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  isRetryable?(error: unknown): boolean;
  failureInfo?(error: unknown): { status: "rejected" | "unknown"; requestId?: string };
}

export interface TurnContext {
  agentId: string;
  turnId: string;
  input: string;
  signal: AbortSignal;
}

export interface ToolContext extends TurnContext {
  toolCallId: string;
  recordReceipt(receiptId: string): void;
}

export interface ToolResultOverflowContext extends TurnContext {
  toolCallId: string;
  toolName: string;
  maxCharacters: number;
}

export interface ModelCallContext extends TurnContext {
  callId: string;
  provider: string;
  model?: string;
  attempt: number;
  hop: number;
  maxTokens: number;
  thinking?: { enabled: true; budgetTokens: number };
}

export interface ModelCallRecord {
  callId: string;
  provider: string;
  attempt: number;
  hop: number;
  status: "not_started" | "responded" | "rejected" | "unknown";
  requestId?: string;
  usage?: TokenUsage;
  accounting: "unrecorded" | "recorded";
}

export interface ModelCallHooks {
  admit?(context: ModelCallContext): boolean | Promise<boolean>;
  record?(call: Readonly<ModelCallRecord>, context: ModelCallContext): void | Promise<void>;
}

export interface StructuredOutputSpec<TValue> {
  schema: JsonSchema;
  parse(value: unknown): TValue;
}

export interface StructuredChoiceSpec<TChoice = unknown> {
  name?: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
  required?: boolean;
  requiredFirst?: boolean;
  parse?: (input: unknown) => TChoice;
  authorizeWrite?: (
    choice: TChoice,
    tool: { name: string; input: unknown },
    context: TurnContext,
  ) => boolean | Promise<boolean>;
  onChoice?: (choice: TChoice, context: TurnContext) => void | Promise<void>;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  ok: boolean;
  status: "not_started" | "completed" | "unknown";
  receiptIds: string[];
  errorCode?: string;
}

export interface TurnInputBase {
  agentId: string;
  input: string;
  turnId?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  thinking?: { budgetTokens: number };
}

export interface TurnInput<TChoice = unknown> extends TurnInputBase {
  allowedTools?: string[];
  choice?: StructuredChoiceSpec<TChoice>;
  structuredOutput?: never;
}

export interface StructuredTurnInput<TValue> extends TurnInputBase {
  structuredOutput: StructuredOutputSpec<TValue>;
  allowedTools?: never;
  choice?: never;
}

export interface TurnReport<TChoice = unknown> {
  agentId: string;
  turnId: string;
  choice?: TChoice;
  toolCalls: ToolCallRecord[];
  modelCalls: ModelCallRecord[];
  usage: TokenUsage[];
  hops: number;
}

export interface TurnResult<TChoice = unknown> extends TurnReport<TChoice> {
  status: "reply" | "silence" | "rejected";
  output: string;
  accepted: boolean;
  issues: string[];
  finishReason: ProviderResponse["stopReason"] | "max_hops";
}

export interface StructuredTurnResult<TValue> extends TurnReport<never> {
  status: "structured";
  value: TValue;
  output: string;
  accepted: true;
  issues: [];
  finishReason: ProviderResponse["stopReason"];
}

export class RuntimeError extends Error {
  readonly report?: TurnReport;

  constructor(message: string, readonly code: string, options?: ErrorOptions & { report?: TurnReport }) {
    super(message, options);
    this.name = "RuntimeError";
    this.report = options?.report;
  }
}
