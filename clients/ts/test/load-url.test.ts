// What the conformance vectors do not reach: loading from a URL with a mocked fetch, the check of a
// fetched catalog against its `.sha256`, and the last good copy (VAL-1, VAL-2).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiCatalogError, CatalogClient, CatalogFetchError, load, price } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const text = readFileSync(new URL("conformance/fixtures/text.json", root));
const textSha = createHash("sha256").update(text).digest("hex");
const URL_OF = "https://example.test/data/catalog.json";

type Handler = (url: string) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler | Uint8Array | string | number>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "number") return new Response("failure", { status: route });
    if (typeof route === "function") return route(url);
    return new Response(route as ConstructorParameters<typeof Response>[0]);
  };
  return { fetch: fetcher as typeof fetch, calls };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("load from a URL", () => {
  it("checks the catalog against <url>.sha256 and loads it", async () => {
    const { fetch, calls } = mockFetch({
      [URL_OF]: text,
      [`${URL_OF}.sha256`]: `${textSha}  catalog.json\n`,
    });
    const catalog = await load(URL_OF, { fetch });
    expect(catalog.sha256).toBe(textSha);
    expect(catalog.version).toBe("2026.11.04.1");
    expect(calls.sort()).toEqual([URL_OF, `${URL_OF}.sha256`]);
  });

  it("accepts a URL object and an uppercase digest", async () => {
    const { fetch } = mockFetch({
      [URL_OF]: text,
      [`${URL_OF}.sha256`]: textSha.toUpperCase(),
    });
    await expect(load(new URL(URL_OF), { fetch })).resolves.toMatchObject({ sha256: textSha });
  });

  it("rejects a catalog whose bytes do not match the .sha256 with hash-mismatch", async () => {
    const wrong = `${"0".repeat(63)}1`;
    const { fetch } = mockFetch({ [URL_OF]: text, [`${URL_OF}.sha256`]: `${wrong}  catalog.json` });
    const error = await refusal(load(URL_OF, { fetch }));
    expect(error).toBeInstanceOf(AiCatalogError);
    expect((error as AiCatalogError).code).toBe("hash-mismatch");
  });

  it("checks the hash before it parses: tampered bytes are hash-mismatch, not a parse error", async () => {
    const tampered = new Uint8Array([...text.subarray(0, text.length - 1), 0x00]);
    const { fetch } = mockFetch({ [URL_OF]: tampered, [`${URL_OF}.sha256`]: textSha });
    const error = await refusal(load(URL_OF, { fetch }));
    expect((error as AiCatalogError).code).toBe("hash-mismatch");
  });

  it("uses expectedSha256 instead of fetching the .sha256", async () => {
    const { fetch, calls } = mockFetch({ [URL_OF]: text });
    await load(URL_OF, { fetch, expectedSha256: textSha });
    expect(calls).toEqual([URL_OF]);
    const bad = await refusal(load(URL_OF, { fetch, expectedSha256: "0".repeat(64) }));
    expect((bad as AiCatalogError).code).toBe("hash-mismatch");
  });

  it("skips the .sha256 only when told to", async () => {
    const { fetch, calls } = mockFetch({ [URL_OF]: text });
    await load(URL_OF, { fetch, sidecar: false });
    expect(calls).toEqual([URL_OF]);
  });

  it("validates fetched bytes like any others", async () => {
    const duplicate = readFileSync(
      new URL("conformance/fixtures/invalid/duplicate-member.json", root),
    );
    const sha = createHash("sha256").update(duplicate).digest("hex");
    const { fetch } = mockFetch({ [URL_OF]: duplicate, [`${URL_OF}.sha256`]: sha });
    const error = await refusal(load(URL_OF, { fetch }));
    expect((error as AiCatalogError).code).toBe("invalid-json");
  });

  it("fails closed when the .sha256 is missing or malformed", async () => {
    const missing = mockFetch({ [URL_OF]: text });
    expect(await refusal(load(URL_OF, { fetch: missing.fetch }))).toBeInstanceOf(CatalogFetchError);
    const malformed = mockFetch({ [URL_OF]: text, [`${URL_OF}.sha256`]: "not a digest" });
    expect(await refusal(load(URL_OF, { fetch: malformed.fetch }))).toBeInstanceOf(
      CatalogFetchError,
    );
  });

  it("reports a server error, a network error and an oversized body as CatalogFetchError", async () => {
    const serverError = mockFetch({ [URL_OF]: 503, [`${URL_OF}.sha256`]: textSha });
    expect(await refusal(load(URL_OF, { fetch: serverError.fetch }))).toBeInstanceOf(
      CatalogFetchError,
    );

    const network = mockFetch({
      [URL_OF]: () => {
        throw new TypeError("connection reset");
      },
      [`${URL_OF}.sha256`]: textSha,
    });
    expect(await refusal(load(URL_OF, { fetch: network.fetch }))).toBeInstanceOf(CatalogFetchError);

    const big = mockFetch({ [URL_OF]: text, [`${URL_OF}.sha256`]: textSha });
    expect(await refusal(load(URL_OF, { fetch: big.fetch, maxBytes: 100 }))).toBeInstanceOf(
      CatalogFetchError,
    );
  });

  it("fetches https only, unless http is allowed", async () => {
    const http = "http://example.test/catalog.json";
    const { fetch, calls } = mockFetch({ [http]: text, [`${http}.sha256`]: textSha });
    expect(await refusal(load(http, { fetch }))).toBeInstanceOf(CatalogFetchError);
    expect(calls).toEqual([]);
    await expect(load(http, { fetch, allowInsecureHttp: true })).resolves.toMatchObject({
      sha256: textSha,
    });
    expect(await refusal(load("file:///etc/passwd", { fetch }))).toBeInstanceOf(CatalogFetchError);
    expect(await refusal(load("not a url", { fetch }))).toBeInstanceOf(TypeError);
  });
});

