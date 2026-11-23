// The Claude and GPT API pages of 2026-11-23 (OLP-528): the stored bodies, pinned by sha256,
// read to the rates the catalog carries; and each new accepted form, changed by one thing,
// fails closed. The frozen seed predates these pages, so nothing here moves with data/catalog.json.

import {
  ANTHROPIC_URLS,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import {
  OPENAI_URLS,
  modelPageUrl as openaiModelPageUrl,
  readOpenai,
} from "@openadviser/ai-catalog-reader-openai";
import { eqDecimal, type RateReading, type Reading } from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import { body, mutated, PRICING_2026_11_23 as P, scopeWithPricedModels } from "./testing.ts";

const ANTHROPIC_IDS = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
] as const;
const OPENAI_IDS = Object.keys(P.openaiModelPages) as (keyof typeof P.openaiModelPages)[];
const NO_EFFORT = ["gpt-6.2-astra", "gpt-6.2-sol"];

function anthropic(
  mutate?: (t: string) => string,
  which: "pricing" | "models" | "effort" = "pricing",
) {
  const pick = (name: "pricing" | "models" | "effort", sha: string) => {
    const ev = body(sha);
    return mutate !== undefined && which === name ? mutated(ev, mutate) : ev;
  };
  return readAnthropic(
    {
      pricing: pick("pricing", P.anthropicPricing),
      models: pick("models", P.anthropicModels),
      effort: pick("effort", P.anthropicEffort),
      modelPage: () => undefined,
    },
    scopeWithPricedModels("anthropic", ANTHROPIC_IDS),
  );
}

function openai(
  mutate?: (t: string) => string,
  which: "pricing" | { page: keyof typeof P.openaiModelPages } = "pricing",
) {
  return readOpenai(
    {
      pricing:
        mutate !== undefined && which === "pricing"
          ? mutated(body(P.openaiPricing), mutate)
          : body(P.openaiPricing),
      modelPage: (id: string) => {
        const sha = P.openaiModelPages[id as keyof typeof P.openaiModelPages];
        if (sha === undefined) return undefined;
        const ev = body(sha);
        return mutate !== undefined && typeof which === "object" && which.page === id
          ? mutated(ev, mutate)
          : ev;
      },
    },
    scopeWithPricedModels("openai", OPENAI_IDS, NO_EFFORT),
  );
}

type Rate = RateReading;
const rates = (rs: Reading[], id: string): Rate[] =>
  rs.filter((r): r is Rate => r.kind === "rate" && r.modelId === id);

/** The fact of one rate: `amount` when priced, else the disposition. */
function fact(rs: Reading[], id: string, component: string, cond?: unknown): string {
  const hits = rates(rs, id).filter(
    (r) =>
      r.tier.endsWith(":standard") &&
      r.component === component &&
      r.outcome === "ok" &&
      JSON.stringify(r.condition ?? null) === JSON.stringify(cond ?? null),
  );
  if (hits.length !== 1) return `${hits.length} readings`;
  const f = (hits[0] as Rate).fact;
  return f.disposition === "priced" ? f.amount : f.disposition;
}

function same(actual: string, expected: string): boolean {
  return actual === expected || (/^[0-9.]+$/.test(actual) && eqDecimal(actual, expected));
}

const notOk = (rs: Reading[], id?: string) =>
  rs.filter(
    (r) => r.outcome !== "ok" && (id === undefined || (r as { modelId?: string }).modelId === id),
  );

const codes = (rs: Reading[]) => rs.flatMap((r) => (r.reasons ?? []).map((q) => q.code));

