import { randomUUID } from "node:crypto";
import type { TurnDeadline } from "./deadline.js";
import { readModelCallStop } from "./model-call-record.js";
import { withRetry, type RetryPolicy } from "./retry.js";
import type { TurnTrace } from "./tracing.js";
import { RuntimeError, type ModelCallContext, type ModelCallHooks, type ModelCallRecord,
  type ModelProvider, type ProviderRequest, type ProviderResponse, type TurnContext, type TurnReport } from "./types.js";

class ProviderFailure extends Error {}

export async function completeModelCall(
  provider: ModelProvider,
  request: ProviderRequest,
  context: TurnContext,
  report: TurnReport,
  options: { retry: RetryPolicy; maxModelCalls: number; hooks?: ModelCallHooks; deadline: TurnDeadline; checkpoint?: () => Promise<void>; trace?: TurnTrace },
): Promise<ProviderResponse> {
  const { signal } = context;
  const { deadline } = options;
  try {
    return await withRetry(async () => {
      deadline.check();
      if (report.modelCalls.length >= options.maxModelCalls) throw new RuntimeError("model call limit reached", "model_call_limit");
      const trace = options.trace, span = trace?.child();
      const callContext: ModelCallContext = {
        ...context, callId: randomUUID(), provider: provider.name, model: provider.model,
        attempt: report.modelCalls.length + 1, hop: report.hops,
        maxTokens: request.maxTokens, thinking: request.thinking,
        ...(span ? { trace: span.context } : {}),
      };
      let call: ModelCallRecord = {
        callId: callContext.callId, provider: provider.name, attempt: callContext.attempt, hop: report.hops,
        status: "not_started", accounting: "unrecorded",
        ...(span ? { trace: span.context } : {}),
      };
      let failure: unknown;
      if (span) trace?.emit(span, { type: "model.started", callId: call.callId, provider: call.provider,
        model: callContext.model, attempt: call.attempt, hop: call.hop });
      try {
        const callIndex = report.modelCalls.length;
        report.modelCalls.push(call);
        await options.checkpoint?.();
        if (options.hooks?.admit) {
          let admitted: boolean;
          try { admitted = await deadline.run(() => options.hooks!.admit!(callContext)); }
          catch (error) {
            deadline.check();
            throw new RuntimeError("model admission failed", "model_call_admission_failed", { cause: error });
          }
          if (admitted !== true) throw new RuntimeError("host denied model call", "model_call_denied");
        }

        const record = async () => {
          if (!options.hooks?.record) return;
          try {
            await deadline.run(() => options.hooks!.record!(structuredClone(call), callContext));
            call.accounting = "recorded";
          } catch (error) {
            deadline.check();
            throw new RuntimeError("model accounting failed", "model_call_accounting_failed", { cause: error });
          }
        };

        let response: ProviderResponse;
        if (options.checkpoint) {
          call.status = "unknown";
          try { await options.checkpoint(); }
          finally { call.status = "not_started"; }
        }
        try {
          response = await deadline.run(() => {
            call.status = "unknown";
            if (span && trace) {
              trace.emit(span, { type: "model.request", format: "runtime" }, () => {
                const { signal: _, trace: __, ...body } = request;
                return body;
              });
              deadline.check();
            }
            return provider.complete(span && trace ? { ...request, trace: trace.provider(span) } : request);
          });
        } catch (error) {
          deadline.check();
          const info = provider.failureInfo?.(error);
          call.status = info?.status ?? "unknown";
          call.requestId = info?.requestId;
          await options.checkpoint?.();
          await record();
          if (options.hooks?.record) await options.checkpoint?.();
          throw new ProviderFailure("provider failed", { cause: error });
        }
        if (span) trace?.emit(span, { type: "model.response", format: "runtime" }, () => response);
        call = { ...call, status: "responded" };
        report.modelCalls[callIndex] = call;
        call.requestId = response.requestId;
        if (response.usage) {
          call.usage = { ...response.usage };
          report.usage.push({ ...response.usage });
        }
        let invalidStop: unknown;
        try {
          call.stop = readModelCallStop({ status: "responded", stop: { reason: response.stopReason,
            ...(response.nativeStopReason === undefined ? {} : { nativeReason: response.nativeStopReason }) } });
        } catch (cause) { invalidStop = cause; }
        await options.checkpoint?.();
        await record();
        if (options.hooks?.record) await options.checkpoint?.();
        if (invalidStop) throw new RuntimeError("provider returned invalid stop evidence", "invalid_provider_stop", { cause: invalidStop });
        return response;
      } catch (error) { failure = error; throw error; }
      finally {
        if (span && trace) {
          trace.emit(span, { type: "model.finished", record: call, durationMs: trace.duration(span),
            ...(failure === undefined ? {} : { errorCode: failure instanceof RuntimeError ? failure.code : "provider_failed" }) });
          span.closed = true;
          report.trace = trace.summary();
        }
      }
    }, {
      ...options.retry,
      retryable: (error) => error instanceof ProviderFailure
        && (options.retry.retryable?.(error.cause) ?? provider.isRetryable?.(error.cause) ?? false),
    }, signal);
  } catch (error) {
    deadline.check();
    if (error instanceof ProviderFailure) throw new RuntimeError("provider failed", "provider_failed", { cause: error.cause });
    throw error;
  }
}