describe("redirects", () => {
  const redirect =
    (to: string, status = 302): Handler =>
    () =>
      new Response(null, { status, headers: { location: to } });

  it("follows an https redirect, relative or absolute, for the catalog and the sidecar", async () => {
    const { fetch, calls } = mockFetch({
      [URL_OF]: redirect("/mirror/catalog.json", 301),
      [`${URL_OF}.sha256`]: redirect("https://cdn.example.test/catalog.json.sha256", 307),
      "https://example.test/mirror/catalog.json": text,
      "https://cdn.example.test/catalog.json.sha256": textSha,
    });
    await expect(load(URL_OF, { fetch })).resolves.toMatchObject({ sha256: textSha });
    expect(calls).toHaveLength(4);
  });

  it("refuses an https URL that redirects to http, and never fetches the target", async () => {
    const insecure = "http://example.test/catalog.json";
    const { fetch, calls } = mockFetch({
      [URL_OF]: redirect(insecure),
      [`${URL_OF}.sha256`]: textSha,
      [insecure]: text,
    });
    const error = await refusal(load(URL_OF, { fetch }));
    expect(error).toBeInstanceOf(CatalogFetchError);
    expect(calls).not.toContain(insecure);
  });

  it("refuses the same downgrade on the sidecar, and on a later hop", async () => {
    const insecure = "http://example.test/catalog.json.sha256";
    const sidecar = mockFetch({
      [URL_OF]: text,
      [`${URL_OF}.sha256`]: redirect(insecure),
      [insecure]: textSha,
    });
    expect(await refusal(load(URL_OF, { fetch: sidecar.fetch }))).toBeInstanceOf(CatalogFetchError);
    expect(sidecar.calls).not.toContain(insecure);

    const chain = mockFetch({
      [URL_OF]: redirect("https://example.test/a"),
      "https://example.test/a": redirect("http://example.test/b"),
      "http://example.test/b": text,
    });
    expect(await refusal(load(URL_OF, { fetch: chain.fetch, sidecar: false }))).toBeInstanceOf(
      CatalogFetchError,
    );
    expect(chain.calls).not.toContain("http://example.test/b");
  });

  it("allows an http hop only when http is allowed, and refuses other schemes", async () => {
    const plain = "http://example.test/catalog.json";
    const allowed = mockFetch({ [URL_OF]: redirect(plain), [plain]: text });
    await expect(
      load(URL_OF, { fetch: allowed.fetch, sidecar: false, allowInsecureHttp: true }),
    ).resolves.toMatchObject({ sha256: textSha });
    const other = mockFetch({ [URL_OF]: redirect("file:///etc/passwd") });
    expect(await refusal(load(URL_OF, { fetch: other.fetch, sidecar: false }))).toBeInstanceOf(
      CatalogFetchError,
    );
  });

  it("gives up on a redirect loop, and on a redirect without a Location", async () => {
    const loop = mockFetch({ [URL_OF]: redirect(URL_OF) });
    expect(await refusal(load(URL_OF, { fetch: loop.fetch, sidecar: false }))).toBeInstanceOf(
      CatalogFetchError,
    );
    expect(loop.calls.length).toBeLessThanOrEqual(10);
    const bare = mockFetch({ [URL_OF]: () => new Response(null, { status: 302 }) });
    expect(await refusal(load(URL_OF, { fetch: bare.fetch, sidecar: false }))).toBeInstanceOf(
      CatalogFetchError,
    );
  });
});

