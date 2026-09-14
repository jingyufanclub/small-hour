import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";

export function deadlineClock(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return {
    tick(ms: number) { now += ms; t.mock.timers.tick(ms); },
    elapse(ms: number) { now += ms; },
  };
}

export function callbackGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    async wait() { enter(); await blocked; },
    async release() { release(); await setImmediate(); },
  };
}
