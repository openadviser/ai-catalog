// Loading (Section 14): bytes or a URL in, a validated catalog out, or a refusal. Nothing is kept
// from a candidate that fails any check (VAL-1).

import { sha256Hex } from "./canonical.ts";
import { type Catalog, wrapCatalog } from "./catalog.ts";
import { CatalogFetchError, fail } from "./errors.ts";
import { decodeUtf8, JsonSyntaxError, readJson } from "./json.ts";
import { validateCatalog } from "./validate.ts";

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface LoadOptions {
  /**
   * The sha256 the bytes must have, as lowercase hex (VAL-2). When a URL is loaded and this is not
   * given, the hash is read from `<url>.sha256` instead, unless `sidecar` is `false`.
   */
  expectedSha256?: string;
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
  if (expectedSha256 !== undefined && digest !== String(expectedSha256).toLowerCase()) {
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
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function sidecarDigest(bytes: Uint8Array, what: string): string {
  // `sha256sum` writes "<hex>  <name>"; only the first token is the digest.
  const token = new TextDecoder().decode(bytes).trim().split(/\s+/)[0] ?? "";
  if (!SHA256_HEX.test(token)) {
    throw new CatalogFetchError(`${what}: not a sha256 digest`);
  }
  return token.toLowerCase();
}

async function fetchCatalog(
  url: URL,
  options: LoadOptions,
): Promise<{ bytes: Uint8Array; expected: string | undefined }> {
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && options.allowInsecureHttp === true)
  ) {
    throw new CatalogFetchError(`${url.protocol} URLs are not fetched`);
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const init = options.signal === undefined ? {} : { signal: options.signal };

  const get = async (target: URL, what: string): Promise<Uint8Array> => {
    let response: Response;
    try {
      response = await doFetch(target, init);
    } catch (cause) {
      throw new CatalogFetchError(
        `${what}: ${cause instanceof Error ? cause.message : "fetch failed"}`,
        {
          cause,
        },
      );
    }
    return readBody(response, maxBytes, what);
  };

  let expected = options.expectedSha256;
  const sidecarUrl = new URL(`${url.href}.sha256`);
  const wantSidecar = expected === undefined && options.sidecar !== false;
  const [catalogBytes, sidecarBytes] = await Promise.all([
    get(url, url.href),
    wantSidecar ? get(sidecarUrl, sidecarUrl.href) : Promise.resolve(undefined),
  ]);
  if (sidecarBytes !== undefined) expected = sidecarDigest(sidecarBytes, sidecarUrl.href);
  return { bytes: catalogBytes, expected };
}

/**
 * Loads a catalog from its bytes or from the URL of `catalog.json`, and validates it as a whole.
 * Throws `AiCatalogError` with the code of a violated rule, or `CatalogFetchError` when a URL could
 * not be read. A URL is checked against `<url>.sha256` unless told otherwise.
 */
export async function load(source: CatalogSource, options: LoadOptions = {}): Promise<Catalog> {
  if (source instanceof Uint8Array) return validateBytes(source, options.expectedSha256);
  let url: URL;
  try {
    url = source instanceof URL ? source : new URL(source);
  } catch (cause) {
    throw new TypeError("a catalog source is bytes or an absolute URL", { cause });
  }
  const { bytes, expected } = await fetchCatalog(url, options);
  return validateBytes(bytes, expected);
}
