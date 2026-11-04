// BASIS-2: the RFC 8785 (JSON Canonicalization Scheme) serialization, on the value types a basis holds:
// strings, nonnegative integers below 2^53, null, arrays and objects.

import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | string
  | number
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function quote(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += value[i];
  }
  return `${out}"`;
}

export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("not a nonnegative integer");
    return value.toString();
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  // Member names are compared by UTF-16 code units, which is the default order of `sort`.
  const object = value as { readonly [key: string]: CanonicalValue };
  const members = Object.keys(object)
    .sort()
    .map((name) => `${quote(name)}:${canonicalize(object[name] as CanonicalValue)}`);
  return `{${members.join(",")}}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
