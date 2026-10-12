export function parseObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("expected object arguments");
  return input as Record<string, unknown>;
}
