import { IMAGE_INPUT_LIMITS, RuntimeError, type ImageBlock, type InputBlock, type InputContent, type ProviderMessage } from "./types.js";

function invalid(): never {
  throw new RuntimeError("input must contain supported text or base64 image blocks", "invalid_input");
}

function limit(): never {
  throw new RuntimeError("image input exceeds the supported count or byte limit", "image_input_limit");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !("value" in field))) return invalid();
  return value as Record<string, unknown>;
}

function imageBytes(value: Record<string, unknown>): number {
  const { data, mediaType } = value;
  if (Object.keys(value).some(key => !["type", "mediaType", "data"].includes(key))
    || typeof data !== "string" || !data.length
    || !["image/png", "image/jpeg", "image/webp"].includes(mediaType as string)) return invalid();
  if (data.length > Math.ceil(IMAGE_INPUT_LIMITS.maxImageBytes / 3) * 4) return limit();
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    || Buffer.from(data.slice(-4), "base64").toString("base64") !== data.slice(-4)) return invalid();
  const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > IMAGE_INPUT_LIMITS.maxImageBytes) return limit();
  const header = Buffer.from(data.slice(0, 24), "base64");
  const matches = mediaType === "image/png" ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg" ? header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : header.subarray(0, 4).equals(Buffer.from("RIFF")) && header.subarray(8, 12).equals(Buffer.from("WEBP"));
  if (!matches) return invalid();
  return bytes;
}

function addImage(value: Record<string, unknown>, totals: { count: number; bytes: number }): void {
  if (++totals.count > IMAGE_INPUT_LIMITS.maxImages) limit();
  totals.bytes += imageBytes(value);
  if (totals.bytes > IMAGE_INPUT_LIMITS.maxTotalImageBytes) limit();
}

export function readInputContent(value: unknown): InputContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.length) return invalid();
  const totals = { count: 0, bytes: 0 };
  return Object.freeze(Array.from(value, (part): InputBlock => {
    const block = object(part);
    if (block.type === "text") {
      if (typeof block.text !== "string" || Object.keys(block).some(key => !["type", "text"].includes(key))) return invalid();
      return Object.freeze({ type: "text", text: block.text });
    }
    if (block.type !== "image") return invalid();
    addImage(block, totals);
    return Object.freeze({ type: "image", mediaType: block.mediaType as ImageBlock["mediaType"], data: block.data as string });
  }));
}

export function validateImageMessages(messages: readonly ProviderMessage[], supported: boolean): void {
  const totals = { count: 0, bytes: 0 };
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content as readonly unknown[]) {
      const block = object(value);
      if (block.type !== "image") continue;
      if (message.role !== "user") invalid();
      addImage(block, totals);
      if (!supported) throw new RuntimeError("provider does not support image input", "images_unsupported");
    }
  }
}
