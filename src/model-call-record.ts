import type { ProviderStop, ProviderStopReason } from "./types.js";

const reasons: Record<ProviderStopReason, true> = {
  end_turn: true, tool_use: true, max_tokens: true, stop_sequence: true, refusal: true,
  content_filter: true, context_limit: true, pause: true, unknown: true,
};

export function readModelCallStop(call: { status?: unknown; stop?: unknown }): ProviderStop | undefined {
  if (call.stop === undefined) return undefined;
  if (call.status !== "responded" || !call.stop || typeof call.stop !== "object" || Array.isArray(call.stop)) {
    throw new TypeError("Stop evidence requires a provider response.");
  }
  const stop = call.stop as Record<string, unknown>;
  if (typeof stop.reason !== "string" || !Object.hasOwn(reasons, stop.reason)
    || Object.keys(stop).some(key => key !== "reason" && key !== "nativeReason")
    || (stop.nativeReason !== undefined && (typeof stop.nativeReason !== "string" || !stop.nativeReason.trim()))) {
    throw new TypeError("Invalid provider stop evidence.");
  }
  return { reason: stop.reason as ProviderStopReason,
    ...(stop.nativeReason === undefined ? {} : { nativeReason: stop.nativeReason as string }) };
}
