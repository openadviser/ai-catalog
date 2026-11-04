// A strict JSON reader (RFC 8259) that sees what a general parser hides: JSON-1 (duplicate member
// names, compared after unescaping) and JSON-2 (a number literal that is not an integer literal).
// Both are checked on the text, before any number is converted.

export type JsonObject = { [key: string]: JsonValue };
/** An integer literal is a `number` when it is a safe integer and a `bigint` otherwise. */
export type JsonValue = null | boolean | string | number | bigint | JsonValue[] | JsonObject;

export type JsonDefect = "duplicate-member" | "non-integer-number";

export interface JsonReading {
  value: JsonValue;
  /** The first defect met, or `undefined`. A defect does not stop the reading. */
  defect: { kind: JsonDefect; at: string } | undefined;
}

export class JsonSyntaxError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonSyntaxError";
  }
}

const MAX_DEPTH = 512;
const INTEGER_LITERAL = /^-?(0|[1-9][0-9]*)$/;

/**
 * Reads `text`. Throws `JsonSyntaxError` when it is not JSON. A duplicate member name or a number
 * literal with a fraction or an exponent is reported in `defect`, for the caller to refuse.
 */
export function readJson(text: string): JsonReading {
  let pos = 0;
  let defect: JsonReading["defect"];
  const note = (kind: JsonDefect, at: string): void => {
    defect ??= { kind, at };
  };

  const syntax = (message: string): never => {
    throw new JsonSyntaxError(message, pos);
  };

  const skipSpace = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos += 1;
      else break;
    }
  };

  const readString = (): string => {
    // text[pos] is the opening quote.
    pos += 1;
    let out = "";
    let runStart = pos;
    for (;;) {
      if (pos >= text.length) syntax("unterminated string");
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        out += text.slice(runStart, pos);
        pos += 1;
        break;
      }
      if (c < 0x20) syntax("control character in string");
      if (c === 0x5c) {
        out += text.slice(runStart, pos);
        pos += 1;
        const e = text[pos];
        switch (e) {
          case '"':
          case "\\":
          case "/":
            out += e;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) syntax("invalid \\u escape");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            syntax("invalid escape");
        }
        pos += 1;
        runStart = pos;
        continue;
      }
      pos += 1;
    }
    if (!out.isWellFormed()) syntax("unpaired surrogate in string");
    return out;
  };

  const digit = (at: number): boolean => {
    const c = text.charCodeAt(at);
    return c >= 0x30 && c <= 0x39;
  };

  const readNumber = (path: string): number | bigint => {
    const start = pos;
    if (text[pos] === "-") pos += 1;
    if (text[pos] === "0") {
      pos += 1;
    } else if (digit(pos)) {
      while (digit(pos)) pos += 1;
    } else {
      syntax("invalid number");
    }
    let integer = true;
    if (text[pos] === ".") {
      integer = false;
      pos += 1;
      const digits = pos;
      while (digit(pos)) pos += 1;
      if (pos === digits) syntax("invalid number");
    }
    if (text[pos] === "e" || text[pos] === "E") {
      integer = false;
      pos += 1;
      if (text[pos] === "+" || text[pos] === "-") pos += 1;
      const digits = pos;
      while (digit(pos)) pos += 1;
      if (pos === digits) syntax("invalid number");
    }
    const literal = text.slice(start, pos);
    if (!integer || !INTEGER_LITERAL.test(literal)) {
      note("non-integer-number", `${path}: ${literal}`);
      return Number(literal);
    }
    const big = BigInt(literal);
    if (big >= -9007199254740991n && big <= 9007199254740991n) return Number(big) + 0; // -0 → 0
    return big;
  };

  const readValue = (depth: number, path: string): JsonValue => {
    if (depth > MAX_DEPTH) syntax("nesting too deep");
    skipSpace();
    const c = text[pos];
    if (c === "{") {
      pos += 1;
      const object: JsonObject = Object.create(null) as JsonObject;
      skipSpace();
      if (text[pos] === "}") {
        pos += 1;
        return object;
      }
      for (;;) {
        skipSpace();
        if (text[pos] !== '"') syntax("expected a member name");
        const name = readString();
        skipSpace();
        if (text[pos] !== ":") syntax("expected ':'");
        pos += 1;
        const member = `${path}/${name}`;
        const value = readValue(depth + 1, member);
        if (Object.hasOwn(object, name)) note("duplicate-member", member);
        object[name] = value;
        skipSpace();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "}") {
          pos += 1;
          return object;
        }
        syntax("expected ',' or '}'");
      }
    }
    if (c === "[") {
      pos += 1;
      const array: JsonValue[] = [];
      skipSpace();
      if (text[pos] === "]") {
        pos += 1;
        return array;
      }
      for (;;) {
        array.push(readValue(depth + 1, `${path}/${array.length}`));
        skipSpace();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "]") {
          pos += 1;
          return array;
        }
        syntax("expected ',' or ']'");
      }
    }
    if (c === '"') return readString();
    if (c === "-" || digit(pos)) return readNumber(path);
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    return syntax("unexpected character");
  };

  const value = readValue(0, "");
  skipSpace();
  if (pos < text.length) syntax("unexpected text after the document");
  return { value, defect };
}

/** Decodes UTF-8 strictly. A byte order mark is not JSON, and is refused. */
export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new JsonSyntaxError("byte order mark", 0);
  return text;
}