describe("a failure while reading the body", () => {
  const failing =
    (error: Error): Handler =>
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          pull() {
            throw error;
          },
        }),
      );

  it("is a CatalogFetchError with the original as its cause", async () => {
    const original = new Error("connection reset");
    const { fetch } = mockFetch({ [URL_OF]: failing(original), [`${URL_OF}.sha256`]: textSha });
    const error = await refusal(load(URL_OF, { fetch }));
    expect(error).toBeInstanceOf(CatalogFetchError);
    expect((error as CatalogFetchError).cause).toBe(original);
  });

  it("covers an abort after the headers, and a failing sidecar body", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("The operation was aborted", "AbortError");
    const { fetch } = mockFetch({
      [URL_OF]: () => {
        queueMicrotask(() => controller.abort());
        return failing(aborted)(URL_OF);
      },
      [`${URL_OF}.sha256`]: textSha,
    });
    const error = await refusal(load(URL_OF, { fetch, signal: controller.signal }));
    expect(error).toBeInstanceOf(CatalogFetchError);
    expect((error as CatalogFetchError).cause).toBe(aborted);

    const original = new Error("reset");
    const sidecar = mockFetch({ [URL_OF]: text, [`${URL_OF}.sha256`]: failing(original) });
    const sidecarError = await refusal(load(URL_OF, { fetch: sidecar.fetch }));
    expect(sidecarError).toBeInstanceOf(CatalogFetchError);
    expect((sidecarError as CatalogFetchError).cause).toBe(original);
  });
});

describe("the sidecar URL", () => {
  it("appends .sha256 to the path, keeps the query and drops the fragment", async () => {
    const withQuery = "https://example.test/data/catalog.json?v=2&token=a#section";
    const { fetch, calls } = mockFetch({
      "https://example.test/data/catalog.json?v=2&token=a": text,
      "https://example.test/data/catalog.json.sha256?v=2&token=a": textSha,
    });
    await expect(load(withQuery, { fetch })).resolves.toMatchObject({ sha256: textSha });
    expect(calls.sort()).toEqual([
      "https://example.test/data/catalog.json.sha256?v=2&token=a",
      "https://example.test/data/catalog.json?v=2&token=a",
    ]);
  });
});

describe("the published catalog", () => {
  it("loads, and matches data/catalog.json.sha256 (VAL-7)", async () => {
    const bytes = readFileSync(new URL("data/catalog.json", root));
    const sidecar = readFileSync(new URL("data/catalog.json.sha256", root), "utf8");
    const catalog = await load(bytes, { expectedSha256: sidecar.trim().split(/\s+/)[0] as string });
    expect(catalog.schemaVersion).toBe("1.0.0");
  });
});

describe("the last good copy", () => {
  it("keeps the previous catalog when a candidate fails", async () => {
    const client = new CatalogClient();
    expect(client.current).toBeUndefined();
    const good = await client.load(text);
    const broken = readFileSync(new URL("conformance/fixtures/invalid/windows-overlap.json", root));
    const error = await refusal(client.load(broken));
    expect((error as AiCatalogError).code).toBe("windows-overlap");
    expect(client.current).toBe(good);
    // The kept copy still prices.
    expect(
      price(client.require(), {
        provider: "anthropic",
        modelId: "vector-text",
        tier: "anthropic:standard",
        at: "2026-11-04T12:00:00Z",
        settlement: "booked",
        usage: {
          completeness: "complete",
          quantities: {
            input: 1000,
            input_cached: 0,
            cache_write_5m: 0,
            output: 0,
            web_search: 0,
            code_execution: 0,
          },
        },
      }).booked,
    ).toBe("0.01");
  });

  it("starts empty and says so", () => {
    expect(() => new CatalogClient().require()).toThrow(/no catalog/);
  });
});
