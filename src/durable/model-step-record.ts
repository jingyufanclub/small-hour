import type { StructuredTurnResult, TurnReport, TurnResult } from "../types.js";
import { canonicalJson } from "./json.js";

export type SavedTurn = TurnResult | StructuredTurnResult<unknown>;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new TypeError("Invalid saved turn record");
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function list(value: unknown): unknown[] { requireValue(Array.isArray(value)); return value; }
function usage(value: unknown): void {
  const row = object(value);
  requireValue(text(row.model) && [row.freshInputTokens, row.cacheWriteTokens, row.cacheReadTokens, row.outputTokens].every(count));
}

export function readReport(value: unknown): TurnReport {
  const row = object(value);
  requireValue(text(row.agentId) && text(row.turnId) && count(row.hops));
  const toolIds = new Set<string>(), callIds = new Set<string>();
  for (const item of list(row.toolCalls)) {
    const call = object(item);
    requireValue(text(call.id) && !toolIds.has(call.id) && text(call.name) && "input" in call);
    toolIds.add(call.id);
    requireValue(text(call.status) && ["not_started", "completed", "unknown"].includes(call.status));
    requireValue(call.ok === (call.status === "completed"));
    requireValue(list(call.receiptIds).every(text) && (call.errorCode === undefined || text(call.errorCode)));
  }
  for (const [index, item] of list(row.modelCalls).entries()) {
    const call = object(item);
    requireValue(text(call.callId) && !callIds.has(call.callId) && text(call.provider));
    callIds.add(call.callId);
    requireValue(call.attempt === index + 1 && count(call.hop) && call.hop > 0 && call.hop <= row.hops);
    requireValue(text(call.status) && ["not_started", "responded", "rejected", "unknown"].includes(call.status));
    requireValue(text(call.accounting) && ["unrecorded", "recorded"].includes(call.accounting));
    requireValue(call.requestId === undefined || typeof call.requestId === "string");
    if (call.usage !== undefined) usage(call.usage);
  }
  list(row.usage).forEach(usage);
  return row as unknown as TurnReport;
}

export function reportValue(report: TurnReport): TurnReport {
  return {
    agentId: report.agentId, turnId: report.turnId, hops: report.hops,
    ...(report.choice === undefined ? {} : { choice: report.choice }),
    toolCalls: report.toolCalls.map(({ errorCode, ...call }) => ({ ...call, ...(errorCode === undefined ? {} : { errorCode }) })),
    modelCalls: report.modelCalls.map(({ requestId, usage, ...call }) => ({ ...call,
      ...(requestId === undefined ? {} : { requestId }), ...(usage === undefined ? {} : { usage }) })),
    usage: report.usage,
  };
}

export function readResult(value: unknown): SavedTurn {
  const row = object(value);
  const report = readReport(row);
  const issues = list(row.issues);
  requireValue(typeof row.output === "string" && issues.every(issue => typeof issue === "string"));
  requireValue(row.finishReason === "end_turn" || row.finishReason === "stop_sequence");
  if (row.status === "structured") {
    requireValue(row.accepted === true && issues.length === 0 && "value" in row);
    requireValue(report.choice === undefined && report.toolCalls.length === 0);
  } else {
    requireValue(text(row.status) && ["reply", "silence", "rejected"].includes(row.status));
    requireValue(row.accepted === (row.status !== "rejected"));
    if (row.status === "reply") requireValue(row.output.length > 0);
    if (row.status === "silence") requireValue(row.output.length === 0);
  }
  return row as unknown as SavedTurn;
}

export function resultJson(result: SavedTurn): string {
  const { choice: _, ...base } = result;
  return canonicalJson({ ...base, ...reportValue(result) });
}
