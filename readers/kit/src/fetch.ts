// Fetching for evidence.
//
// A reader's fetch keeps the bytes exactly as received: no `Accept-Encoding` header is
// sent, so no content coding is applied. Every hop's status and headers are recorded,
// redirects included, so the retrieval record can show the whole chain. The request
// carries a user agent naming the project, and a timeout.
//
// `Set-Cookie` values are scrubbed to the cookie name in the record, matching the
// layout evidence/README.md describes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FetchedPage, FetchHop } from "./evidence.ts";
import { Unreadable } from "./evidence.ts";

export const KIT_VERSION = "0.1.0";
export const USER_AGENT = `openadviser-ai-catalog/${KIT_VERSION} (+https://github.com/openadviser/ai-catalog)`;

export interface FetchOptions {
  /** Milliseconds before the in-flight request is aborted. */
  timeoutMs?: number;
  /** Redirects followed before giving up. */
  maxHops?: number;
  /** Extra request headers, for example an API key header. Never `Accept-Encoding`. */
  headers?: Record<string, string>;
  userAgent?: string;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Scrubs a `Set-Cookie` header value to `name=[value not kept]`. */
function scrubCookie(value: string): string {
  const name = value.split("=", 1)[0] ?? "";
  return `${name}=[value not kept]`;
}

interface HopResult {
  status: number;
  headers: [string, string][];
  location?: string;
  bytes: Buffer;
}

function getOnce(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<HopResult> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Unreadable("too-large", `${url} body exceeds ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw = res.rawHeaders;
          const headers: [string, string][] = [];
          for (let i = 0; i + 1 < raw.length; i += 2) {
            const name = (raw[i] ?? "").toLowerCase();
            const value = raw[i + 1] ?? "";
            headers.push([name, name === "set-cookie" ? scrubCookie(value) : value]);
          }
          const location = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            headers,
            ...(typeof location === "string" ? { location } : {}),
            bytes: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Unreadable("timeout", `${url} did not answer within ${timeoutMs}ms`));
    });
    req.on("error", (error) => {
      reject(
        error instanceof Unreadable
          ? error
          : new Unreadable("fetch-failed", `${url}: ${error.message}`),
      );
    });
    req.end();
  });
}

/**
 * GETs `url`, following redirects up to `maxHops`. Sends no `Accept-Encoding`, so the
 * body is stored exactly as received. Every hop's status and headers are kept.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxHops = options.maxHops ?? 5;
  const userAgent = options.userAgent ?? USER_AGENT;
  for (const name of Object.keys(options.headers ?? {})) {
    if (name.toLowerCase() === "accept-encoding") {
      throw new Unreadable(
        "fetch-failed",
        "Accept-Encoding must not be sent; the bytes are kept as received",
      );
    }
  }

  const hops: FetchHop[] = [];
  const requestedAt = now();
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Unreadable("bad-url", `cannot parse ${current}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Unreadable("bad-url", `${current}: only http(s) URLs can be fetched`);
    }
    const result = await getOnce(
      parsed,
      {
        "user-agent": userAgent,
        host: parsed.host,
        connection: "close",
        ...(options.headers ?? {}),
      },
      timeoutMs,
    );
    hops.push({ protocol: "HTTP/1.1", status: result.status, headers: result.headers });
    if (REDIRECT.has(result.status) && result.location !== undefined) {
      current = new URL(result.location, parsed).toString();
      continue;
    }
    return {
      requestedUrl: url,
      finalUrl: current,
      retrievedAt: requestedAt,
      status: result.status,
      bytes: result.bytes,
      hops,
    };
  }
  throw new Unreadable("too-many-hops", `${url}: more than ${maxHops} redirects`);
}