describe("anthropic, the pricing page of 2026-11-23", () => {
  const r = anthropic();
  const table: [string, string, string, string, string, string][] = [
    // id, input, 5m write, 1h write, cached, output
    ["claude-fable-5-2", "8", "10", "16", "0.20", "40"],
    ["claude-opus-5-5", "4", "5", "8", "0.20", "20"],
    ["claude-sonnet-5-5", "2", "2.50", "4", "0.10", "10"],
  ];
  for (const [id, input, w5, w1, cached, output] of table) {
    it(`prices ${id}`, () => {
      expect(same(fact(r.readings, id, "input"), input)).toBe(true);
      expect(same(fact(r.readings, id, "cache_write_5m"), w5)).toBe(true);
      expect(same(fact(r.readings, id, "cache_write_1h"), w1)).toBe(true);
      expect(same(fact(r.readings, id, "input_cached"), cached)).toBe(true);
      expect(same(fact(r.readings, id, "output"), output)).toBe(true);
      expect(fact(r.readings, id, "web_search")).toBe("10");
      expect(fact(r.readings, id, "code_execution")).toBe("unsupported");
    });
  }

  it("prices Haiku 5.5 under both whole-request schedules", () => {
    const lte = { inputTokens: { lte: 100000 } };
    const gt = { inputTokens: { gt: 100000 } };
    const want: [string, string, string][] = [
      ["input", "0.10", "0.50"],
      ["cache_write_5m", "0.125", "0.625"],
      ["cache_write_1h", "0.20", "1"],
      ["input_cached", "0.01", "0.05"],
      ["output", "0.50", "2.50"],
    ];
    for (const [component, a, b] of want) {
      expect(same(fact(r.readings, "claude-haiku-5-5", component, lte), a)).toBe(true);
      expect(same(fact(r.readings, "claude-haiku-5-5", component, gt), b)).toBe(true);
    }
    expect(fact(r.readings, "claude-haiku-5-5", "web_search", lte)).toBe("10");
    expect(fact(r.readings, "claude-haiku-5-5", "web_search", gt)).toBe("10");
  });

  it("reads Fable 5.2's effort and nothing else is left unread", () => {
    const e = r.readings.find((x) => x.kind === "effort" && x.modelId === "claude-fable-5-2");
    expect(e).toMatchObject({
      outcome: "ok",
      levels: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    });
    // The only findings are the fast tier, which the schema does not have, and the model pages
    // of two models this test does not store.
    expect(new Set(codes(notOk(r.readings)))).toEqual(
      new Set(["tier-not-in-schema", "no-evidence"]),
    );
  });
});

describe("anthropic, the new page forms fail closed", () => {
  const rejected = (rs: Reading[], id: string, component: string) =>
    rates(rs, id).filter((x) => x.component === component && x.outcome === "ok");

  it("a changed cache-hit multiplier in the per-model table is needs-review", () => {
    const rs = anthropic((t) => {
      const out = t.replace(/(\| Claude Opus 5\.5[^|\n]*\|\s*)0\.05x/, "$10.1x");
      return out;
    }).readings;
    expect(codes(rs)).toContain("structure");
    expect(rejected(rs, "claude-opus-5-5", "input_cached")).toHaveLength(0);
  });

  it("a changed 'All other models' multiplier is needs-review", () => {
    const rs = anthropic((t) =>
      t.replace(/(All other models[^|\n]*\|\s*)0\.1x/, "$10.2x"),
    ).readings;
    expect(codes(rs)).toContain("structure");
    expect(rejected(rs, "claude-sonnet-5-5", "input_cached")).toHaveLength(0);
  });

  it("a footnote 1 that names another model is needs-review", () => {
    const rs = anthropic((t) =>
      t.replace(/on Claude Fable 5\.2, Claude Mythos 5\.2,/, "on Claude Fable 5.2,"),
    ).readings;
    expect(codes(rs)).toContain("unknown-footnote");
    expect(rejected(rs, "claude-fable-5-2", "input_cached")).toHaveLength(0);
  });

  it("a footnote 1 with another multiplier is needs-review", () => {
    const rs = anthropic((t) =>
      t.replace(
        /are priced at 0\.025x the base input price/,
        "are priced at 0.03x the base input price",
      ),
    ).readings;
    expect(codes(rs)).toContain("unknown-footnote");
    expect(rejected(rs, "claude-fable-5-2", "input_cached")).toHaveLength(0);
  });

  it("a changed web search sentence is needs-review", () => {
    const rs = anthropic((t) =>
      t.replace("**$10 USD per 1,000 searches**", "**$12 USD per 1,000 searches**"),
    ).readings;
    expect(codes(rs)).toContain("structure");
    expect(rejected(rs, "claude-fable-5-2", "web_search")).toHaveLength(0);
  });

  it("a missing effort default sentence is needs-review", () => {
    const rs = anthropic((t) => t.replace(/The API default is `[a-z]+`\./g, ""), "effort").readings;
    expect(
      rs.filter(
        (x) => x.kind === "effort" && x.modelId === "claude-fable-5-2" && x.outcome === "ok",
      ),
    ).toHaveLength(0);
  });

  it("a model page url is still the documented one", () => {
    expect(modelPageUrl("fable-5-2")).toContain("fable-5-2");
    expect(ANTHROPIC_URLS.pricing).toContain("pricing");
  });
});

