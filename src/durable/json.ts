export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null) throw new TypeError("Expected JSON data");
  if (ancestors.has(value)) throw new TypeError("JSON data must not contain cycles");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new TypeError("Expected a dense JSON array");
      return `[${Array.from({ length: value.length }, (_, index) => {
        const property = descriptors[String(index)];
        if (!property || !property.enumerable || !("value" in property)) throw new TypeError("Expected JSON array entries");
        return canonicalJson(property.value, ancestors);
      }).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Expected a plain JSON object");
    if (keys.some(key => typeof key !== "string")) throw new TypeError("JSON object keys must be strings");
    return `{${(keys as string[]).sort().map(key => {
      const property = descriptors[key];
      if (!property.enumerable || !("value" in property)) throw new TypeError("Expected JSON object entries");
      return `${JSON.stringify(key)}:${canonicalJson(property.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
