import type { JsonValue } from "./types.js";

/**
 * RFC 8785 JSON Canonicalization Scheme. Objects get their keys sorted by
 * UTF-16 code unit (the default JavaScript string order) and no whitespace;
 * numbers and strings use the ECMAScript serialization RFC 8785 adopts, which
 * is what JSON.stringify produces for a finite number or a string.
 *
 * Throws on values JSON cannot carry (undefined, functions, non-finite
 * numbers), so a digest is never taken over something the other side could
 * not have received.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`JCS: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        if (obj[key] === undefined) throw new TypeError(`JCS: undefined value at key ${JSON.stringify(key)}`);
        parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: cannot serialize a ${typeof value}`);
  }
}

/**
 * The value the other side of a JSON request actually sees: undefined becomes
 * null, nested undefined members disappear, Dates become strings, non-finite
 * numbers become null. Hash this, never the raw in-memory object.
 */
export function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as JsonValue);
}
