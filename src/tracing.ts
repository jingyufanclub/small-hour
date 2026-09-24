import { randomBytes } from "node:crypto";
import { types } from "node:util";
import type { ModelCallRecord, ToolCallRecord } from "./types.js";

export interface TraceInput { traceId: string; parentSpanId?: string }
export interface TraceContext extends TraceInput { spanId: string }
export interface TraceSummary extends TraceContext {
  eventCount: number;
  exportFailures: number;
  contentOmissions: number;
  captureFailures: number;
}

export type TraceContent =
  | { status: "captured"; value: unknown; bytes: number }
  | { status: "omitted"; reason: "disabled" }
  | { status: "omitted"; reason: "size_limit"; bytes: number; maxBytes: number }
  | { status: "unavailable"; reason: "serialization_failed" };

type TraceDetail =
  | { type: "turn.started" }
  | { type: "turn.finished"; status: "reply" | "silence" | "rejected" | "structured"; durationMs: number }
  | { type: "turn.finished"; status: "failed"; errorCode: string; durationMs: number }
  | { type: "model.started"; callId: string; provider: string; model?: string; attempt: number; hop: number }
  | { type: "model.request" | "model.response"; format: "runtime" | "provider" }
  | { type: "model.finished"; record: ModelCallRecord; errorCode?: string; durationMs: number }
  | { type: "tool.requested" | "tool.started"; toolCallId: string; toolName: string }
  | { type: "tool.result"; toolCallId: string; stage: "original" | "model" }
  | { type: "tool.finished"; record: Omit<ToolCallRecord, "input">; durationMs: number }
  | { type: "check.started"; check: "output" | "structured_output" }
  | { type: "check.finished"; check: "output" | "structured_output"; verdict: "accepted" | "rejected" | "unavailable"; durationMs: number };

export type TraceEvent = TraceContext & TraceDetail & {
  agentId: string;
  turnId: string;
  sequence: number;
  timestamp: number;
  content?: TraceContent;
};

export interface TraceSink { record(event: Readonly<TraceEvent>): void }
export interface TracingOptions {
  sink: TraceSink;
  content?: { maxBytes: number };
}
export interface ProviderTraceObserver {
  readonly context: TraceContext;
  request(body: unknown): void;
  response(body: unknown): void;
}

function validId(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value) && /[1-9a-f]/.test(value);
}
export function readTraceInput(value: unknown): TraceInput {
  const row = value as Partial<TraceInput> | null;
  if (!row || typeof row !== "object" || Array.isArray(row)
    || !validId(row.traceId, 32) || (row.parentSpanId !== undefined && !validId(row.parentSpanId, 16))) {
    throw new TypeError("trace IDs must be nonzero lowercase hex: 32 characters for traces and 16 for spans");
  }
  return { traceId: row.traceId, ...(row.parentSpanId === undefined ? {} : { parentSpanId: row.parentSpanId }) };
}
export function readTraceContext(value: unknown): TraceContext {
  const parent = readTraceInput(value), spanId = (value as Partial<TraceContext>).spanId;
  if (!validId(spanId, 16) || spanId === parent.parentSpanId) throw new TypeError("invalid trace span identity");
  return { ...parent, spanId };
}
export function readTraceSummary(value: unknown): TraceSummary {
  const context = readTraceContext(value), row = value as TraceSummary;
  const counts = [row.eventCount, row.exportFailures, row.contentOmissions, row.captureFailures];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)
    || counts.slice(1).some(count => count > row.eventCount)) throw new TypeError("invalid trace summary");
  return { ...context, eventCount: row.eventCount, exportFailures: row.exportFailures,
    contentOmissions: row.contentOmissions, captureFailures: row.captureFailures };
}
export function readTracingOptions(options: TracingOptions | undefined): TracingOptions | undefined {
  if (options === undefined) return undefined;
  if (typeof options.sink?.record !== "function") throw new TypeError("tracing requires a sink");
  if (options.content !== undefined && (!Number.isSafeInteger(options.content.maxBytes) || options.content.maxBytes < 1)) {
    throw new TypeError("content capture requires an explicit positive byte limit");
  }
  return { sink: { record: options.sink.record.bind(options.sink) },
    ...(options.content === undefined ? {} : { content: { maxBytes: options.content.maxBytes } }) };
}

