export interface RetryPolicy {
  attempts: number;
  delayMs: (attempt: number) => number;
  retryable?: (error: unknown) => boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 3,
  delayMs: (attempt) => 1_200 * attempt,
};

export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new TypeError("retry attempts must be a positive integer");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === policy.attempts || policy.retryable?.(error) === false) throw error;
      const delay = Math.max(0, policy.delayMs(attempt));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
