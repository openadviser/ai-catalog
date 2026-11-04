// The paginated Models API reads, over documented example responses — the fixtures
// next to each reader — never a live call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANTHROPIC_URLS,
  anthropicModelPageUrls,
  readAnthropicApi,
} from "@openadviser/ai-catalog-reader-anthropic";
import { ELEVENLABS_URLS, readElevenlabsApi } from "@openadviser/ai-catalog-reader-elevenlabs";
import { GEMINI_URLS, readGeminiApi } from "@openadviser/ai-catalog-reader-gemini";
import { OPENAI_URLS, readOpenaiApi } from "@openadviser/ai-catalog-reader-openai";
import {
  type ApiPage,
  Evidence,
  type FetchedPage,
  Readings,
  type ReadReport,
  readPaged,
  type TrackedScope,
  Unreadable,
} from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import { ROOT, scope } from "./testing.ts";

function evOf(path: string, url: string): Evidence {
  return new Evidence({ bytes: readFileSync(path), url, retrievedAt: "2026-11-04T18:00:00Z" });
}

function fetched(bytes: Buffer, url: string): FetchedPage {
  return {
    requestedUrl: url,
    finalUrl: url,
    retrievedAt: "2026-11-04T18:00:00Z",
    status: 200,
    bytes,
    hops: [],
  };
}

function ctx(sc: TrackedScope) {
  return {
    scope: sc,
    readings: new Readings(sc.provider),
    sources: [] as { source: string; url: string; evidence: string; retrievedAt: string }[],
  };
}

describe("readPaged", () => {
  it("follows next-page links and keeps every page as evidence", async () => {
    const bodies = new Map<string, Buffer>([
      [
        "https://api.example.test/models",
        Buffer.from('{"data":[1,2],"has_more":true,"last_id":"2"}'),
      ],
      ["https://api.example.test/models?after_id=2", Buffer.from('{"data":[3],"has_more":false}')],
    ]);
    const kept: string[] = [];
    const read = await readPaged<number>(
      {
        start: "https://api.example.test/models",
        items: (json) => (json as { data: number[] }).data,
        next: (json) => {
          const p = json as { has_more?: boolean; last_id?: string };
          return p.has_more === true
            ? `https://api.example.test/models?after_id=${p.last_id}`
            : null;
        },
      },
      async (url) => fetched(bodies.get(url) ?? Buffer.from("missing"), url),
      (page) => {
        kept.push(page.finalUrl);
        return evOf("/dev/null", page.finalUrl);
      },
    );
    expect(read.pages.flatMap((p) => p.items)).toEqual([1, 2, 3]);
    expect(read.failure).toBeUndefined();
    expect(kept).toHaveLength(2);
  });

  it("a failed continuation keeps the pages already read and reports the failure", async () => {
    const seen: string[] = [];
    const read = await readPaged<number>(
      {
        start: "https://api.example.test/models",
        items: (json) => (json as { data: number[] }).data,
        next: (json, url) =>
          (json as { has_more?: boolean }).has_more === true ? `${url}?after=2` : null,
      },
      async (url) => {
        seen.push(url);
        if (seen.length === 1) {
          return fetched(Buffer.from('{"data":[1],"has_more":true}'), url);
        }
        return { ...fetched(Buffer.from("oops"), url), status: 500 };
      },
      (p) => evOf("/dev/null", p.finalUrl),
    );
    expect(read.pages.flatMap((p) => p.items)).toEqual([1]);
    expect(read.failure?.code).toBe("fetch-failed");
    expect(read.failure?.message).toContain("status 500");
    // A first-page failure still throws — there is nothing to keep.
    await expect(
      readPaged<unknown>(
        { start: "https://api.example.test/m", items: () => [], next: () => null },
        async (url) => ({ ...fetched(Buffer.from("oops"), url), status: 500 }),
        (p) => evOf("/dev/null", p.finalUrl),
      ),
    ).rejects.toThrow("status 500");
  });

  it("a pagination loop is a failed continuation, never a silent end", async () => {
    const read = await readPaged<unknown>(
      { start: "https://api.example.test/m", items: () => [], next: (_j, url) => url },
      async (url) => fetched(Buffer.from("{}"), url),
      (p) => evOf("/dev/null", p.finalUrl),
    );
    expect(read.pages).toHaveLength(1);
    expect(read.failure?.message).toContain("pagination loop");
  });
});

