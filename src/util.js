import { randomUUID } from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

// RFC 3339 时间必须带时区偏移（Z 或 ±hh:mm），拒绝裸时间。
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value) {
  if (typeof value !== "string" || !RFC3339.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

export function isoNow(now) {
  return now().toISOString();
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求体超过大小限制");
      error.code = "payload_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法 JSON");
    error.code = "invalid_json";
    throw error;
  }
}
