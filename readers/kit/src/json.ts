// A JSON parser that keeps byte spans and number literals, for readers of published JSON.
//
// A cross-check reader cites the exact bytes it read, so every node records its byte span
// in the evidence body. Numbers keep their literal text, never a binary float: an amount is
// converted from the literal to an exact decimal string. A duplicate member name is an
// error (a parser that kept either value could read the same bytes two ways), and so is
// nesting deeper than 512 levels.
//
// The parser works on bytes. JSON's structural characters are ASCII, and inside a string
// a byte of 0x80 or above is part of a UTF-8 sequence, never a quote or a backslash, so
// byte offsets need no decoding.
import { NeedsReview } from "./evidence.ts";

export type JsonNode = JsonObject | JsonArray | JsonString | JsonNumber | JsonLiteral;

interface Span {
  /** Byte offset of the node's first byte. */
  start: number;
  /** Byte offset just past the node's last byte. */
  end: number;
}

export interface JsonMember {
  name: string;
  /** Byte offset of the member name's opening quote. */
  nameStart: number;
  value: JsonNode;
}

export interface JsonObject extends Span {
  type: "object";
  members: JsonMember[];
}

export interface JsonArray extends Span {
  type: "array";
  items: JsonNode[];
}

export interface JsonString extends Span {
  type: "string";
  value: string;
}

export interface JsonNumber extends Span {
  type: "number";
  /** The literal exactly as written. */
  literal: string;
}

export interface JsonLiteral extends Span {
  type: "literal";
  value: true | false | null;
}

const MAX_DEPTH = 512;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

class Parser {
  readonly bytes: Buffer;
  pos = 0;

  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }

  fail(message: string): never {
    throw new NeedsReview("structure", `JSON at byte ${this.pos}: ${message}`);
  }

  ws(): void {
    while (this.pos < this.bytes.length && WS.has(this.bytes[this.pos] as number)) this.pos += 1;
  }

  value(depth: number): JsonNode {
    if (depth > MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH}`);
    this.ws();
    const c = this.bytes[this.pos];
    if (c === 0x7b) return this.object(depth);
    if (c === 0x5b) return this.array(depth);
    if (c === 0x22) return this.string();
    if (c === 0x2d || (c !== undefined && c >= 0x30 && c <= 0x39)) return this.number();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.bytes.toString("latin1", this.pos, this.pos + word.length) === word) {
        const start = this.pos;
        this.pos += word.length;
        return { type: "literal", start, end: this.pos, value };
      }
    }
    return this.fail("expected a value");
  }

  object(depth: number): JsonObject {
    const start = this.pos;
    this.pos += 1;
    const members: JsonMember[] = [];
    const names = new Set<string>();
    this.ws();
    if (this.bytes[this.pos] === 0x7d) {
      this.pos += 1;
      return { type: "object", start, end: this.pos, members };
    }
    for (;;) {
      this.ws();
      if (this.bytes[this.pos] !== 0x22) this.fail("expected a member name");
      const nameStart = this.pos;
      const name = this.string().value;
      if (names.has(name)) this.fail(`duplicate member ${JSON.stringify(name)}`);
      names.add(name);
      this.ws();
      if (this.bytes[this.pos] !== 0x3a) this.fail(`expected ':' after ${JSON.stringify(name)}`);
      this.pos += 1;
      const value = this.value(depth + 1);
      members.push({ name, nameStart, value });
      this.ws();
      const c = this.bytes[this.pos];
      if (c === 0x2c) {
        this.pos += 1;
        continue;
      }
      if (c === 0x7d) {
        this.pos += 1;
        return { type: "object", start, end: this.pos, members };
      }
      this.fail("expected ',' or '}'");
    }
  }

  array(depth: number): JsonArray {
    const start = this.pos;
    this.pos += 1;
    const items: JsonNode[] = [];
    this.ws();
    if (this.bytes[this.pos] === 0x5d) {
      this.pos += 1;
      return { type: "array", start, end: this.pos, items };
    }
    for (;;) {
      items.push(this.value(depth + 1));
      this.ws();
      const c = this.bytes[this.pos];
      if (c === 0x2c) {
        this.pos += 1;
        continue;
      }
      if (c === 0x5d) {
        this.pos += 1;
        return { type: "array", start, end: this.pos, items };
      }
      this.fail("expected ',' or ']'");
    }
  }

  string(): JsonString {
    const start = this.pos;
    let i = this.pos + 1;
    for (;;) {
      const c = this.bytes[i];
      if (c === undefined) this.fail("unterminated string");
      if (c === 0x5c) {
        i += 2;
        continue;
      }
      if (c === 0x22) break;
      if (c < 0x20) this.fail("control character in a string");
      i += 1;
    }
    this.pos = i + 1;
    let value: string;
    try {
      value = JSON.parse(this.bytes.toString("utf8", start, this.pos)) as string;
    } catch {
      return this.fail("invalid string");
    }
    return { type: "string", start, end: this.pos, value };
  }

  number(): JsonNumber {
    const start = this.pos;
    const rest = this.bytes.toString("latin1", start, Math.min(start + 64, this.bytes.length));
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (m === null) return this.fail("invalid number");
    this.pos = start + m[0].length;
    return { type: "number", start, end: this.pos, literal: m[0] };
  }
}

/** Parses a whole JSON document, keeping byte spans. Throws NeedsReview on any fault. */
export function parseJsonSpans(bytes: Buffer): JsonNode {
  const parser = new Parser(bytes);
  const root = parser.value(1);
  parser.ws();
  if (parser.pos !== bytes.length) parser.fail("trailing bytes after the document");
  return root;
}

/** The member `name` of an object node, or undefined. */
export function member(node: JsonNode | undefined, name: string): JsonMember | undefined {
  if (node?.type !== "object") return undefined;
  return node.members.find((m) => m.name === name);
}

/** The value of member `name`, or undefined. */
export function memberValue(node: JsonNode | undefined, name: string): JsonNode | undefined {
  return member(node, name)?.value;
}

/** A string member's value, or undefined. */
export function stringMember(node: JsonNode | undefined, name: string): string | undefined {
  const value = memberValue(node, name);
  return value?.type === "string" ? value.value : undefined;
}

/**
 * The exact decimal string a JSON number literal denotes, in plain notation: `"0.075"`,
 * `"2"`, `"1.5e-1"` → `"0.15"`. A negative literal is not an amount and returns undefined.
 */
export function literalToDecimal(literal: string): string | undefined {
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(literal);
  if (m === null || m[1] === "-") return undefined;
  const intPart = m[2] as string;
  const frac = m[3] ?? "";
  const exp = Number(m[4] ?? "0");
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 64) return undefined;
  if (m[4] === undefined) return frac === "" ? intPart : `${intPart}.${frac}`;
  let digits = `${intPart}${frac}`;
  let point = intPart.length + exp;
  if (point <= 0) {
    digits = `${"0".repeat(1 - point)}${digits}`;
    point = 1;
  } else if (point > digits.length) {
    digits = `${digits}${"0".repeat(point - digits.length)}`;
  }
  const whole = digits.slice(0, point).replace(/^0+(?=[0-9])/, "");
  const fraction = digits.slice(point);
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** The bytes of a node's span as text. */
export function spanText(bytes: Buffer, start: number, end: number): string {
  return bytes.toString("utf8", start, end);
}
