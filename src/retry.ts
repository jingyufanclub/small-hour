export interface RetryPolicy {
  attempts: number;
  delayMs: (attempt: number) => number;
  retryable?: (error: unknown) => boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 3,
  delayMs: (attempt) => 1_200 * attempt,
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!delayMs) return;
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal!));
    };
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy, signal?: AbortSignal): Promise<T> {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new TypeError("retry attempts must be a positive integer");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === policy.attempts || policy.retryable?.(error) === false) throw error;
      const delay = Math.max(0, policy.delayMs(attempt));
      await wait(delay, signal);
    }
  }

  throw lastError;
}
