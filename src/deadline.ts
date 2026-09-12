import { RuntimeError } from "./types.js";

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new RuntimeError("turn aborted", "turn_aborted", { cause: signal.reason });
}

export function turnDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const expire = () => controller.abort(new Error(`turn timed out after ${timeoutMs}ms`));
  const check = () => {
    if (!controller.signal.aborted && performance.now() >= expiresAt) expire();
    checkAbort(controller.signal);
  };
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    check,
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      check();
      let onAbort!: () => void;
      try {
        const value = await new Promise<T>((resolve, reject) => {
          onAbort = () => reject(new RuntimeError("turn aborted", "turn_aborted", { cause: controller.signal.reason }));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve().then(() => { check(); return operation(); }).then(resolve, reject);
        });
        check();
        return value;
      } catch (error) {
        check();
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      controller.abort(new Error("turn finished"));
    },
  };
}

export type TurnDeadline = ReturnType<typeof turnDeadline>;