export interface TraceSpan { readonly context: TraceContext; readonly startedAt: number; closed: boolean }

function jsonData(value: unknown, parents = new Set<object>()): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || types.isProxy(value) || parents.has(value)) throw new TypeError("content is not plain JSON data");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype) throw new TypeError("content is not plain JSON data");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (fields.toJSON && (fields.toJSON.get || typeof fields.toJSON.value === "function")) throw new TypeError("content requires serialization code");
  parents.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    if (array) {
      for (let index = 0; index < fields.length.value; index++) {
        const field = fields[String(index)];
        if (field && !Object.hasOwn(field, "value")) throw new TypeError("content contains an accessor");
        (result as unknown[]).push(jsonData(field?.value, parents));
      }
    } else for (const [key, field] of Object.entries(fields)) {
      if (!field.enumerable) continue;
      if (!Object.hasOwn(field, "value")) throw new TypeError("content contains an accessor");
      (result as Record<string, unknown>)[key] = jsonData(field.value, parents);
    }
    return result;
  } finally { parents.delete(value); }
}

export class TurnTrace {
  readonly root: TraceSpan;
  private readonly counts = { eventCount: 0, exportFailures: 0, contentOmissions: 0, captureFailures: 0 };
  private closed = false;

  constructor(private readonly options: TracingOptions, private readonly identity: { agentId: string; turnId: string }, parent?: TraceInput) {
    this.root = { context: Object.freeze({ traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"), ...(parent?.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}) }),
    startedAt: performance.now(), closed: false };
  }

  child(parentSpanId = this.root.context.spanId): TraceSpan {
    return { context: Object.freeze({ traceId: this.root.context.traceId, parentSpanId, spanId: randomBytes(8).toString("hex") }),
      startedAt: performance.now(), closed: false };
  }
  duration(span: TraceSpan): number { return Math.max(0, performance.now() - span.startedAt); }
  summary(): TraceSummary { return { ...this.root.context, ...this.counts }; }
  close(): void { this.closed = true; }

  emit(span: TraceSpan, detail: TraceDetail, content?: () => unknown): void {
    if (this.closed || span.closed) return;
    this.counts.eventCount++;
    try {
      const event: TraceEvent = { ...structuredClone(detail), ...this.identity, ...span.context,
        sequence: this.counts.eventCount, timestamp: Date.now(), ...(content ? { content: this.capture(content) } : {}) };
      const returned: unknown = this.options.sink.record(event);
      if (returned && (typeof returned === "object" || typeof returned === "function") && "then" in returned && typeof returned.then === "function") {
        this.counts.exportFailures++;
        void Promise.resolve(returned).catch(() => {});
      }
    } catch { this.counts.exportFailures++; }
  }

  provider(span: TraceSpan): ProviderTraceObserver {
    return {
      context: span.context,
      request: body => this.emit(span, { type: "model.request", format: "provider" }, () => body),
      response: body => this.emit(span, { type: "model.response", format: "provider" }, () => body),
    };
  }

  private capture(read: () => unknown): TraceContent {
    if (!this.options.content) { this.counts.contentOmissions++; return { status: "omitted", reason: "disabled" }; }
    try {
      const json = JSON.stringify(jsonData(read()));
      if (json === undefined) throw new TypeError("not JSON");
      const bytes = Buffer.byteLength(json), maxBytes = this.options.content.maxBytes;
      if (bytes > maxBytes) { this.counts.contentOmissions++; return { status: "omitted", reason: "size_limit", bytes, maxBytes }; }
      return { status: "captured", value: JSON.parse(json), bytes };
    } catch { this.counts.captureFailures++; return { status: "unavailable", reason: "serialization_failed" }; }
  }
}
