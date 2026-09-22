import { RuntimeError, type AssistantBlock, type TokenUsage } from "../types.js";

export class HttpProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly requestId?: string, readonly transient = false, options?: ErrorOptions) {
    super(message, options);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("expected a JSON object");
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

export function endpoint(baseURL: string, path: string): string {
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("provider baseURL must be an HTTP(S) URL without credentials, query, or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return url.href;
}

export async function postJson(url: string, body: unknown, signal: AbortSignal, apiKey?: string, send: typeof globalThis.fetch = globalThis.fetch) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const serialized = JSON.stringify(body);
  let response: Response;
  try {
    response = await send(url, { method: "POST", headers, body: serialized, signal, redirect: "error" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HttpProviderError("provider connection failed", undefined, undefined, true, { cause: error });
  }
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpProviderError(`provider returned HTTP ${response.status}`, response.status, requestId,
      [408, 409, 429].includes(response.status) || response.status >= 500);
  }
  try { return { data: object(await response.json()), requestId }; }
  catch (error) { throw invalidResponse(error, requestId); }
}

export function invalidResponse(error: unknown, requestId?: string): Error {
  return new HttpProviderError("provider returned an invalid response", undefined, requestId, false, { cause: error });
}

export function isRetryableHttpError(error: unknown): boolean {
  return error instanceof HttpProviderError && error.transient;
}

export function httpFailureInfo(error: unknown): { status: "rejected" | "unknown"; requestId?: string } {
  const failure = error instanceof HttpProviderError ? error : undefined;
  const status = failure?.status ?? 0;
  return { status: status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown", requestId: failure?.requestId };
}

export function tokenUsage(model: unknown, input: unknown, output: unknown, details: unknown): TokenUsage | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  try {
    const counts = details == null ? {} : object(details);
    const read = counts.cached_tokens ?? 0;
    const write = counts.cache_write_tokens ?? 0;
    if (![input, output, read, write].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined;
    const fresh = (input as number) - (read as number) - (write as number);
    if (fresh < 0) return undefined;
    return { model, freshInputTokens: fresh, cacheReadTokens: read as number, cacheWriteTokens: write as number, outputTokens: output as number };
  } catch { return undefined; }
}

export function opaquePayload(content: AssistantBlock[], protocol: string): unknown | undefined {
  const opaque = content.filter((block) => block.type === "opaque");
  if (!opaque.length) return undefined;
  if (opaque.length !== 1) throw new RuntimeError("ambiguous provider history", "provider_history_invalid");
  const value = object(opaque[0].value);
  if (value.protocol !== protocol || value.payload === undefined) throw new RuntimeError("history belongs to an incompatible provider", "provider_history_invalid");
  return value.payload;
}