describe("openai, the pages of 2026-11-23", () => {
  const r = openai();
  const table: [string, string, string, string, string, string][] = [
    // id, input, cached, 30m write, 12h write, output. The page renders its first four rows into
    // its table, with a 12h write column; a later row has no 12h price in the HTML.
    ["gpt-6.2-astra", "8", "0.4", "10", "20", "40"],
    ["gpt-6.2-sol", "2", "0.1", "2.5", "5", "10"],
    ["gpt-6-astra", "10", "1", "12.5", "25", "50"],
    ["gpt-6.1-terra", "1", "0.05", "1.25", "unsupported", "5"],
    ["gpt-6-luna", "0.1", "0.01", "0.125", "unsupported", "0.5"],
    ["gpt-6-sol", "2", "0.2", "2.5", "unsupported", "10"],
  ];
  const lte = { inputTokens: { lte: 272000 } };
  const gt = { inputTokens: { gt: 272000 } };
  for (const [id, input, cached, w30, w12, output] of table) {
    it(`prices ${id}, short and long context`, () => {
      expect(same(fact(r.readings, id, "input", lte), input)).toBe(true);
      expect(same(fact(r.readings, id, "input_cached", lte), cached)).toBe(true);
      expect(same(fact(r.readings, id, "cache_write_30m", lte), w30)).toBe(true);
      expect(same(fact(r.readings, id, "cache_write_12h", lte), w12)).toBe(true);
      expect(same(fact(r.readings, id, "output", lte), output)).toBe(true);
      // Above 272,000 input tokens: 2x input and cached input, 1.5x output, cache writes unsupported.
      expect(same(fact(r.readings, id, "input", gt), String(Number(input) * 2))).toBe(true);
      expect(same(fact(r.readings, id, "input_cached", gt), String(Number(cached) * 2))).toBe(true);
      expect(same(fact(r.readings, id, "output", gt), String(Number(output) * 1.5))).toBe(true);
      expect(fact(r.readings, id, "cache_write_30m", gt)).toBe("unsupported");
      expect(fact(r.readings, id, "cache_write_12h", gt)).toBe("unsupported");
      expect(fact(r.readings, id, "web_search", lte)).toBe("10.00");
      expect(fact(r.readings, id, "file_search", lte)).toBe("2.50");
      expect(fact(r.readings, id, "containers", lte)).toBe("unsupported");
      expect(fact(r.readings, id, "file_search_storage", gt)).toBe("unsupported");
    });
  }

  it("leaves nothing unread for the models but the tiers the schema lacks", () => {
    for (const id of OPENAI_IDS) {
      const other = notOk(r.readings, id).filter(
        (x) =>
          !(x.reasons ?? []).every((q) => /^the [A-Za-z]+ tier is not in schema/.test(q.message)),
      );
      expect(other).toEqual([]);
    }
  });

  it("states no effort for the gpt-6.2 pages, so a model with none needs none", () => {
    for (const id of NO_EFFORT) {
      expect(r.readings.filter((x) => x.kind === "effort" && x.modelId === id)).toHaveLength(0);
    }
    const sol = r.readings.find((x) => x.kind === "effort" && x.modelId === "gpt-6-sol");
    expect(sol).toMatchObject({ outcome: "ok", default: "medium" });
  });

  it("a model that has catalog effort still needs its page to state it", () => {
    const rs = readOpenai(
      {
        pricing: body(P.openaiPricing),
        modelPage: (id: string) => {
          const sha = P.openaiModelPages[id as keyof typeof P.openaiModelPages];
          return sha === undefined ? undefined : body(sha);
        },
      },
      scopeWithPricedModels("openai", OPENAI_IDS),
    ).readings;
    expect(
      rs.filter((x) => x.modelId === "gpt-6.2-sol" && x.outcome !== "ok" && x.kind === "effort")
        .length + notOk(rs, "gpt-6.2-sol").filter((x) => codes([x]).includes("structure")).length,
    ).toBeGreaterThan(0);
  });

  it("uses the model id, not the Codex list, as the API model", () => {
    expect(openaiModelPageUrl("gpt-6.2-sol")).toContain("gpt-6.2-sol");
    expect(OPENAI_URLS.pricing).toContain("pricing");
  });
});