describe("anthropic GET /v1/models", () => {
  const p1 = join(ROOT, "readers/anthropic/fixtures/v1-models-page-1.json");
  const p2 = join(ROOT, "readers/anthropic/fixtures/v1-models-page-2.json");

  function page(path: string): ApiPage<unknown> {
    const ev = evOf(path, `${ANTHROPIC_URLS.apiModels}?limit=1000`);
    const json = JSON.parse(ev.text) as { data: unknown[] };
    return { evidence: ev, json, items: json.data };
  }

  it("reads models and per-level effort from the documented shape", () => {
    const c = ctx(scope("anthropic"));
    readAnthropicApi([page(p1), page(p2)], c);
    const models = c.readings.all
      .filter((r) => r.kind === "model")
      .map((r) => `${r.modelId}:${(r as { status?: string }).status}`);
    expect(models).toContain("claude-sonnet-5:available");
    expect(models).toContain("claude-opus-4-1:deprecated");
    const opus = c.readings.all.find(
      (r) => r.kind === "model" && r.modelId === "claude-opus-4-1",
    ) as { retiresOn?: string };
    expect(opus.retiresOn).toBe("2027-02-15");
    const efforts = c.readings.all.filter((r) => r.kind === "effort");
    const sonnet = efforts.find((r) => (r as { modelId: string }).modelId === "claude-sonnet-5");
    expect((sonnet as { levels: string[] }).levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const haiku = efforts.find((r) => (r as { modelId: string }).modelId === "claude-haiku-4-5");
    expect((haiku as { levels: string[] }).levels).toEqual(["low", "medium", "high"]);
    expect(c.readings.all.every((r) => r.outcome === "ok")).toBe(true);
  });

  it("the effort citation resolves capabilities.effort structurally, not a nested lookalike", () => {
    const c = ctx(scope("anthropic"));
    const effort = {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: null,
      max: { supported: true },
    };
    const item = {
      type: "model",
      id: "claude-fable-5-1",
      capabilities: { nested: { effort: 1 }, effort },
    };
    const ev = new Evidence({
      bytes: Buffer.from(JSON.stringify({ data: [item], has_more: false })),
      url: ANTHROPIC_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    const json = JSON.parse(ev.text) as { data: unknown[] };
    readAnthropicApi([{ evidence: ev, json, items: json.data }], c);
    const reading = c.readings.all.find(
      (r) => r.kind === "effort" && r.modelId === "claude-fable-5-1",
    );
    expect(reading).toBeDefined();
    expect((reading?.provenance?.location as { excerpt?: string } | undefined)?.excerpt).toBe(
      JSON.stringify(effort),
    );
  });

  it("a non-model item is needs-review", () => {
    const c = ctx(scope("anthropic"));
    const ev = new Evidence({
      bytes: Buffer.from('{"data":[{"type":"workspace","id":"w1"}],"has_more":false}'),
      url: ANTHROPIC_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    const json = JSON.parse(ev.text) as { data: unknown[] };
    readAnthropicApi([{ evidence: ev, json, items: json.data }], c);
    expect(c.readings.all.some((r) => r.outcome === "needs-review")).toBe(true);
  });
});

describe("google-gemini GET /v1beta/models", () => {
  it("reads models/<id> names", () => {
    const c = ctx(scope("google-gemini"));
    const ev = evOf(
      join(ROOT, "readers/gemini/fixtures/v1beta-models.json"),
      `${GEMINI_URLS.apiModels}`,
    );
    const json = JSON.parse(ev.text) as { models: unknown[] };
    readGeminiApi([{ evidence: ev, json, items: json.models }], c);
    const models = c.readings.all.filter((r) => r.kind === "model").map((r) => r.modelId);
    expect(models).toContain("gemini-3.8-flash");
    expect(models).toContain("gemini-3.8-flash-tts");
    expect(c.readings.all.every((r) => r.outcome === "ok")).toBe(true);
  });

  it("absence from the list never retires a model", () => {
    const c = ctx(scope("google-gemini"));
    const ev = new Evidence({
      bytes: Buffer.from('{"models":[]}'),
      url: GEMINI_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    readGeminiApi([{ evidence: ev, json: { models: [] }, items: [] }], c);
    expect(c.readings.all.every((r) => r.outcome === "ok" || r.outcome === "needs-review")).toBe(
      true,
    );
    expect(c.readings.all.some((r) => (r as { status?: string }).status === "retired")).toBe(false);
  });
});

describe("openai GET /v1/models", () => {
  const p = join(ROOT, "readers/openai/fixtures/v1-models.json");

  function page(path: string): ApiPage<unknown> {
    const ev = evOf(path, `${OPENAI_URLS.apiModels}`);
    const json = JSON.parse(ev.text) as { data: unknown[] };
    return { evidence: ev, json, items: json.data };
  }

  it("reads model ids from the documented shape", () => {
    const c = ctx(scope("openai"));
    readOpenaiApi([page(p)], c);
    const models = c.readings.all
      .filter((r) => r.kind === "model")
      .map((r) => `${r.modelId}:${(r as { status?: string }).status}`);
    expect(models).toContain("gpt-6.1-sol:available");
    expect(models).toContain("gpt-6-astra:available");
    expect(models).toContain("gpt-6.1-terra:available");
    expect(models).toContain("gpt-6-luna:available");
    expect(c.readings.all.every((r) => r.outcome === "ok")).toBe(true);
    // The cited span decodes to exactly the item read.
    const sol = c.readings.all.find((r) => r.modelId === "gpt-6.1-sol");
    const excerpt = (sol?.provenance?.location as { excerpt?: string } | undefined)?.excerpt;
    expect(excerpt).toContain('"id": "gpt-6.1-sol"');
  });

  it("a non-model object is needs-review, a missing id is needs-review", () => {
    const c = ctx(scope("openai"));
    const ev = new Evidence({
      bytes: Buffer.from(
        '{"object":"list","data":[{"id":"w1","object":"workspace"},{"object":"model"}],"has_more":false}',
      ),
      url: OPENAI_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    const json = JSON.parse(ev.text) as { data: unknown[] };
    readOpenaiApi([{ evidence: ev, json, items: json.data }], c);
    expect(c.readings.all.filter((r) => r.outcome === "needs-review")).toHaveLength(2);
  });

  it("absence from the list never retires a model", () => {
    const c = ctx(scope("openai"));
    const ev = new Evidence({
      bytes: Buffer.from('{"object":"list","data":[],"has_more":false}'),
      url: OPENAI_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    readOpenaiApi([{ evidence: ev, json: { object: "list", data: [] }, items: [] }], c);
    expect(c.readings.all.some((r) => (r as { status?: string }).status === "retired")).toBe(false);
  });
});

describe("elevenlabs GET /v1/models", () => {
  const p = join(ROOT, "readers/elevenlabs/fixtures/v1-models.json");

  function page(path: string): ApiPage<unknown> {
    const ev = evOf(path, `${ELEVENLABS_URLS.apiModels}`);
    const json = JSON.parse(ev.text) as unknown[];
    return { evidence: ev, json, items: json };
  }

  it("reads models and records model_rates multipliers as cross-check observations", () => {
    const c = ctx(scope("elevenlabs"));
    readElevenlabsApi([page(p)], c);
    const models = c.readings.all
      .filter((r) => r.kind === "model")
      .map((r) => `${r.modelId}:${(r as { status?: string }).status}`);
    expect(models).toContain("eleven_v4:available");
    expect(models).toContain("music_v1:available");
    // The multiplier is recorded, never read as a price.
    const mults = c.readings.all.filter(
      (r) => r.kind === "observation" && r.component === "model_rates.character_cost_multiplier",
    );
    expect(mults.length).toBeGreaterThanOrEqual(5);
    expect(mults.every((r) => r.outcome === "ok")).toBe(true);
    expect(c.readings.all.some((r) => r.kind === "rate")).toBe(false);
  });

  it("a non-1 multiplier on a tracked model is needs-review on top of the recorded value", () => {
    const c = ctx(scope("elevenlabs"));
    const ev = new Evidence({
      bytes: Buffer.from(
        '[{"model_id":"eleven_v4","model_rates":{"character_cost_multiplier":2}}]',
      ),
      url: ELEVENLABS_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    const json = JSON.parse(ev.text) as unknown[];
    readElevenlabsApi([{ evidence: ev, json, items: json }], c);
    expect(
      c.readings.all.some(
        (r) =>
          r.kind === "observation" &&
          r.outcome === "ok" &&
          r.component === "model_rates.character_cost_multiplier",
      ),
    ).toBe(true);
    expect(
      c.readings.all.some((r) => r.outcome === "needs-review" && r.modelId === "eleven_v4"),
    ).toBe(true);
  });

  it("a non-numeric multiplier or a missing model_id is needs-review", () => {
    const c = ctx(scope("elevenlabs"));
    const ev = new Evidence({
      bytes: Buffer.from('[{"model_id":"eleven_v4","model_rates":{"x":"cheap"}},{"name":"no id"}]'),
      url: ELEVENLABS_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    const json = JSON.parse(ev.text) as unknown[];
    readElevenlabsApi([{ evidence: ev, json, items: json }], c);
    expect(
      c.readings.all.filter((r) => r.outcome === "needs-review").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("absence from the list never retires a model", () => {
    const c = ctx(scope("elevenlabs"));
    const ev = new Evidence({
      bytes: Buffer.from("[]"),
      url: ELEVENLABS_URLS.apiModels,
      retrievedAt: "2026-11-04T18:00:00Z",
    });
    readElevenlabsApi([{ evidence: ev, json: [], items: [] }], c);
    expect(c.readings.all.some((r) => (r as { status?: string }).status === "retired")).toBe(false);
  });
});

describe("openai/elevenlabs list specs", () => {
  it("openai: has_more without a usable last_id cursor is Unreadable", async () => {
    const { openaiListSpec } = await import("./api-read.ts");
    const o = openaiListSpec("https://x/v1/models?limit=1");
    expect(o.next({ data: [] }, "u")).toBeNull();
    expect(o.next({ data: [], has_more: false }, "u")).toBeNull();
    expect(() => o.next({ data: [], has_more: true }, "u")).toThrow(Unreadable);
    expect(() => o.next({ data: [], has_more: true, last_id: "" }, "u")).toThrow(Unreadable);
    expect(o.next({ data: [], has_more: true, last_id: "m-1" }, "u")).toBe(
      "https://x/v1/models?limit=1&after=m-1",
    );
    // cursors are URL-encoded
    expect(o.next({ data: [], has_more: true, last_id: "a+b?" }, "u")).toBe(
      "https://x/v1/models?limit=1&after=a%2Bb%3F",
    );
    // a start URL with no query gets `?after=`, never `&after=`
    const bare = openaiListSpec("https://x/v1/models");
    expect(bare.next({ data: [], has_more: true, last_id: "m-1" }, "u")).toBe(
      "https://x/v1/models?after=m-1",
    );
  });

  it("openai: a malformed list body is not silently an empty list", async () => {
    const { openaiListSpec } = await import("./api-read.ts");
    expect(() => openaiListSpec("u").items({ data: "nope" })).toThrow();
    expect(() => openaiListSpec("u").items([1, 2])).toThrow();
  });

  it("elevenlabs: the bare array spec takes no second page", async () => {
    const { elevenlabsListSpec } = await import("./api-read.ts");
    const e = elevenlabsListSpec("https://x/v1/models");
    expect(e.items([{ model_id: "x" }])).toEqual([{ model_id: "x" }]);
    expect(e.next([{ model_id: "x" }], "u")).toBeNull();
    expect(() => e.items({ models: [] })).toThrow();
  });
});

describe("--live plumbing", () => {
  it("the live read fetches a page for every tracked model", () => {
    const sc = scope("anthropic");
    const urls = anthropicModelPageUrls(sc);
    expect(urls).toHaveLength(sc.models.size);
    expect(urls.find((u) => u.id === "claude-sonnet-5")?.url).toBe(
      "https://platform.claude.com/docs/en/models/sonnet-5/overview.md",
    );
  });

  it("a failed per-model page fetch is an unreadable observation, and the run continues", async () => {
    const { fetchModelPages } = await import("./api-read.ts");
    const report: ReadReport = { provider: "anthropic", mode: "live", sources: [], readings: [] };
    const urls = [
      { id: "claude-a", url: "https://x/a.md" },
      { id: "claude-b", url: "https://x/b.md" },
      { id: "claude-c", url: "https://x/c.md" },
    ];
    const pages = await fetchModelPages(
      report,
      "anthropic-model-page",
      urls,
      async (url) => {
        if (url.endsWith("b.md"))
          return {
            status: 404,
            requestedUrl: url,
            finalUrl: url,
            bytes: Buffer.from(""),
            retrievedAt: "2026-11-04T00:00:00Z",
            hops: [],
          };
        if (url.endsWith("c.md")) throw new Error("connect timeout");
        return {
          status: 200,
          requestedUrl: url,
          finalUrl: url,
          bytes: Buffer.from("ok"),
          retrievedAt: "2026-11-04T00:00:00Z",
          hops: [],
        };
      },
      (p) => new Evidence({ bytes: p.bytes, url: p.finalUrl, retrievedAt: "2026-11-04T00:00:00Z" }),
    );
    expect([...pages.keys()]).toEqual(["claude-a"]);
    const unreadable = report.readings.filter((r) => r.outcome === "unreadable");
    expect(unreadable).toHaveLength(2);
    const flagged = new Set(unreadable.map((r) => (r as { modelId?: string }).modelId));
    expect(flagged).toEqual(new Set(["claude-b", "claude-c"]));
  });

  it("has_more without a usable cursor is an unreadable API observation, never a silent end", async () => {
    const { anthropicListSpec, apiRead } = await import("./api-read.ts");
    const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
    const report: ReadReport = { provider: "anthropic", mode: "live", sources: [], readings: [] };
    const pages = await apiRead(
      report,
      true,
      "anthropic-models-api",
      "ANTHROPIC_API_KEY",
      async () =>
        readPaged(
          anthropicListSpec("https://api.anthropic.com/v1/models?limit=1000"),
          async (url) => ({
            status: 200,
            requestedUrl: url,
            finalUrl: url,
            bytes: Buffer.from('{"data":[],"has_more":true}'),
            retrievedAt: "2026-11-04T00:00:00Z",
            hops: [],
          }),
          (p) =>
            new Evidence({ bytes: p.bytes, url: p.finalUrl, retrievedAt: "2026-11-04T00:00:00Z" }),
        ),
      { ANTHROPIC_API_KEY: "test-key" },
    );
    // The page that read cleanly is kept; the unusable cursor is unreadable.
    expect(pages).toHaveLength(1);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0]?.outcome).toBe("unreadable");
    expect(report.readings[0]?.reasons[0]?.message).toContain("last_id");
  });

  it("a failed continuation keeps the pages already read, and the report flags it", async () => {
    const { openaiListSpec, apiRead } = await import("./api-read.ts");
    const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
    const report: ReadReport = { provider: "openai", mode: "live", sources: [], readings: [] };
    const requested: string[] = [];
    const pages = await apiRead(
      report,
      true,
      "openai-models-api",
      "OPENAI_API_KEY",
      async () =>
        readPaged(
          // The OpenAI start URL has no query — the cursor must build `?after=`.
          openaiListSpec("https://api.openai.test/v1/models"),
          async (url) => {
            requested.push(url);
            if (requested.length === 1) {
              return {
                status: 200,
                requestedUrl: url,
                finalUrl: url,
                bytes: Buffer.from(
                  '{"object":"list","data":[{"id":"m-1","object":"model"}],"has_more":true,"last_id":"m-1"}',
                ),
                retrievedAt: "2026-11-04T00:00:00Z",
                hops: [],
              };
            }
            return {
              status: 500,
              requestedUrl: url,
              finalUrl: url,
              bytes: Buffer.from(""),
              retrievedAt: "2026-11-04T00:00:00Z",
              hops: [],
            };
          },
          (p) =>
            new Evidence({ bytes: p.bytes, url: p.finalUrl, retrievedAt: "2026-11-04T00:00:00Z" }),
        ),
      { OPENAI_API_KEY: "test-key" },
    );
    expect(requested).toEqual([
      "https://api.openai.test/v1/models",
      "https://api.openai.test/v1/models?after=m-1",
    ]);
    expect(pages).toHaveLength(1);
    const unreadable = report.readings.filter((r) => r.outcome === "unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.reasons[0]?.message).toContain("status 500");
  });

  it("a nextPageToken that is not a usable cursor throws", async () => {
    const { geminiListSpec, anthropicListSpec } = await import("./api-read.ts");
    const g = geminiListSpec("https://x/models?pageSize=1");
    expect(g.next({ models: [] }, "u")).toBeNull();
    expect(() => g.next({ models: [], nextPageToken: "" }, "u")).toThrow(Unreadable);
    expect(() => g.next({ models: [], nextPageToken: 42 }, "u")).toThrow(Unreadable);
    expect(g.next({ models: [], nextPageToken: "tok" }, "u")).toBe(
      "https://x/models?pageSize=1&pageToken=tok",
    );
    // a start URL with no query gets `?pageToken=`, never `&pageToken=`
    const gBare = geminiListSpec("https://x/models");
    expect(gBare.next({ models: [], nextPageToken: "tok" }, "u")).toBe(
      "https://x/models?pageToken=tok",
    );
    const a = anthropicListSpec("https://x/v1/models?limit=1");
    expect(a.next({ data: [], has_more: false }, "u")).toBeNull();
    expect(() => a.next({ data: [], has_more: "yes" }, "u")).toThrow(Unreadable);
    expect(() => a.next({ data: [], has_more: true }, "u")).toThrow(Unreadable);
    expect(a.next({ data: [], has_more: true, last_id: "id-9" }, "u")).toBe(
      "https://x/v1/models?limit=1&after_id=id-9",
    );
    // a start URL with no query gets `?after_id=`, never `&after_id=`
    const aBare = anthropicListSpec("https://x/v1/models");
    expect(aBare.next({ data: [], has_more: true, last_id: "id-9" }, "u")).toBe(
      "https://x/v1/models?after_id=id-9",
    );
  });

  it("continuation cursors are URL-encoded", async () => {
    const { geminiListSpec, anthropicListSpec } = await import("./api-read.ts");
    const g = geminiListSpec("https://x/models?pageSize=1");
    expect(g.next({ models: [], nextPageToken: "a+b/c=" }, "u")).toBe(
      "https://x/models?pageSize=1&pageToken=a%2Bb%2Fc%3D",
    );
    const a = anthropicListSpec("https://x/v1/models?limit=1");
    expect(a.next({ data: [], has_more: true, last_id: "id/+?" }, "u")).toBe(
      "https://x/v1/models?limit=1&after_id=id%2F%2B%3F",
    );
  });

  it("a malformed list body is not silently an empty list", async () => {
    const { anthropicListSpec, geminiListSpec } = await import("./api-read.ts");
    expect(() => anthropicListSpec("u").items({ data: "nope" })).toThrow();
    expect(() => anthropicListSpec("u").items([1, 2])).toThrow();
    expect(() => geminiListSpec("u").items({ models: 42 })).toThrow();
  });

  it("an API fetch failure becomes an unreadable observation, never an abort", async () => {
    const { apiRead } = await import("./api-read.ts");
    const report: ReadReport = { provider: "anthropic", mode: "live", sources: [], readings: [] };
    const pages = await apiRead(
      report,
      true,
      "anthropic-models-api",
      "ANTHROPIC_API_KEY",
      async () => {
        throw new Unreadable("fetch-failed", "status 401");
      },
      { ANTHROPIC_API_KEY: "test-key" },
    );
    expect(pages).toEqual([]);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0]?.outcome).toBe("unreadable");
    expect(report.accountScope).toEqual({ keyEnv: "ANTHROPIC_API_KEY" });
  });

  it("no API read without --live; without the key the source is unreadable, 'no key'", async () => {
    const { apiRead } = await import("./api-read.ts");
    const report: ReadReport = {
      provider: "google-gemini",
      mode: "evidence",
      sources: [],
      readings: [],
    };
    expect(
      await apiRead(report, false, "gemini-models", "GEMINI_API_KEY", async () => {
        throw new Error("must not run");
      }),
    ).toEqual([]);
    expect(
      await apiRead(
        report,
        true,
        "gemini-models",
        "GEMINI_API_KEY",
        async () => {
          throw new Error("must not run");
        },
        {},
      ),
    ).toEqual([]);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0]).toMatchObject({
      kind: "observation",
      outcome: "unreadable",
      source: "gemini-models",
      reasons: [{ code: "no-key", message: "no key: GEMINI_API_KEY is not set" }],
    });
    expect(report.accountScope).toBeUndefined();
  });
});
