// Paginated model-list API reads.
//
// An API read only happens live (`npm run read -- <provider> --live`) with the key in an
// environment variable — never a file, never baked in. In tests the same pagination
// runs over saved response fixtures, so no live call is ever needed to check the
// parsing. Absence from a list is never retirement: a page of items only ever yields
// `ok` model readings for what it contains.
//
// Every response body is stored as evidence like a page, and the account scope the
// list was read with is recorded on the report.
import type { Evidence, FetchedPage } from "./evidence.ts";
import { NeedsReview, Unreadable } from "./evidence.ts";

/** Loads one page of a list: live this is `fetchPage`; in tests it is a fixture map. */
export type PageLoader = (url: string) => Promise<FetchedPage>;

export interface PaginatedSpec<T> {
  /** The first page's URL. */
  start: string;
  /** The next page's URL from a decoded page, or null when the list ends. */
  next: (json: unknown, url: string) => string | null;
  /** The items a page holds. */
  items: (json: unknown) => T[];
}

export interface ApiPage<T> {
  evidence: Evidence;
  json: unknown;
  items: T[];
}

/**
 * Reads a whole paginated list through `load`. Throws Unreadable on a non-200 page or a
 * body that is not JSON; the item shape stays each reader's own assertion.
 */
export async function readPaged<T>(
  spec: PaginatedSpec<T>,
  load: PageLoader,
  keep: (page: FetchedPage) => Evidence,
): Promise<ApiPage<T>[]> {
  const pages: ApiPage<T>[] = [];
  let url: string | null = spec.start;
  const seen = new Set<string>();
  while (url !== null) {
    if (seen.has(url)) throw new Unreadable("fetch-failed", `pagination loop at ${url}`);
    seen.add(url);
    const fetched = await load(url);
    if (fetched.status !== 200) {
      throw new Unreadable("fetch-failed", `${url}: status ${fetched.status}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(fetched.bytes.toString("utf8"));
    } catch {
      throw new Unreadable("wrong-document", `${url}: the body is not JSON`);
    }
    const evidence = keep(fetched);
    const items = spec.items(json);
    pages.push({ evidence, json, items });
    url = spec.next(json, url);
  }
  return pages;
}

/** The API key from `envName`, which must be set and non-empty. */
export function apiKey(
  envName: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env[envName];
  if (key === undefined || key.trim() === "") {
    throw new Unreadable(
      "no-key",
      `$${envName} is not set; an API read needs the key in the environment`,
    );
  }
  return key;
}

/** Asserts a decoded page is a JSON object and returns it. */
export function asObject(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new NeedsReview("structure", `${what}: the response is not a JSON object`);
  }
  return json as Record<string, unknown>;
}

/** Asserts a field is an array and returns it. */
export function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new NeedsReview("structure", `${what}: expected an array`);
  }
  return value;
}

// ---- byte spans inside a JSON body, for provenance ----

/** The byte span `[start, end)` of one element of a top-level array. */
export interface JsonSpan {
  start: number;
  end: number;
}

function skipWs(text: string, i: number): number {
  while (
    i < text.length &&
    (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
  )
    i += 1;
  return i;
}

/** The end of the JSON value beginning at `i` (object, array, string or literal). */
export function jsonValueEnd(text: string, i: number): number {
  const first = text[i];
  if (first === '"') {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === "\\") j += 1;
      else if (text[j] === '"') return j + 1;
    }
    throw new NeedsReview("structure", "unterminated JSON string");
  }
  if (first === "{" || first === "[") {
    const open = first === "{" ? "{" : "[";
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (c === '"') {
        j = jsonValueEnd(text, j) - 1;
      } else if (c === open) {
        depth += 1;
      } else if (c === close) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    throw new NeedsReview("structure", `unterminated JSON ${open}`);
  }
  const m = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|^true|^false|^null/.exec(text.slice(i));
  if (m === null) throw new NeedsReview("structure", `not a JSON value at byte ${i}`);
  return i + m[0].length;
}

/**
 * The byte spans of the elements of `"<key>": [ … ]` in a JSON body. The spans are
 * exact, so an API reading cites the same bytes it parsed — never a reserialized item.
 */
export function jsonArraySpans(text: string, key: string): JsonSpan[] {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (keyMatch === null) throw new NeedsReview("structure", `no "${key}" array in the response`);
  let i = keyMatch.index + keyMatch[0].length;
  const spans: JsonSpan[] = [];
  for (;;) {
    i = skipWs(text, i);
    const c = text[i];
    if (c === "]") return spans;
    if (c === ",") {
      i += 1;
      continue;
    }
    if (c === undefined) throw new NeedsReview("structure", `unterminated "${key}" array`);
    const end = jsonValueEnd(text, i);
    spans.push({ start: i, end });
    i = end;
  }
}

/** The span of `"<key>": <value>`'s value within `text`, searched from `from`. */
export function jsonFieldSpan(text: string, key: string, from = 0): JsonSpan {
  const keyMatch = new RegExp(`"${key}"\\s*:`).exec(text.slice(from));
  if (keyMatch === null) throw new NeedsReview("structure", `no "${key}" field from byte ${from}`);
  const valueStart = skipWs(text, from + keyMatch.index + keyMatch[0].length);
  return { start: valueStart, end: jsonValueEnd(text, valueStart) };
}
