// Loading (Section 14): bytes or a URL in, a validated catalog out, or a refusal. Nothing is kept
// from a candidate that fails any check (VAL-1).

import { sha256Hex } from "./canonical.ts";
import { type Catalog, wrapCatalog } from "./catalog.ts";
import { CatalogFetchError, fail } from "./errors.ts";
import { decodeUtf8, JsonSyntaxError, readJson } from "./json.ts";
import { validateCatalog } from "./validate.ts";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface LoadOptions {
  /**
   * The sha256 the bytes must have: 64 lowercase hex characters, and any other spelling is
   * `hash-mismatch` (VAL-2). When a URL is loaded and this is not given, the hash is read from
   * `<url>.sha256` instead, unless `sidecar` is `false`.
   */
  expectedSha256?: string;
  /**
   * The text of a `catalog.json.sha256` file, instead of the digest: the digest is the first
   * whitespace-delimited field of its first line (VAL-2). When both this and `expectedSha256` are
   * given and disagree, the load is refused with `hash-mismatch`. For a URL it replaces the
   * `<url>.sha256` fetch, as `expectedSha256` does.
   */
  expectedSidecar?: string;
  /** Read the expected hash from `<url>.sha256` (default `true`). Only for a URL. */
  sidecar?: boolean;
  /** A `fetch` to use for a URL (default: the global one). */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** The most bytes to read from one response (default 64 MiB). */
  maxBytes?: number;
  /** Allow `http:` URLs. By default only `https:` is fetched. */
  allowInsecureHttp?: boolean;
}

/** Where a catalog comes from: its bytes, or the URL of `catalog.json`. */
export type CatalogSource = Uint8Array | URL | string;

/** Validates the bytes of a candidate catalog. Synchronous and pure. */
function validateBytes(bytes: Uint8Array, expectedSha256: string | undefined): Catalog {
  const digest = sha256Hex(bytes);
  // VAL-2: before parsing.
  if (expectedSha256 !== undefined && digest !== String(expectedSha256)) {
    fail("hash-mismatch", `the bytes have sha256 ${digest}, expected ${String(expectedSha256)}`);
  }
  // JSON-1, JSON-2: on the text, before a number is converted or a value built.
  let reading: ReturnType<typeof readJson>;
  try {
    reading = readJson(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof JsonSyntaxError || error instanceof TypeError) {
      return fail("invalid-json", `the catalog is not JSON: ${error.message}`);
    }
    throw error;
  }
  if (reading.defect !== undefined) {
    const { kind, at } = reading.defect;
    return fail(
      "invalid-json",
      kind === "duplicate-member"
        ? `duplicate member name at ${at}`
        : `a number that is not an integer literal at ${at}`,
    );
  }
  return wrapCatalog(validateCatalog(reading.value, digest));
}

async function readBody(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  if (!response.ok) {
    throw new CatalogFetchError(`${what}: the server answered ${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CatalogFetchError(`${what}: the response is larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (cause) {
    if (cause instanceof CatalogFetchError) throw cause;
    // A stream error, or an abort after the headers, is a failure to read, not a verdict.
    throw new CatalogFetchError(
      `${what}: reading the body failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      { cause },
    );
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * VAL-2: the digest of a sidecar file is the first whitespace-delimited field of its first line. What
 * it holds is not checked here: anything but 64 lowercase hex characters fails the comparison with
 * `hash-mismatch`.
 */
function sidecarDigest(text: string): string {
  const line = (text.split("\n")[0] ?? "").replace(/\r$/, "");
  return line.trim().split(/\s+/)[0] ?? "";
}

/**
 * The digest the caller supplied, as `expectedSha256` or as the text of a sidecar (VAL-2), or
 * `undefined`. When both are supplied and differ, the load is refused with `hash-mismatch`.
 */
function suppliedDigest(options: LoadOptions): string | undefined {
  const digest = options.expectedSha256;
  const fromSidecar =
    options.expectedSidecar === undefined ? undefined : sidecarDigest(options.expectedSidecar);
  if (digest !== undefined && fromSidecar !== undefined && digest !== fromSidecar) {
    fail("hash-mismatch", "expectedSha256 and expectedSidecar name different digests");
  }
  return digest ?? fromSidecar;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** The URL of the sidecar: `.sha256` appended to the path, the query kept and the fragment dropped. */
function sidecarUrlOf(url: URL): URL {
  const sidecar = new URL(url);
  sidecar.hash = "";
  sidecar.pathname = `${sidecar.pathname}.sha256`;
  return sidecar;
}

async function fetchCatalog(
  asked: URL,
  options: LoadOptions,
): Promise<{ bytes: Uint8Array; expected: string | undefined }> {
  // A fragment is never sent to a server.
  const url = new URL(asked);
  url.hash = "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const init: RequestInit = { redirect: "manual" };
  if (options.signal !== undefined) init.signal = options.signal;

  // The policy holds for the URL asked for and for every hop of a redirect.
  const allowed = (target: URL): void => {
    if (
      target.protocol !== "https:" &&
      !(target.protocol === "http:" && options.allowInsecureHttp === true)
    ) {
      throw new CatalogFetchError(`${target.protocol} URLs are not fetched (${target.href})`);
    }
  };

  const get = async (start: URL, what: string): Promise<Uint8Array> => {
    let target = start;
    for (let hop = 0; ; hop += 1) {
      allowed(target);
      let response: Response;
      try {
        response = await doFetch(target, init);
      } catch (cause) {
        throw new CatalogFetchError(
          `${what}: ${cause instanceof Error ? cause.message : "fetch failed"}`,
          { cause },
        );
      }
      if (!REDIRECTS.has(response.status)) return readBody(response, maxBytes, what);
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (location === null) {
        throw new CatalogFetchError(`${what}: a ${response.status} answer without a Location`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new CatalogFetchError(`${what}: more than ${MAX_REDIRECTS} redirects`);
      }
      try {
        target = new URL(location, target);
      } catch (cause) {
        throw new CatalogFetchError(`${what}: the redirect Location is not a URL`, { cause });
      }
    }
  };

  allowed(url);
  let expected = suppliedDigest(options);
  const sidecarUrl = sidecarUrlOf(url);
  const wantSidecar = expected === undefined && options.sidecar !== false;
  const [catalogBytes, sidecarBytes] = await Promise.all([
    get(url, url.href),
    wantSidecar ? get(sidecarUrl, sidecarUrl.href) : Promise.resolve(undefined),
  ]);
  if (sidecarBytes !== undefined) expected = sidecarDigest(new TextDecoder().decode(sidecarBytes));
  return { bytes: catalogBytes, expected };
}

/**
 * Loads a catalog from its bytes or from the URL of `catalog.json`, and validates it as a whole.
 * Throws `AiCatalogError` with the code of a violated rule, or `CatalogFetchError` when a URL could
 * not be read. A URL is checked against `<url>.sha256` unless told otherwise.
 */
export async function load(source: CatalogSource, options: LoadOptions = {}): Promise<Catalog> {
  if (source instanceof Uint8Array) {
    return validateBytes(source, suppliedDigest(options));
  }
  let url: URL;
  try {
    url = source instanceof URL ? source : new URL(source);
  } catch (cause) {
    throw new TypeError("a catalog source is bytes or an absolute URL", { cause });
  }
  const { bytes, expected } = await fetchCatalog(url, options);
  return validateBytes(bytes, expected);
}