describe("openai, the new page forms fail closed", () => {
  const derived = (rs: Reading[], id: string, component: string) =>
    rates(rs, id).filter(
      (x) =>
        x.component === component &&
        x.outcome === "ok" &&
        JSON.stringify(x.condition) === JSON.stringify({ inputTokens: { gt: 272000 } }) &&
        x.fact.disposition === "priced",
    );

  it("a long-context note worded another way is needs-review", () => {
    const rs = openai(
      (t) =>
        t.replace(
          /output costs 1\.5 times the short-context rate/,
          "output costs about 1.5 times the short-context rate",
        ),
      { page: "gpt-6.2-astra" },
    ).readings;
    expect(
      notOk(rs, "gpt-6.2-astra").some(
        (x) =>
          x.outcome === "needs-review" &&
          !/tier is not in schema/.test((x.reasons ?? []).map((q) => q.message).join()),
      ),
    ).toBe(true);
    expect(derived(rs, "gpt-6.2-astra", "output")).toHaveLength(0);
  });

  it("a changed 12-hour cache write is needs-review", () => {
    const rs = openai((t) => t.replace(/\$20(\.00)?\b(?=[^$]*12)/, "$25$1"), {
      page: "gpt-6.2-astra",
    }).readings;
    expect(
      notOk(rs, "gpt-6.2-astra").some(
        (x) => x.outcome === "needs-review" && !codes([x]).includes("tier-not-in-schema"),
      ),
    ).toBe(true);
  });

  it("a Flex footnote that says something else is needs-review", () => {
    const rs = openai((t) =>
      t.replace("We won’t be adding Flex to new models.", "We are adding Flex to new models."),
    ).readings;
    expect(codes(rs)).toContain("unknown-footnote");
  });

  it("a Tools row priced another way is needs-review", () => {
    const rs = openai((t) => t.replace(/\$10\.00 \/ 1k calls/g, "$10.00 / call")).readings;
    expect(
      rates(rs, "gpt-6-luna").filter((x) => x.component === "web_search" && x.outcome === "ok"),
    ).toHaveLength(0);
    expect(codes(rs)).toContain("structure");
  });

  it("a Tools storage cell that changed is needs-review", () => {
    const rs = openai((t) => t.replace(/\$0\.10 \/ GB per day/, "$0.20 / GB per day")).readings;
    expect(codes(rs)).toContain("structure");
  });

  it("a tracked model whose pricing row is marked deprecated is needs-review", () => {
    const rs = openai((t) =>
      t.replace(
        "[0,&quot;gpt-6-luna&quot;]",
        "[0,{&quot;label&quot;:[0,&quot;gpt-6-luna&quot;],&quot;deprecated&quot;:[0,true]}]",
      ),
    ).readings;
    expect(
      notOk(rs, "gpt-6-luna").some((x) =>
        (x.reasons ?? []).some((q) => /deprecated/.test(q.message)),
      ),
    ).toBe(true);
    expect(
      rates(rs, "gpt-6-luna").filter(
        (x) =>
          x.tier === "openai:standard" &&
          x.outcome === "ok" &&
          ["input", "output", "input_cached", "cache_write_30m", "cache_write_12h"].includes(
            x.component,
          ),
      ),
    ).toHaveLength(0);
  });

  it("a model page whose Model IDs section lost the id is needs-review", () => {
    const rs = openai((t) => t.replace(/>Model IDs</, ">Model names<"), {
      page: "gpt-6.2-sol",
    }).readings;
    expect(notOk(rs, "gpt-6.2-sol").length).toBeGreaterThan(0);
  });
});
