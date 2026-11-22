// Mutation fixtures: the same saved pages with one thing changed. Every mutation in
// tracked scope must produce `needs-review` — never a wrong or partial price, never
// silence.

import {
  ANTHROPIC_URLS,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import { ELEVENLABS_URLS, readElevenlabs } from "@openadviser/ai-catalog-reader-elevenlabs";
import { GEMINI_URLS, readGemini } from "@openadviser/ai-catalog-reader-gemini";
import {
  OPENAI_URLS,
  modelPageUrl as openaiModelPageUrl,
  readOpenai,
} from "@openadviser/ai-catalog-reader-openai";
import type { Reading } from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import {
  body,
  GEMINI4_IDS,
  GEMINI4_PRICING,
  GEMINI4_THINKING,
  mutated,
  page,
  scope,
  scopeWithElevenlabsSuccessors,
  scopeWithGemini4,
  scopeWithLyria,
  store,
} from "./testing.ts";

function anthropicSources(
  mutate: (text: string) => string,
  which: "pricing" | "models" | "effort" = "pricing",
) {
  return {
    pricing:
      which === "pricing"
        ? mutated(page(ANTHROPIC_URLS.pricing), mutate)
        : page(ANTHROPIC_URLS.pricing),
    models:
      which === "models"
        ? mutated(page(ANTHROPIC_URLS.models), mutate)
        : page(ANTHROPIC_URLS.models),
    effort:
      which === "effort"
        ? mutated(page(ANTHROPIC_URLS.effort), mutate)
        : page(ANTHROPIC_URLS.effort),
    modelPage: (id: string) => store().latest(modelPageUrl(id.replace(/^claude-/, ""))),
  };
}

function geminiSources(mutate: (text: string) => string) {
  return {
    pricing: mutated(page(GEMINI_URLS.pricing), mutate),
    thinking: page(GEMINI_URLS.thinking),
  };
}

function openaiSources(
  mutate: (text: string) => string,
  which: "pricing" | "modelPage" = "pricing",
) {
  return {
    pricing:
      which === "pricing" ? mutated(page(OPENAI_URLS.pricing), mutate) : page(OPENAI_URLS.pricing),
    modelPage: (id: string) => {
      const ev = store().latest(openaiModelPageUrl(id));
      if (ev === undefined) return undefined;
      return which === "modelPage" && id === "gpt-6.1-sol" ? mutated(ev, mutate) : ev;
    },
  };
}

function elevenlabsSources(mutate: (text: string) => string, which: "pricing" | "models") {
  return {
    pricing:
      which === "pricing"
        ? mutated(page(ELEVENLABS_URLS.pricing), mutate)
        : page(ELEVENLABS_URLS.pricing),
    models:
      which === "models"
        ? mutated(page(ELEVENLABS_URLS.models), mutate)
        : page(ELEVENLABS_URLS.models),
  };
}

function reviews(readings: Reading[]): string[] {
  return readings
    .filter((r) => r.outcome !== "ok")
    .map((r) => {
      const s = r as { modelId?: string; tier?: string; component?: string };
      return `${r.outcome}:${(r.reasons ?? []).map((x) => x.code).join("+")} ${s.modelId ?? ""} ${s.tier ?? ""} ${s.component ?? ""}`.trim();
    });
}

describe("anthropic mutations", () => {
  it("an inserted column in the model-pricing table is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace("| Base input tokens", "| Priority input tokens | Base input tokens"),
      ),
      scope("anthropic"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
    expect(
      r.readings.filter(
        (x) =>
          x.kind === "rate" && x.modelId === "claude-sonnet-5" && x.tier === "anthropic:standard",
      ),
    ).toHaveLength(0);
  });

  it("a moved heading is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace("## Model pricing", "## Pricing models")),
      scope("anthropic"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a new footnote touching a tracked model is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace("| $10 / MTok<sup>3</sup> |", "| $10 / MTok<sup>3</sup><sup>9</sup> |"),
      ),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
  });

  it("a changed footnote scope is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          "on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x",
          "on Claude Sonnet 5 are priced at 0.025x",
        ),
      ),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
  });

  it("a missing tracked model is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace(/\| Claude Sonnet 5\s+\|[^\n]*\n/, "")),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(codes.some((c) => c.includes("claude-sonnet-5") && c.includes("missing-model"))).toBe(
      true,
    );
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" && x.modelId === "claude-sonnet-5" && x.tier === "anthropic:standard",
      ),
    ).toBe(false);
  });

  it("an unparseable amount on a tracked model is needs-review, never a guess", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace("| $2 / MTok<sup>3</sup>", "| ask us / MTok<sup>3</sup>")),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("bad-amount");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "claude-sonnet-5" &&
          x.component === "input" &&
          x.tier === "anthropic:standard",
      ),
    ).toBe(false);
  });

  it("an unresolved footnote on a base input taints its Batch derivations", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace("$2 / MTok<sup>3</sup>", "$2 / MTok<sup>3</sup><sup>9</sup>"),
      ),
      scope("anthropic"),
    );
    const derived = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:batch" &&
        (x.component === "cache_write_5m" ||
          x.component === "cache_write_1h" ||
          x.component === "input_cached"),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a tracked model missing from the Batch table is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace(/\| Claude Sonnet 5\s+\| \$1 \/ MTok[^\n]*\n/, "")),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => {
      const s = x as { modelId?: string; tier?: string };
      return [
        `${s.modelId ?? ""}:${s.tier ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
      ];
    });
    expect(codes.some((c) => c.includes("claude-sonnet-5") && c.includes("missing-model"))).toBe(
      true,
    );
    expect(
      r.readings.some(
        (x) => x.kind === "rate" && x.modelId === "claude-sonnet-5" && x.tier === "anthropic:batch",
      ),
    ).toBe(false);
  });

  it("a default effort outside the vocabulary is needs-review — even for a model outside the comparison table", () => {
    const r = readAnthropic(
      anthropicSources(
        (t) =>
          t.replace(
            "Claude Sonnet 5 defaults to `high` effort",
            "Claude Sonnet 5 defaults to `turbo` effort",
          ),
        "effort",
      ),
      scope("anthropic"),
    );
    const efforts = r.readings.filter(
      (x) => x.kind === "effort" && x.modelId === "claude-sonnet-5",
    );
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts.every((x) => x.outcome === "needs-review")).toBe(true);
    expect(
      efforts
        .flatMap((x) => (x.reasons ?? []).map((q) => q.message))
        .some((m) => m.includes("not in the vocabulary")),
    ).toBe(true);
  });

  it("a default effort outside the model's supported levels is needs-review", () => {
    const r = readAnthropic(
      anthropicSources(
        (t) =>
          t.replace(
            "Claude Sonnet 5 defaults to `high` effort",
            "Claude Sonnet 5 defaults to `minimal` effort",
          ),
        "effort",
      ),
      scope("anthropic"),
    );
    const efforts = r.readings.filter(
      (x) => x.kind === "effort" && x.modelId === "claude-sonnet-5",
    );
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts.every((x) => x.outcome === "needs-review")).toBe(true);
    expect(
      efforts
        .flatMap((x) => (x.reasons ?? []).map((q) => q.message))
        .some((m) => m.includes("supported levels")),
    ).toBe(true);
  });

  it("an effort block that names a default the reader cannot parse is needs-review", () => {
    const r = readAnthropic(
      anthropicSources(
        (t) =>
          t.replace(
            "and `high` is the default on the Claude API",
            "and **high** is the default on the Claude API",
          ),
        "effort",
      ),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.message));
    expect(codes.some((m) => m.includes("could not parse"))).toBe(true);
  });

  it("one model's unparsable effort block never loses the others' effort readings", () => {
    const r = readAnthropic(
      anthropicSources(
        (t) =>
          t.replace(
            "Claude Fable 5.1 supports all five effort levels.",
            "Claude Fable 5.1 is Anthropic's smartest model.",
          ),
        "effort",
      ),
      scope("anthropic"),
    );
    const efforts = r.readings.filter((x) => x.kind === "effort");
    const models = new Set(efforts.map((x) => x.modelId));
    // Fable's block is flagged; the other tracked models still emit efforts.
    expect(
      r.readings.some((x) => x.outcome === "needs-review" && x.modelId === "claude-fable-5-1"),
    ).toBe(true);
    expect(models.has("claude-sonnet-5-5")).toBe(true);
    expect(models.has("claude-haiku-5-5")).toBe(true);
  });

  it("a multi-reference footnote marker with an unknown ref is needs-review", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace("$2 / MTok<sup>3</sup>", "$2 / MTok<sup>3,9</sup>")),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
    const derived = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:batch" &&
        (x.component === "input_cached" || x.component.startsWith("cache_write")),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a footnote marker that is not a reference is needs-review and taints derivations", () => {
    const r = readAnthropic(
      anthropicSources((t) => t.replace("$2 / MTok<sup>3</sup>", "$2 / MTok<sup>beta</sup>")),
      scope("anthropic"),
    );
    const input = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:standard" &&
        x.component === "input",
    );
    expect(input.every((x) => x.outcome === "needs-review")).toBe(true);
    const derived = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:batch" &&
        (x.component === "input_cached" || x.component.startsWith("cache_write")),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a malformed retirement cell is needs-review", () => {
    const r = readAnthropic(
      anthropicSources(
        (t) => t.replace("Not sooner than September 1, 2027", "eventually"),
        "models",
      ),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
  });

  it("a changed tool-pricing sentence is needs-review, never an aborted read", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          "* Each organization receives **1,550 free hours** of usage per month.",
          "* Each organization receives a generous allowance of free usage per month.",
        ),
      ),
      scope("anthropic"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
    // The rest of the report survives: priced rates are still emitted.
    expect(r.readings.some((x) => x.kind === "rate" && x.fact.disposition === "priced")).toBe(true);
  });

  it("a footnote marker on a Batch price is needs-review, never ignored", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          /(\| Claude Sonnet 5\s+\| )\$1 \/ MTok/,
          (_m, g: string) => `${g}$1 / MTok<sup>9</sup>`,
        ),
      ),
      scope("anthropic"),
    );
    const marked = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:batch" &&
        x.component === "input",
    );
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((x) => x.outcome === "needs-review")).toBe(true);
    expect(marked.flatMap((x) => (x.reasons ?? []).map((q) => q.code))).toContain(
      "unknown-footnote",
    );
  });

  it("a per-model cache-write multiplier override reaches the derived Batch price", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          "| 5-minute cache write | 1.25x base input price",
          "| 5-minute cache write | 1.25x base input price (1x on Claude Sonnet 5)",
        ),
      ),
      scope("anthropic"),
    );
    const derived = r.readings.find(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "claude-sonnet-5" &&
        x.tier === "anthropic:batch" &&
        x.component === "cache_write_5m",
    );
    // 1x override × $2 base × 0.5 Batch discount = $1, never the base 1.25x's $1.25.
    const fact = (derived as { fact?: { disposition?: string; amount?: string } } | undefined)
      ?.fact;
    expect(fact?.disposition).toBe("priced");
    expect(fact?.amount).toBe("1");
    // The override also governs the stated-cell check: $2.50 stated ≠ 1x × $2 is
    // the page contradicting itself — needs-review, never a silent base-mult check.
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" &&
          x.modelId === "claude-sonnet-5" &&
          (x.reasons ?? []).some((q) => q.message.includes("≠")),
      ),
    ).toBe(true);
  });

  it("a new priced section heading cites UTF-8 bytes, not a UTF-16 count", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          "### Specific tool pricing",
          "### Supplémental pricing\n\nGratuit.\n\n### Specific tool pricing",
        ),
      ),
      scope("anthropic"),
    );
    const review = r.readings.find(
      (x) =>
        x.outcome === "needs-review" &&
        (x.reasons ?? []).some((q) => q.message.includes("Supplémental")),
    );
    expect(review).toBeDefined();
    expect((review?.provenance?.location as { excerpt?: string } | undefined)?.excerpt).toBe(
      "### Supplémental pricing",
    );
  });

  it("a new tool heading cites UTF-8 bytes, not a UTF-16 count", () => {
    const r = readAnthropic(
      anthropicSources((t) =>
        t.replace(
          "### Specific tool pricing",
          "### Specific tool pricing\n\n#### Rätsel pricing\n\nA changed line.",
        ),
      ),
      scope("anthropic"),
    );
    const review = r.readings.find(
      (x) =>
        x.outcome === "needs-review" && (x.reasons ?? []).some((q) => q.message.includes("Rätsel")),
    );
    expect(review).toBeDefined();
    expect((review?.provenance?.location as { excerpt?: string } | undefined)?.excerpt).toBe(
      "#### Rätsel pricing",
    );
  });

  it("a missing source never starves the rest — each page is read independently", () => {
    const partial = readAnthropic(
      {
        pricing: page(ANTHROPIC_URLS.pricing),
        effort: page(ANTHROPIC_URLS.effort),
        modelPage: (id: string) => store().latest(modelPageUrl(id.replace(/^claude-/, ""))),
      },
      scope("anthropic"),
    );
    expect(partial.readings.some((x) => x.kind === "rate")).toBe(true);
    expect(partial.readings.some((x) => x.kind === "effort")).toBe(true);
    expect(partial.sources.map((x) => x.source)).not.toContain("anthropic-models");

    const pricingOnly = readGemini({ pricing: page(GEMINI_URLS.pricing) }, scope("google-gemini"));
    expect(pricingOnly.readings.some((x) => x.kind === "rate")).toBe(true);
    expect(pricingOnly.sources.map((x) => x.source)).not.toContain("gemini-thinking");
    const thinkingOnly = readGemini(
      { thinking: page(GEMINI_URLS.thinking) },
      scope("google-gemini"),
    );
    expect(thinkingOnly.readings.some((x) => x.kind === "effort")).toBe(true);
    expect(thinkingOnly.sources.map((x) => x.source)).not.toContain("gemini-pricing");
  });
});

describe("google-gemini mutations", () => {
  it("an inserted column in a tracked model's table is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Input price\n  * Free of charge\n  * $0.75",
          "  * Priority\n  * Input price\n  * Free of charge\n  * $0.75",
        ),
      ),
      scope("google-gemini"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a moved heading is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          '## Gemini 3.8 Flash  {% id="gemini-3.8-flash" %}',
          '### Gemini 3.8 Flash  {% id="gemini-3.8-flash" %}',
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(codes.some((c) => c.includes("gemini-3.8-flash") && c.includes("missing-model"))).toBe(
      true,
    );
  });

  it("a new footnote touching a tracked model is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "$0.75 through December 31, 2026.",
          "$0.75{% sup %}†{% /sup %} through December 31, 2026.",
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
  });

  it("a missing tracked model is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t
          .replace(
            '## Gemini 3.8 Flash  {% id="gemini-3.8-flash" %}',
            '## Gemini 3.8 Flash  {% id="gemini-3.8-flash-REMOVED" %}',
          )
          .replace(
            "*[`gemini-3.8-flash`](/docs/models/gemini-3.8-flash)*",
            "*[`gemini-3.8-flash-REMOVED`](/docs/models/gemini-3.8-flash)*",
          ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(codes.some((c) => c.includes("gemini-3.8-flash") && c.includes("missing-model"))).toBe(
      true,
    );
    expect(r.readings.some((x) => x.kind === "rate" && x.modelId === "gemini-3.8-flash")).toBe(
      false,
    );
  });

  it("an unparseable amount on a tracked model is needs-review, never a guess", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace("$0.75 through December 31, 2026.", "half price through December 31, 2026."),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("bad-amount");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gemini-3.8-flash" &&
          x.component === "input" &&
          x.fact.disposition === "priced",
      ),
    ).toBe(false);
  });

  it("a changed denomination or currency in the header is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Paid Tier, per 1M tokens in USD\n\n  ---\n\n  * Input price\n  * Free of charge\n  * $0.75 through December 31, 2026.",
          "  * Paid Tier, per 1K tokens in EUR\n\n  ---\n\n  * Input price\n  * Free of charge\n  * $0.75 through December 31, 2026.",
        ),
      ),
      scope("google-gemini"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
    expect(
      r.readings.some(
        (x) => x.kind === "rate" && x.modelId === "gemini-3.8-flash" && x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("an undefined footnote marker taints the row's prices", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Input price\n  * Free of charge\n  * $0.75 through December 31, 2026.",
          "  * Input price{% sup %}†{% /sup %}\n  * Free of charge\n  * $0.75 through December 31, 2026.",
        ),
      ),
      scope("google-gemini"),
    );
    const inputs = r.readings.filter(
      (x) => x.kind === "rate" && x.modelId === "gemini-3.8-flash" && x.component === "input",
    );
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a deleted output row is needs-review, not a silent gap", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          / {2}---\n\n {2}\* Output price \(including thinking tokens\)\n {2}\* Free of charge\n {2}\* \$3\.75[\s\S]*?\n\n {2}---/,
          "  ---",
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(
      codes.some((c) => c.includes("gemini-3.8-flash") && c.includes("missing-component")),
    ).toBe(true);
  });

  it("a duration-denominated primary price is needs-review, never a token price", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "$0.75 through December 31, 2026.",
          "$0.75 per 10s audio through December 31, 2026.",
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unsupported-unit");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gemini-3.8-flash" &&
          x.component === "input" &&
          x.fact.disposition === "priced" &&
          x.fact.amount === "0.75",
      ),
    ).toBe(false);
  });

  it("an unresolved marker on the paid-column header voids the tab", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Paid Tier, per 1M tokens in USD\n\n  ---\n\n  * Input price\n  * Free of charge\n  * $0.75",
          "  * Paid Tier, per 1M tokens in USD{% sup %}†{% /sup %}\n\n  ---\n\n  * Input price\n  * Free of charge\n  * $0.75",
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
    expect(
      r.readings.some(
        (x) => x.kind === "rate" && x.modelId === "gemini-3.8-flash" && x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("an emptied paid cell is needs-review, not a missing component", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * $0.75 through December 31, 2026.   \n  $1.50 starting January 1, 2027.",
          "  *   ",
        ),
      ),
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("bad-amount");
  });

  it("a default effort level outside the model's supported levels is needs-review", () => {
    const r = readGemini(
      {
        pricing: page(GEMINI_URLS.pricing),
        thinking: mutated(page(GEMINI_URLS.thinking), (t) =>
          t.replace(
            "| gemini-3.8-flash | On (medium) | low, medium, high |",
            "| gemini-3.8-flash | On (xhigh) | low, medium, high |",
          ),
        ),
      },
      scope("google-gemini"),
    );
    const efforts = r.readings.filter(
      (x) => x.kind === "effort" && x.modelId === "gemini-3.8-flash",
    );
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts.every((x) => x.outcome === "needs-review")).toBe(true);
    const codes = efforts.flatMap((x) => (x.reasons ?? []).map((q) => q.message));
    expect(codes.some((m) => m.includes("supported levels"))).toBe(true);
  });

  it("a default effort level outside the vocabulary is needs-review", () => {
    const r = readGemini(
      {
        pricing: page(GEMINI_URLS.pricing),
        thinking: mutated(page(GEMINI_URLS.thinking), (t) =>
          t.replace(
            "| gemini-3.8-flash | On (medium) | low, medium, high |",
            "| gemini-3.8-flash | On (turbo) | low, medium, high, turbo |",
          ),
        ),
      },
      scope("google-gemini"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
  });

  it("overlapping date windows on one fact are needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace("$1.50 starting January 1, 2027.", "$1.50 starting December 1, 2026."),
      ),
      scope("google-gemini"),
    );
    const inputs = r.readings.filter(
      (x) => x.kind === "rate" && x.modelId === "gemini-3.8-flash" && x.component === "input",
    );
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((x) => x.outcome === "needs-review")).toBe(true);
    expect(inputs.flatMap((x) => (x.reasons ?? []).map((q) => q.code))).toContain(
      "conflicting-window",
    );
  });

  it("a dropped catalog-tracked component row is needs-review per component", () => {
    // Delete a whole row — separator, feature, free and paid cells — from the
    // gemini-3.8-flash Standard tab only.
    const dropRow = (needle: string) => (t: string) => {
      const at = t.indexOf('id="gemini-3.8-flash"');
      const tail = t
        .slice(at)
        .replace(new RegExp(`\\n\\n  ---\\n\\n  \\* ${needle}[\\s\\S]*?(?=\\n\\n  ---)`), "");
      return t.slice(0, at) + tail;
    };
    for (const [needle, components] of [
      ["Context caching price", ["input_cached", "cache_storage"]],
      ["Grounding with Google Search", ["grounding_search"]],
    ] as const) {
      const r = readGemini(geminiSources(dropRow(needle)), scope("google-gemini"));
      for (const component of components) {
        expect(
          r.readings.some(
            (x) =>
              x.outcome === "needs-review" &&
              x.modelId === "gemini-3.8-flash" &&
              (x as { component?: string }).component === component &&
              (x.reasons ?? []).some((q) => q.code === "missing-component"),
          ),
          `dropped '${needle}' must flag ${component}`,
        ).toBe(true);
      }
      // And no surviving rate claims the dropped component.
      for (const component of components) {
        expect(
          r.readings.some(
            (x) =>
              x.kind === "rate" && x.modelId === "gemini-3.8-flash" && x.component === component,
          ),
        ).toBe(false);
      }
    }
  });
});

describe("google-gemini Lyria tables", () => {
  const plain = () => ({
    pricing: page(GEMINI_URLS.pricing),
    thinking: page(GEMINI_URLS.thinking),
  });
  const lyria = (r: { readings: Reading[] }) =>
    r.readings.filter(
      (x): x is Reading & { modelId: string } =>
        "modelId" in x && typeof x.modelId === "string" && x.modelId.startsWith("lyria-"),
    );
  const rates = (r: { readings: Reading[] }) =>
    lyria(r).filter((x) => x.kind === "rate" && x.outcome === "ok") as unknown as {
      modelId: string;
      tier: string;
      component: string;
      fact: { disposition: string; unit: string; per: number; amount: string; currency: string };
      provenance: { location: { excerpt: string } };
    }[];

  it("reads $0.08 and $0.04 per song as generation / request / per 1", () => {
    const r = readGemini(plain(), scopeWithLyria());
    const got = rates(r)
      .map(
        (x) =>
          `${x.modelId} ${x.tier} ${x.component} ${x.fact.unit} ${x.fact.per} ${x.fact.amount} ${x.fact.currency}`,
      )
      .sort();
    expect(got).toEqual([
      "lyria-3-clip-preview google-gemini:standard generation request 1 0.04 USD",
      "lyria-3-pro-preview google-gemini:standard generation request 1 0.08 USD",
      "lyria-3.5 google-gemini:standard generation request 1 0.08 USD",
    ]);
    expect(
      rates(r)
        .map((x) => x.provenance.location.excerpt)
        .sort(),
    ).toEqual(["$0.04 per song", "$0.08 per song", "$0.08 per song"]);
    expect(reviews(r.readings).filter((x) => x.includes("lyria"))).toEqual([]);
  });

  it("states the lifecycle: Lyria 3.5 available, the two Lyria 3 models preview", () => {
    const r = readGemini(plain(), scopeWithLyria());
    const status = Object.fromEntries(
      r.readings
        .filter((x) => x.kind === "model" && x.modelId.startsWith("lyria-"))
        .map((x) => [x.modelId, (x as { status?: string }).status]),
    );
    expect(status).toEqual({
      "lyria-3.5": "available",
      "lyria-3-clip-preview": "preview",
      "lyria-3-pro-preview": "preview",
    });
  });

  it("reads nothing but models for Lyria when the catalog does not track it", () => {
    const r = readGemini(plain(), scope("google-gemini"));
    expect(lyria(r).every((x) => x.kind === "model")).toBe(true);
  });

  it("a changed per-request header is needs-review for every tracked Lyria model, no rate", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replaceAll("Paid Tier, per request in USD", "Paid Tier, per song in USD"),
      ),
      scopeWithLyria(),
    );
    expect(rates(r)).toEqual([]);
    expect(reviews(r.readings).join("\n")).toMatch(/missing-model.* lyria-3\.5/);
  });

  it("an extra column in a Lyria table is needs-review, no rate", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Feature\n  * Free Tier\n  * Paid Tier, per request in USD\n\n  ---\n\n  * Lyria 3.5",
          "  * Feature\n  * Free Tier\n  * Paid Tier, per request in USD\n  * Batch\n\n  ---\n\n  * Lyria 3.5",
        ),
      ),
      scopeWithLyria(),
    );
    expect(rates(r).filter((x) => x.modelId === "lyria-3.5")).toEqual([]);
    expect(reviews(r.readings).join("\n")).toContain("structure lyria-3.5");
  });

  it("a price that is no longer per song is needs-review, never read as a song price", () => {
    for (const cell of [
      "$0.08 per minute",
      "$0.08 per song (starting January 1, 2027)",
      "$0.08",
      "Free",
    ]) {
      const r = readGemini(
        geminiSources((t) => t.replace("$0.08 per song", cell)),
        scopeWithLyria(),
      );
      expect(reviews(r.readings).join("\n"), cell).toMatch(/bad-amount lyria-3\.5/);
      expect(
        rates(r).map((x) => x.modelId),
        cell,
      ).not.toContain("lyria-3.5");
    }
  });

  it("a row label that names no model id of the section is needs-review, never guessed onto one", () => {
    const r = readGemini(
      geminiSources((t) => t.replace("Lyria 3 Clip Preview (30s)", "Lyria 3 Clip (30s)")),
      scopeWithLyria(),
    );
    expect(rates(r).map((x) => x.modelId)).not.toContain("lyria-3-clip-preview");
    expect(reviews(r.readings).join("\n")).toContain("lyria-3-clip-preview");
  });

  it("a changed descriptor is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace("Lyria 3 Pro Preview (Full Song)", "Lyria 3 Pro Preview (Stems)"),
      ),
      scopeWithLyria(),
    );
    expect(rates(r).map((x) => x.modelId)).not.toContain("lyria-3-pro-preview");
    expect(reviews(r.readings).join("\n")).toContain("lyria-3-pro-preview");
  });

  it("a deleted row for a tracked Lyria model is a missing component, not a free one", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace(
          "  * Lyria 3 Pro Preview (Full Song)\n  * Not available\n  * $0.08 per song\n\n  ---\n\n",
          "",
        ),
      ),
      scopeWithLyria(),
    );
    expect(rates(r).map((x) => x.modelId)).not.toContain("lyria-3-pro-preview");
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:missing-component lyria-3-pro-preview\s+generation/,
    );
  });

  it("a footnote marker in the header is needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replaceAll(
          "Paid Tier, per request in USD",
          "Paid Tier, per request in USD{% sup %}*{% /sup %}",
        ),
      ),
      scopeWithLyria(),
    );
    expect(rates(r)).toEqual([]);
  });

  it("a removed model id from the id statement leaves its row unbound, needs-review", () => {
    const r = readGemini(
      geminiSources((t) =>
        t.replace("[`lyria-3-pro-preview`](/docs/models/lyria-3-pro-preview)*", "*"),
      ),
      scopeWithLyria(),
    );
    expect(rates(r).map((x) => x.modelId)).not.toContain("lyria-3-pro-preview");
    expect(reviews(r.readings).join("\n")).toContain("lyria-3-pro-preview");
  });
});

describe("google-gemini Lyria sections are judged whole", () => {
  const section = (t: string): { start: number; end: number } => {
    const start = t.indexOf("## Lyria 3.5");
    return { start, end: t.indexOf("## Lyria 3  {% id=", start) };
  };
  const lyriaRates = (r: { readings: Reading[] }) =>
    r.readings.filter(
      (x) => x.kind === "rate" && x.outcome === "ok" && x.modelId.startsWith("lyria-"),
    ) as unknown as { modelId: string; fact: { amount: string } }[];

  it("a second table in the section is needs-review, never a silent first-table read", () => {
    const r = readGemini(
      geminiSources((t) => {
        const { end } = section(t);
        const second =
          "{% table %}\n  * Feature\n  * Free Tier\n  * Paid Tier, per request in USD\n\n  ---\n\n  * Lyria 3.5 (Full Song)\n  * Not available\n  * $0.80 per song\n{% /table %}\n\n";
        return t.slice(0, end) + second + t.slice(end);
      }),
      scopeWithLyria(),
    );
    expect(lyriaRates(r).map((x) => x.modelId)).not.toContain("lyria-3.5");
    expect(reviews(r.readings).join("\n")).toContain("structure lyria-3.5");
  });

  it("a dated price announcement after the table is needs-review, never ignored", () => {
    const r = readGemini(
      geminiSources((t) => {
        const { end } = section(t);
        return `${t.slice(0, end)}Lyria 3.5 costs $0.80 per song starting January 1, 2027.\n\n${t.slice(end)}`;
      }),
      scopeWithLyria(),
    );
    expect(lyriaRates(r).map((x) => x.modelId)).not.toContain("lyria-3.5");
    expect(reviews(r.readings).join("\n")).toContain("structure lyria-3.5");
  });

  it("a footnote, a tab or a price in the prose before the table is needs-review", () => {
    for (const prose of [
      "Google's music generation model.{% sup %}*{% /sup %}",
      "Google's music generation model. Now $0.10 per song.",
      "Google's music generation model. Priced through December 31, 2026.",
    ]) {
      const r = readGemini(
        geminiSources((t) => t.replace("Google's music generation model.", prose)),
        scopeWithLyria(),
      );
      expect(
        lyriaRates(r).map((x) => x.modelId),
        prose,
      ).not.toContain("lyria-3.5");
      expect(reviews(r.readings).join("\n"), prose).toContain("structure lyria-3.5");
    }
  });

  it("prose anywhere else in the section is needs-review, whatever it says", () => {
    const mutations: [string, (t: string) => string][] = [
      [
        "between the id statement and the rule",
        (t) =>
          t.replace(
            "[`lyria-3.5`](/docs/models/lyria-3.5)*\n",
            "[`lyria-3.5`](/docs/models/lyria-3.5)*\n\nStarting January 1, 2027, Lyria 3.5 costs $0.80 per song.\n",
          ),
      ],
      [
        "after the table, with no price word",
        (t) => {
          const { end } = section(t);
          return `${t.slice(0, end)}Prices above apply only to the first 100 songs each month; additional songs cost ten times as much.\n\n${t.slice(end)}`;
        },
      ],
      [
        "a changed description",
        (t) =>
          t.replace(
            "Google's music generation model.",
            "Google's music generation model, on sale.",
          ),
      ],
    ];
    for (const [name, mutate] of mutations) {
      const r = readGemini(geminiSources(mutate), scopeWithLyria());
      expect(
        lyriaRates(r).map((x) => x.modelId),
        name,
      ).not.toContain("lyria-3.5");
      expect(reviews(r.readings).join("\n"), name).toContain("structure lyria-3.5");
    }
  });

  it("text inside the table that no row consumes is needs-review, after the opener or a separator", () => {
    const SENTENCE = "Starting January 1, 2027, Lyria 3.5 costs $0.80 per song.";
    const positions: [string, (t: string) => string][] = [
      [
        "right after the opener",
        (t) => {
          const { start } = section(t);
          const at = t.indexOf("{% table %}\n", start) + "{% table %}\n".length;
          return `${t.slice(0, at)}  ${SENTENCE}\n${t.slice(at)}`;
        },
      ],
      [
        "right after a row separator",
        (t) => {
          const { start } = section(t);
          const at = t.indexOf("  ---\n\n", start) + "  ---\n\n".length;
          return `${t.slice(0, at)}  ${SENTENCE}\n\n${t.slice(at)}`;
        },
      ],
    ];
    for (const [name, mutate] of positions) {
      const r = readGemini(geminiSources(mutate), scopeWithLyria());
      expect(
        lyriaRates(r).map((x) => x.modelId),
        name,
      ).not.toContain("lyria-3.5");
      expect(reviews(r.readings).join("\n"), name).toContain("structure lyria-3.5");
    }
  });

  it("the same holds for a token table: stray text in a Standard table is needs-review", () => {
    const SENTENCE = "Starting January 1, 2027, Gemini 3.8 Flash costs $0.80 per token.";
    for (const mutate of [
      (t: string) =>
        t.replace(
          "  * Input price\n  * Free of charge\n  * $0.75",
          `  ${SENTENCE}\n  * Input price\n  * Free of charge\n  * $0.75`,
        ),
      (t: string) =>
        t.replace(
          "  * Input price\n  * Free of charge\n  * $0.75",
          `  ---\n\n  ${SENTENCE}\n\n  * Input price\n  * Free of charge\n  * $0.75`,
        ),
    ]) {
      const r = readGemini(geminiSources(mutate), scope("google-gemini"));
      expect(reviews(r.readings).join("\n")).toContain("structure gemini-3.8-flash");
    }
  });

  it("the unmodified sections still read all three prices", () => {
    const r = readGemini(
      { pricing: page(GEMINI_URLS.pricing), thinking: page(GEMINI_URLS.thinking) },
      scopeWithLyria(),
    );
    expect(lyriaRates(r)).toHaveLength(3);
  });
});

describe("google-gemini Gemini 4 sections", () => {
  const sources = (mutate?: (text: string) => string) => ({
    pricing: mutate === undefined ? body(GEMINI4_PRICING) : mutated(body(GEMINI4_PRICING), mutate),
    thinking: body(GEMINI4_THINKING),
  });
  const ids: readonly string[] = GEMINI4_IDS;
  const ofGemini4 = (r: { readings: Reading[] }) =>
    r.readings.filter(
      (x) => "modelId" in x && typeof x.modelId === "string" && ids.includes(x.modelId),
    );
  type Rate = {
    modelId: string;
    tier: string;
    component: string;
    validFrom?: string;
    validUntil?: string;
    fact: { disposition: string; unit?: string; per?: number; amount?: string; currency?: string };
  };
  const rates = (r: { readings: Reading[] }) =>
    ofGemini4(r).filter(
      (x) => x.kind === "rate" && x.outcome === "ok" && x.tier === "google-gemini:standard",
    ) as unknown as Rate[];
  const line = (x: Rate) =>
    `${x.modelId} ${x.component} ${x.fact.disposition === "priced" ? `${x.fact.amount} ${x.fact.unit}/${x.fact.per} ${x.fact.currency}` : "unsupported"} [${x.validFrom ?? ""}, ${x.validUntil ?? ""})`;
  const STEP = "2026-12-01T00:00:00Z";

  it("reads every Standard rate, with the windows the page states", () => {
    const r = readGemini(sources(), scopeWithGemini4());
    const priced = (id: string) =>
      rates(r)
        .filter((x) => x.modelId === id && x.fact.disposition === "priced")
        .map(line)
        .sort();
    const stepped = (id: string, c: string, before: string, after: string) => [
      `${id} ${c} ${before} token/1000000 USD [, ${STEP})`,
      `${id} ${c} ${after} token/1000000 USD [${STEP}, )`,
    ];
    for (const id of ["gemini-4-carbon", "gemini-4-argon"]) {
      expect(priced(id)).toEqual(
        [
          ...stepped(id, "input", "2.00", "4.00"),
          ...stepped(id, "output", "10.00", "20.00"),
          ...stepped(id, "input_cached", "0.10", "0.20"),
        ].sort(),
      );
    }
    expect(priced("gemini-4-neon")).toEqual([
      "gemini-4-neon input 3.00 token/1000000 USD [, )",
      "gemini-4-neon input_cached 0.15 token/1000000 USD [, )",
      "gemini-4-neon output 15.00 token/1000000 USD [, )",
    ]);
    expect(priced("gemini-4-hydrogen")).toEqual([
      "gemini-4-hydrogen input 1.50 token/1000000 USD [, )",
      "gemini-4-hydrogen input_cached 0.075 token/1000000 USD [, )",
      "gemini-4-hydrogen output 7.50 token/1000000 USD [, )",
    ]);
  });

  it("states grounding as unsupported and no cache storage, and reads nothing else as a rate", () => {
    const r = readGemini(sources(), scopeWithGemini4());
    for (const id of ids) {
      const own = rates(r).filter((x) => x.modelId === id);
      const dispositions = (component: string) =>
        own.filter((x) => x.component === component).map((x) => x.fact.disposition);
      // exactly `unsupported`: `inapplicable` or `priced` must fail here
      expect(dispositions("grounding_search"), id).toEqual(["unsupported"]);
      expect(dispositions("grounding_maps"), id).toEqual(["unsupported"]);
      expect(
        [
          ...new Set(own.filter((x) => x.fact.disposition === "priced").map((x) => x.component)),
        ].sort(),
        id,
      ).toEqual(["input", "input_cached", "output"]);
      expect(
        own.map((x) => x.component),
        id,
      ).not.toContain("cache_storage");
    }
  });

  it("states each model's status and effort levels with their default", () => {
    const r = readGemini(sources(), scopeWithGemini4());
    const status = Object.fromEntries(
      ofGemini4(r)
        .filter((x) => x.kind === "model")
        .map((x) => [(x as { modelId: string }).modelId, (x as { status?: string }).status]),
    );
    expect(status).toEqual(Object.fromEntries(ids.map((id) => [id, "available"])));
    const effort = Object.fromEntries(
      ofGemini4(r)
        .filter((x) => x.kind === "effort")
        .map((x) => {
          const e = x as unknown as { modelId: string; levels: string[]; default: string };
          return [e.modelId, `${e.levels.join(",")}; ${e.default}`];
        }),
    );
    expect(effort).toEqual({
      "gemini-4-carbon": "low,medium,high; medium",
      "gemini-4-argon": "low,medium,high; medium",
      "gemini-4-neon": "low,medium,high,xhigh; high",
      "gemini-4-hydrogen": "low,medium,high,xhigh; high",
    });
  });

  it("raises nothing but the tiers the schema does not model, and exactly the tabs the page has", () => {
    const pricing = body(GEMINI4_PRICING);
    const r = readGemini(sources(), scopeWithGemini4());
    const other = ofGemini4(r)
      .filter((x) => x.outcome !== "ok")
      .filter((x) => !(x.reasons ?? []).every((q) => q.code === "tier-not-in-schema"));
    expect(other).toEqual([]);

    // The tiers observed per model, against the tabs the model's section has in the evidence.
    const text = pricing.bytes.toString("utf8");
    const tabsOf = (id: string): string[] => {
      const from = text.indexOf(`{% id="${id}" %}`);
      expect(from, id).toBeGreaterThan(-1);
      const next = text.indexOf("\n## ", from + 1);
      return [...text.slice(from, next).matchAll(/\{% tab title="([^"]+)" %\}/g)]
        .map((m) => (m[1] ?? "").toLowerCase())
        .filter((t) => t !== "standard")
        .map((t) => `google-gemini:${t}`)
        .sort();
    };
    const observed = (id: string): string[] =>
      ofGemini4(r)
        .filter(
          (x) =>
            x.kind === "observation" &&
            (x as { modelId?: string }).modelId === id &&
            (x.reasons ?? []).some((q) => q.code === "tier-not-in-schema"),
        )
        .map((x) => (x as unknown as { tier: string }).tier)
        .sort();
    for (const id of ids) expect(observed(id), id).toEqual(tabsOf(id));
    // and the tabs themselves, so that a wrong derivation above cannot pass
    const batchFlexPriority = [
      "google-gemini:batch",
      "google-gemini:flex",
      "google-gemini:priority",
    ];
    const withContributor = [...batchFlexPriority, "google-gemini:contributor"].sort();
    expect(observed("gemini-4-carbon")).toEqual(batchFlexPriority);
    expect(observed("gemini-4-argon")).toEqual(withContributor);
    expect(observed("gemini-4-neon")).toEqual(batchFlexPriority);
    expect(observed("gemini-4-hydrogen")).toEqual(withContributor);
  });

  it("reads no rate from a tab other than Standard, whatever its outcome", () => {
    const r = readGemini(sources(), scopeWithGemini4());
    // unfiltered: every rate reading of the four models, ok or not, of any tier
    const every = ofGemini4(r).filter((x) => x.kind === "rate");
    expect(every.filter((x) => (x as { tier?: string }).tier !== "google-gemini:standard")).toEqual(
      [],
    );
    expect(every.filter((x) => x.outcome !== "ok")).toEqual([]);
    const perModel = (id: string) =>
      every.filter((x) => (x as { modelId?: string }).modelId === id).length;
    expect(ids.map(perModel)).toEqual([8, 8, 5, 5]);
  });

  it("cites each rate's own row label, inside its own Standard table", () => {
    const pricing = body(GEMINI4_PRICING);
    const r = readGemini(sources(), scopeWithGemini4());
    const LABEL: Record<string, string> = {
      input: "* Input price",
      output: "* Output price (including thinking tokens)",
      input_cached: "* Context caching price",
      grounding_search: "* Grounding with Google Search",
      grounding_maps: "* Grounding with Google Maps",
    };
    type Cited = Rate & {
      provenance: {
        location: { offset: number; anchors: { offset: number; excerpt: string }[] };
      };
    };
    const rowOffsets = new Map<string, Set<number>>();
    const tabOffsets = new Set<number>();
    for (const x of rates(r) as unknown as Cited[]) {
      const at = `${line(x)}`;
      const { anchors, offset } = x.provenance.location;
      const tab = anchors.find((a) => a.excerpt === '{% tab title="Standard" %}');
      const row = anchors.find((a) => a.excerpt.startsWith("* "));
      if (tab === undefined || row === undefined) throw new Error(`no tab or row anchor: ${at}`);
      // the model's own Standard table ends where the next tab of the page begins
      const end = pricing.bytes.indexOf('{% tab title="', tab.offset + 1);
      expect(row.excerpt, at).toBe(LABEL[x.component]);
      expect(
        pricing.bytes.subarray(row.offset, row.offset + Buffer.byteLength(row.excerpt)).toString(),
        at,
      ).toBe(row.excerpt);
      expect(row.offset, at).toBeGreaterThan(tab.offset);
      expect(row.offset, at).toBeLessThan(end);
      expect(offset, at).toBeGreaterThan(row.offset);
      expect(offset, at).toBeLessThan(end);
      tabOffsets.add(tab.offset);
      const key = `${x.component}`;
      rowOffsets.set(key, (rowOffsets.get(key) ?? new Set()).add(row.offset));
    }
    // four models, four tables, four different rows for the same label
    expect(tabOffsets.size).toBe(4);
    for (const [component, offsets] of rowOffsets) expect(offsets.size, component).toBe(4);
  });

  it("a changed implicit-caching sentence is needs-review, never a caching rate", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          "Implicit caching only (explicit caching is not supported).",
          "Implicit caching only (explicit caching is supported).",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-carbon\s+Context caching price/,
    );
    expect(
      r.readings.filter(
        (x) =>
          x.kind === "rate" && x.modelId === "gemini-4-carbon" && x.component === "input_cached",
      ),
    ).toEqual([]);
  });

  it("the implicit-caching sentence is understood only in a caching cell", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          "$4.00 starting December 1, 2026.\n\n  ---\n\n  * Output price",
          "$4.00 starting December 1, 2026.\n  Implicit caching only (explicit caching is not supported).\n\n  ---\n\n  * Output price",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-carbon\s+Input price/,
    );
    expect(
      rates(r).filter((x) => x.modelId === "gemini-4-carbon" && x.component === "input"),
    ).toEqual([]);
  });

  it("a storage price beside the sentence is needs-review, never a fact", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          "$0.15   \n  Implicit caching only",
          "$0.15   \n  $0.50 / 1,000,000 tokens per hour (storage price)   \n  Implicit caching only",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-neon\s+Context caching price/,
    );
    // the whole cell is a candidate for a person: neither the storage price nor the cached-token
    // price next to it is read as a fact
    expect(
      r.readings.filter(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gemini-4-neon" &&
          (x.component === "cache_storage" || x.component === "input_cached"),
      ),
    ).toEqual([]);
    // and the other models' caching rows are untouched
    expect(
      rates(r).filter((x) => x.modelId === "gemini-4-hydrogen" && x.component === "input_cached"),
    ).toHaveLength(1);
  });

  it("a price qualified by modality in an implicit-only cell is needs-review, not the general rate", () => {
    for (const qualifier of ["(audio)", "(text)"]) {
      const r = readGemini(
        sources((t) =>
          t.replace(
            "$0.15   \n  Implicit caching only",
            `$0.15 ${qualifier}   \n  Implicit caching only`,
          ),
        ),
        scopeWithGemini4(),
      );
      expect(reviews(r.readings).join("\n"), qualifier).toMatch(
        /needs-review:bad-amount gemini-4-neon\s+Context caching price/,
      );
      expect(
        r.readings.filter(
          (x) =>
            x.kind === "rate" && x.modelId === "gemini-4-neon" && x.component === "input_cached",
        ),
        qualifier,
      ).toEqual([]);
    }
  });

  it("an implicit-only cell is accepted as plain prices only: any other text is needs-review", () => {
    // Not a list of bad spellings: whatever else stands in the cell makes the whole cell a candidate.
    for (const extra of [
      " [audio only](/docs/caching)",
      " (cached tokens only)",
      " for audio",
      " per 1,000,000 cached tokens",
    ]) {
      const r = readGemini(
        sources((t) =>
          t.replace(
            "$0.15   \n  Implicit caching only",
            `$0.15${extra}   \n  Implicit caching only`,
          ),
        ),
        scopeWithGemini4(),
      );
      expect(reviews(r.readings).join("\n"), extra).toMatch(
        /needs-review:bad-amount gemini-4-neon\s+Context caching price/,
      );
      expect(
        r.readings.filter(
          (x) =>
            x.kind === "rate" && x.modelId === "gemini-4-neon" && x.component === "input_cached",
        ),
        extra,
      ).toEqual([]);
    }
    // text before the price, too
    const before = readGemini(
      sources((t) =>
        t.replace(
          "* $0.15   \n  Implicit caching only",
          "* Audio: $0.15   \n  Implicit caching only",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(before.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-neon\s+Context caching price/,
    );
    expect(
      before.readings.filter(
        (x) => x.kind === "rate" && x.modelId === "gemini-4-neon" && x.component === "input_cached",
      ),
    ).toEqual([]);
  });

  it("a linked qualification on one window of a dated implicit-only cell is needs-review for both", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          "$0.20 starting December 1, 2026.   \n  Implicit caching only",
          "$0.20 starting December 1, 2026. [audio only](/docs/caching)   \n  Implicit caching only",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-carbon\s+Context caching price/,
    );
    expect(
      r.readings.filter(
        (x) =>
          x.kind === "rate" && x.modelId === "gemini-4-carbon" && x.component === "input_cached",
      ),
    ).toEqual([]);
  });

  it("a qualified price in a dated implicit-only cell is needs-review too", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          "$0.20 starting December 1, 2026.   \n  Implicit caching only",
          "$0.20 (audio) starting December 1, 2026.   \n  Implicit caching only",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:bad-amount gemini-4-carbon\s+Context caching price/,
    );
    // the dated pair is one fact: neither window of the carbon caching price is read
    expect(
      r.readings.filter(
        (x) =>
          x.kind === "rate" && x.modelId === "gemini-4-carbon" && x.component === "input_cached",
      ),
    ).toEqual([]);
  });

  it("a changed footnote definition is needs-review for the grounding row it qualifies", () => {
    const r = readGemini(
      sources((t) =>
        t.replaceAll(
          "A customer-submitted request to Gemini may result in one or",
          "A customer-submitted request to Gemini may be billed twice or",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
    expect(
      rates(r).filter((x) => x.modelId === "gemini-4-carbon" && x.component === "grounding_search"),
    ).toEqual([]);
  });

  it("a changed billing sentence in the Search footnote is needs-review, though the first sentence is intact", () => {
    const r = readGemini(
      // the page wraps this sentence across a line break, so the mutation is whitespace-tolerant
      sources((t) =>
        t.replace(
          /You will be charged for each individual search\s+query performed\./g,
          "You will be charged once for each request, however many search queries are performed.",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
    for (const id of ids) {
      expect(
        rates(r).filter((x) => x.modelId === id && x.component === "grounding_search"),
        id,
      ).toEqual([]);
    }
  });

  it("a sentence added to the Search footnote is needs-review, not an understood prefix", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          /(You will be charged for each individual search\s+query performed\.)/g,
          "$1 A surcharge applies.",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
  });

  it("another understood definition in the Search marker's place is needs-review", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          /A customer-submitted request to Gemini may result in one or\s+more queries to Google Search\.\s+You will be charged for each individual search\s+query performed\./g,
          "Estimated pricing is based on one charge per customer request, regardless of query count.",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(r)).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
    for (const id of ids) {
      expect(
        rates(r).filter((x) => x.modelId === id && x.component === "grounding_search"),
        id,
      ).toEqual([]);
    }
  });

  it("text after the Search definition, as a separate paragraph, is needs-review", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          /(You will be charged for each individual search\s+query performed\.)/g,
          "$1\n\n    During preview, only the first query per request is billed.",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(r)).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
    const messages = ofGemini4(r).flatMap((x) => (x.reasons ?? []).map((q) => q.message));
    expect(messages.join("\n")).toContain("is followed by text this reader does not understand");
    for (const id of ids) {
      expect(
        rates(r).filter((x) => x.modelId === id && x.component === "grounding_search"),
        id,
      ).toEqual([]);
    }
  });

  it("whitespace after the Search definition, and a definition that follows it, are not text after it", () => {
    const blank = readGemini(
      sources((t) =>
        t.replace(
          /(You will be charged for each individual search\s+query performed\.)/g,
          "$1\n\n\n   \n",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(blank)).join("\n")).not.toContain("unknown-footnote");
    for (const id of ids) {
      expect(
        rates(blank).filter((x) => x.modelId === id && x.component === "grounding_search"),
        id,
      ).toHaveLength(1);
    }
    // Carbon's Search row gets a free-tier marker on a second definition, as other models' rows
    // have ("Can be tested in Google AI Studio."): the closed rule is for the label's marker only.
    const second = readGemini(
      sources((t) =>
        t
          .replace(
            "{% sup %}*{% /sup %}\n  * Not available\n  * 5,000 free",
            "{% sup %}*{% /sup %}\n  * Not available{% sup %}**{% /sup %}\n  * 5,000 free",
          )
          .replace(
            /(You will be charged for each individual search\s+query performed\.)/,
            "$1\n\n  {% sup %}**{% /sup %} Can be tested in Google AI Studio.",
          ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(second)).join("\n")).not.toContain("unknown-footnote");
    expect(
      rates(second).filter(
        (x) => x.modelId === "gemini-4-carbon" && x.component === "grounding_search",
      ),
    ).toHaveLength(1);
  });

  it("the Search label's marker needs exactly one definition, wherever the page puts it", () => {
    const DEFINITION =
      /\{% sup %\}\*\{% \/sup %\} A customer-submitted request to Gemini may result in one or\s+more queries to Google Search\.\s+You will be charged for each individual search\s+query performed\./g;
    const other = "{% sup %}*{% /sup %} Estimated pricing is based on one charge per request.";
    const second: Record<string, (t: string) => string> = {
      "inside the tab": (t) => t.replace(DEFINITION, (d) => `${d}\n\n  ${other}`),
      "after the tab's close": (t) =>
        t.replace(/(query performed\.\s*\{% \/tab %\})/g, `$1\n\n  ${other}`),
    };
    for (const [where, mutate] of Object.entries(second)) {
      const r = readGemini(sources(mutate), scopeWithGemini4());
      expect(reviews(ofGemini4(r)).join("\n"), where).toMatch(
        /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
      );
      const messages = ofGemini4(r).flatMap((x) => (x.reasons ?? []).map((q) => q.message));
      expect(messages.join("\n"), where).toContain("is defined 2 times in this tab");
      expect(
        rates(r).filter((x) => x.component === "grounding_search"),
        where,
      ).toEqual([]);
    }
    // The exact definition moved just past the Standard tab's close is a layout the page has
    // (gemini-3-pro-image's): where a definition stands carries no meaning, so it still reads.
    const close = new RegExp(`(${DEFINITION.source})(\\s*\\{% /tab %\\})\\s*`, "g");
    const moved = readGemini(
      sources((t) => t.replace(close, "$2\n\n  $1\n\n  ")),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(moved)).join("\n")).not.toContain("unknown-footnote");
    expect(rates(moved).filter((x) => x.component === "grounding_search")).toHaveLength(ids.length);
  });

  it("the known Search footnote, wrapped differently, is still understood", () => {
    const r = readGemini(
      sources((t) =>
        t.replace(
          /may result in one or\s+more queries to Google Search\./g,
          "may result in one\n  or more queries to\n  Google Search.",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(ofGemini4(r)).join("\n")).not.toContain("unknown-footnote");
    for (const id of ids) {
      expect(
        rates(r).filter((x) => x.modelId === id && x.component === "grounding_search"),
        id,
      ).toHaveLength(1);
    }
  });

  it("a footnote marker with no definition is needs-review, not read as its own definition", () => {
    const r = readGemini(
      sources((t) =>
        t.replaceAll(
          "{% sup %}*{% /sup %} A customer-submitted request to Gemini",
          "A customer-submitted request to Gemini",
        ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(
      /needs-review:unknown-footnote gemini-4-carbon\s+Grounding with Google Search/,
    );
    expect(
      rates(r).filter((x) => x.modelId === "gemini-4-carbon" && x.component === "grounding_search"),
    ).toEqual([]);
  });

  it("a Gemini 4 model the page drops is a missing model", () => {
    const r = readGemini(
      sources((t) =>
        t
          .replace(
            '## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen" %}',
            '## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen-REMOVED" %}',
          )
          .replace(
            "*[`gemini-4-hydrogen`](/docs/models/gemini-4-hydrogen)*",
            "*[`gemini-4-hydrogen-REMOVED`](/docs/models/gemini-4-hydrogen)*",
          ),
      ),
      scopeWithGemini4(),
    );
    expect(reviews(r.readings).join("\n")).toMatch(/missing-model gemini-4-hydrogen/);
    expect(rates(r).filter((x) => x.modelId === "gemini-4-hydrogen")).toEqual([]);
  });
});

describe("openai mutations", () => {
  it("a changed SSR price against its serialized props is needs-review, never a wrong rate", () => {
    const r = readOpenai(
      openaiSources((t) => t.replace(">$2.00</span></td>", ">$3.00</span></td>")),
      scope("openai"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gpt-6.1-sol" &&
          x.component === "input" &&
          x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("a changed serialized price against the SSR table is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          "[[0,&quot;gpt-6.1-sol&quot;],[0,2],[0,0.1],[0,2.5],[0,10]]",
          "[[0,&quot;gpt-6.1-sol&quot;],[0,9],[0,0.1],[0,2.5],[0,10]]",
        ),
      ),
      scope("openai"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a missing pane is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          'data-content-switcher-pane="true" data-value="fast"',
          'data-content-switcher-pane="true" data-value="faster"',
        ),
      ),
      scope("openai"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a moved section heading is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) => t.replace('id="text-tokens"', 'id="token-text"')),
      scope("openai"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a changed context selector is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          'aria-label="Short: ≤272K input tokens"',
          'aria-label="Short: ≤200K input tokens"',
        ),
      ),
      scope("openai"),
    );
    expect(reviews(r.readings).join("\n")).toContain("structure");
  });

  it("a footnote this reader does not understand is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          "Priority processing was renamed Fast mode on July 30, 2026.",
          "Priority processing was renamed Fast mode on July 30, 2026. Volume discounts apply from March 2027.",
        ),
      ),
      scope("openai"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("unknown-footnote");
  });

  it("a dropped Tools row is needs-review, and no tool rate survives for it", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(">Web search (all models)<", ">Web search (reasoning models)<"),
      ),
      scope("openai"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
    expect(
      r.readings.some(
        (x) => x.kind === "rate" && x.component === "web_search" && x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("a tracked model missing from the Standard table is missing-model, never a silent skip", () => {
    const r = readOpenai(
      openaiSources((t) => t.replaceAll("gpt-6.1-terra", "gpt-6.1-terra-X")),
      scope("openai"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(codes.some((c) => c.includes("gpt-6.1-terra") && c.includes("missing-model"))).toBe(
      true,
    );
    const tokenComponents = new Set([
      "input",
      "output",
      "input_cached",
      "cache_write_30m",
      "cache_write_12h",
    ]);
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gpt-6.1-terra" &&
          x.outcome === "ok" &&
          tokenComponents.has(x.component),
      ),
    ).toBe(false);
  });

  it("a model-page multiplier contradicting the table is needs-review", () => {
    const r = readOpenai(
      openaiSources(
        (t) =>
          t.replace(
            "priced at 5% of the uncached input token rate",
            "priced at 50% of the uncached input token rate",
          ),
        "modelPage",
      ),
      scope("openai"),
    );
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" &&
          x.modelId === "gpt-6.1-sol" &&
          (x.reasons ?? []).some((q) => q.code === "structure"),
      ),
    ).toBe(true);
  });

  it("a missing long-context note on a tracked model is needs-review, never a partial read", () => {
    const r = readOpenai(
      openaiSources(
        (t) =>
          t.replace(
            "API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.",
            "The model supports a large context window.",
          ),
        "modelPage",
      ),
      scope("openai"),
    );
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" &&
          x.modelId === "gpt-6.1-sol" &&
          (x.reasons ?? []).some((q) => q.message.includes("surcharge")),
      ),
    ).toBe(true);
    const tokenComponents = new Set([
      "input",
      "output",
      "input_cached",
      "cache_write_30m",
      "cache_write_12h",
    ]);
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gpt-6.1-sol" &&
          x.outcome === "ok" &&
          tokenComponents.has(x.component) &&
          JSON.stringify(x.condition).includes("gt"),
      ),
    ).toBe(false);
  });

  it("an effort level outside the vocabulary is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) => t.replace("<code>xhigh</code>", "<code>xtreme</code>"), "modelPage"),
      scope("openai"),
    );
    const efforts = r.readings.filter((x) => x.kind === "effort" && x.modelId === "gpt-6.1-sol");
    expect(efforts.some((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a changed denomination rescales nothing — the section fails closed", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          'flagship-pricing-meta">Prices per 1M tokens.',
          'flagship-pricing-meta">Prices per 1K tokens.',
        ),
      ),
      scope("openai"),
    );
    expect(r.readings.some((x) => x.outcome === "needs-review")).toBe(true);
    expect(r.readings.some((x) => x.kind === "rate" && x.outcome === "ok")).toBe(false);
  });

  it("a changed model-page denomination is needs-review", () => {
    const r = readOpenai(
      openaiSources((t) => t.replace(">Per 1M tokens</div>", ">Per 1K tokens</div>"), "modelPage"),
      scope("openai"),
    );
    expect(
      r.readings.some((x) => x.outcome === "needs-review" && x.modelId === "gpt-6.1-sol"),
    ).toBe(true);
  });

  it("a footnote marker inside a table cell is needs-review, never silently dropped", () => {
    const r = readOpenai(
      openaiSources((t) => t.replace(">$2.00</span></td>", ">$2.00</span><sup>9</sup></td>")),
      scope("openai"),
    );
    expect(r.readings.some((x) => x.outcome === "needs-review")).toBe(true);
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "gpt-6.1-sol" &&
          x.component === "input" &&
          x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("a conflicting second long-context statement taints every derived rate", () => {
    const r = readOpenai(
      openaiSources(
        (t) =>
          t.replace(
            "API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.</p>",
            'API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.</p></div></div><div class="[&amp;_p]:!m-0 [&amp;_p]:!leading-relaxed"><div class="_MarkdownContent_13d6z_1 _Compact_13d6z_289"><p>API prompts with more than 272K input tokens are priced at 3x input and cache rates and 2x output for the full request.</p>',
          ),
        "modelPage",
      ),
      scope("openai"),
    );
    const tokenComponents = new Set(["input", "output", "input_cached"]);
    const gt = r.readings.filter(
      (x) =>
        x.kind === "rate" &&
        x.modelId === "gpt-6.1-sol" &&
        x.fact.disposition === "priced" &&
        tokenComponents.has(x.component) &&
        JSON.stringify(x.condition).includes("gt"),
    );
    expect(gt.length).toBeGreaterThan(0);
    expect(gt.every((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a new pane the schema does not model is needs-review, never silently omitted", () => {
    const r = readOpenai(
      openaiSources((t) =>
        t.replace(
          'data-content-switcher-pane="true" data-value="standard"',
          'data-content-switcher-pane="true" data-value="economy"></div><div data-content-switcher-pane="true" data-value="standard"',
        ),
      ),
      scope("openai"),
    );
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" &&
          (x.reasons ?? []).some((q) => q.message.includes("economy")),
      ),
    ).toBe(true);
  });

  it("a pricing note the reader does not understand — attributes or not — is needs-review", () => {
    const r = readOpenai(
      openaiSources(
        (t) =>
          t.replace(
            "Cached input tokens are priced at 5% of the uncached input token rate.</p>",
            'Cached input tokens are priced at 5% of the uncached input token rate.</p><p class="pricing-note">Input tokens above 500K cost $10 per million.</p>',
          ),
        "modelPage",
      ),
      scope("openai"),
    );
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" &&
          x.modelId === "gpt-6.1-sol" &&
          (x.reasons ?? []).some((q) => q.message.includes("500K")),
      ),
    ).toBe(true);
  });
});

describe("elevenlabs mutations", () => {
  it("a changed card price against the plan table is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            '<span class="tw-type-2xl">$0.08</span>',
            '<span class="tw-type-2xl">$0.09</span>',
          ),
        "pricing",
      ),
      scope("elevenlabs"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "eleven_v4" &&
          x.fact.disposition === "priced" &&
          (x.fact as { amount: string }).amount === "0.09" &&
          x.outcome === "ok",
      ),
    ).toBe(false);
  });

  it("a changed plan-table cell against the card is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            '<span>$0.08</span><span class="tw-text-gray-500"><span>~$0.08/minute</span></span>',
            '<span>$0.09</span><span class="tw-text-gray-500"><span>~$0.09/minute</span></span>',
          ),
        "pricing",
      ),
      scope("elevenlabs"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
    expect(
      r.readings.some(
        (x) =>
          x.kind === "rate" &&
          x.modelId === "eleven_v4" &&
          (x.fact as { amount?: string }).amount === "0.08" &&
          x.outcome === "needs-review",
      ),
    ).toBe(true);
  });

  it("a plan cell carrying an extra charge or a dated price is needs-review", () => {
    for (const cell of [
      '<span>$0.08</span><span class="tw-text-gray-500"><span>~$0.08/minute plus $1 per request</span></span>',
      '<span>$0.08</span><span class="tw-text-gray-500"><span>~$0.08/second</span></span>',
      "<span>$0.08 starting January 1, 2027</span>",
    ]) {
      const r = readElevenlabs(
        elevenlabsSources(
          (t) =>
            t.replace(
              '<span>$0.08</span><span class="tw-text-gray-500"><span>~$0.08/minute</span></span>',
              cell,
            ),
          "pricing",
        ),
        scope("elevenlabs"),
      );
      expect(
        r.readings.some((x) => x.outcome === "needs-review"),
        `cell ${cell} must flag needs-review`,
      ).toBe(true);
    }
  });

  it("a new product card is needs-review, never silently skipped", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            '<h3 class="tw-mb-3 tw-transition-colors tw-type-3xl tw-text-white">v4</h3>',
            '<h3 class="tw-mb-3 tw-transition-colors tw-type-3xl tw-text-white">v5</h3>',
          ),
        "pricing",
      ),
      scope("elevenlabs"),
    );
    expect(
      r.readings.some(
        (x) =>
          x.outcome === "needs-review" && (x.reasons ?? []).some((q) => q.message.includes("v5")),
      ),
    ).toBe(true);
    expect(
      r.readings.some((x) => x.kind === "rate" && x.modelId === "eleven_v4" && x.outcome === "ok"),
    ).toBe(false);
  });

  it("a missing tracked model is missing-model", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) => t.replace("<td><code>eleven_v3</code></td>", "<td><code>eleven_v3_old</code></td>"),
        "models",
      ),
      scope("elevenlabs"),
    );
    const codes = r.readings.flatMap(
      (x) => `${x.modelId ?? ""}:${(x.reasons ?? []).map((q) => q.code).join("+")}`,
    );
    expect(codes.some((c) => c.includes("eleven_v3") && c.includes("missing-model"))).toBe(true);
    // and the renamed id is still emitted as a current model, not silently dropped
    expect(
      r.readings.some(
        (x) => x.kind === "model" && x.modelId === "eleven_v3_old" && x.status === "available",
      ),
    ).toBe(true);
  });

  it("a removed deprecation notice on a tracked deprecated model is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            'The <code>music_v1</code> model is deprecated and will be removed on <strong class="font-semibold">January 31, 2027</strong>.',
            "",
          ),
        "models",
      ),
      scope("elevenlabs"),
    );
    const music = r.readings.filter((x) => x.kind === "model" && x.modelId === "music_v1");
    expect(music.some((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a second removal notice with a different date is needs-review, never an overwrite", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "<code>eleven_text_to_sound_v2</code> model is deprecated",
            '<code>music_v1</code> model is deprecated and will be removed on <strong class="font-semibold">June 30, 2027</strong>. The <code>eleven_text_to_sound_v2</code> model is deprecated',
          ),
        "models",
      ),
      scope("elevenlabs"),
    );
    const music = r.readings.filter((x) => x.kind === "model" && x.modelId === "music_v1");
    expect(music.some((x) => x.outcome === "needs-review")).toBe(true);
  });

  it("a conflicting second price grid under the same product is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => {
        const g =
          /<div class="tw-grid tw-grid-cols-2 md:tw-grid-cols-\[1\.5fr_repeat\(6,1fr\)\][^"]*">/g;
        const v4 = t.indexOf('tw-type-2xs">v4</div>');
        g.lastIndex = v4;
        const first = g.exec(t)?.index ?? -1;
        const second = g.exec(t)?.index ?? -1;
        const dup = t.slice(first, second).replaceAll("$0.08", "$0.99");
        return `${t.slice(0, second)}${dup}${t.slice(second)}`;
      }, "pricing"),
      scope("elevenlabs"),
    );
    const v4 = r.readings.filter((x) => x.kind === "rate" && x.modelId === "eleven_v4");
    expect(v4.some((x) => x.outcome === "needs-review")).toBe(true);
    expect(v4.some((x) => x.outcome === "ok")).toBe(false);
  });

  it("a second, conflicting row for the same metric in one grid is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => {
        const g =
          /<div class="tw-grid tw-grid-cols-2 md:tw-grid-cols-\[1\.5fr_repeat\(6,1fr\)\][^"]*">/g;
        const v4 = t.indexOf('tw-type-2xs">v4</div>');
        g.lastIndex = v4;
        const g0 = g.exec(t)?.index ?? -1;
        const g1 = g.exec(t)?.index ?? t.length;
        let seg = t.slice(g0, g1);
        // a second 'Price per 1K characters' row under the first
        const labelP =
          '<p class="tw-text-gray-700 tw-line-clamp-3 tw-f-paragraph-03">Price per 1K characters</p>';
        seg = seg.replace(labelP, labelP + labelP);
        // its cell in every plan column states a conflicting price
        seg = seg
          .split(/(?=<div class="tw-align-top tw-px-1[^"]*">)/)
          .map((part, i) =>
            i === 0
              ? part
              : part.replace(
                  /(<p class="tw-f-paragraph-03">[\s\S]*?<\/p>)/,
                  '$1<p class="tw-f-paragraph-03">$0.99</p>',
                ),
          )
          .join("");
        return t.slice(0, g0) + seg + t.slice(g1);
      }, "pricing"),
      scope("elevenlabs"),
    );
    const v4 = r.readings.filter((x) => x.kind === "rate" && x.modelId === "eleven_v4");
    expect(v4.some((x) => x.outcome === "needs-review")).toBe(true);
    expect(v4.some((x) => x.outcome === "ok")).toBe(false);
  });

  it("a deprecation sentence contradicting the notice date is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "<code>eleven_text_to_sound_v2</code> is still the default but is deprecated and will be removed on March 1, 2027.",
            "<code>eleven_text_to_sound_v2</code> is still the default but is deprecated and will be removed on April 1, 2027.",
          ),
        "models",
      ),
      scope("elevenlabs"),
    );
    expect(
      r.readings.some(
        (x) => x.outcome === "needs-review" && x.modelId === "eleven_text_to_sound_v2",
      ),
    ).toBe(true);
  });

  it("an inserted unknown table is needs-review", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "<th>Model ID</th><th>Description</th><th>Languages</th>",
            "<th>Model ID</th><th>Description</th><th>Languages</th><th>Pricing tier</th>",
          ),
        "models",
      ),
      scope("elevenlabs"),
    );
    const codes = r.readings.flatMap((x) => (x.reasons ?? []).map((q) => q.code));
    expect(codes).toContain("structure");
  });
});

describe("elevenlabs owner attributions", () => {
  const SUCCESSORS = scopeWithElevenlabsSuccessors;
  const sources = () => ({
    pricing: page(ELEVENLABS_URLS.pricing),
    models: page(ELEVENLABS_URLS.models),
  });
  const ok = (r: { readings: Reading[] }, modelId: string) =>
    r.readings.filter(
      (x): x is Extract<Reading, { kind: "rate" }> =>
        x.kind === "rate" && x.modelId === modelId && x.outcome === "ok",
    );
  /** The one reading a successor gets that is not its model row: a rate or an observation. */
  const reading = (r: { readings: Reading[] }, modelId: string) =>
    r.readings.find(
      (x) => (x as { modelId?: string }).modelId === modelId && x.kind !== "model",
    ) as unknown as
      | {
          kind: string;
          outcome: string;
          reasons: { code: string; message: string }[];
          provenance?: { note?: string };
        }
      | undefined;

  it("reads the card's rate for each attributed model, noted as the owner's attribution", () => {
    const r = readElevenlabs(sources(), SUCCESSORS());
    // The mapped models keep their rates.
    expect(ok(r, "music_v1")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v2")).toHaveLength(1);
    // The attributed models get the card's rate, nothing else.
    for (const [id, amount] of [
      ["music_v2_5", "0.15"],
      ["music_v2", "0.15"],
      ["eleven_text_to_sound_v3", "0.12"],
    ] as const) {
      const rates = ok(r, id);
      expect(rates, id).toHaveLength(1);
      const x = rates[0];
      expect(x?.tier).toBe("elevenlabs:pay-as-you-go");
      expect(x?.component).toBe("output_audio_duration");
      expect(x?.fact).toEqual({
        disposition: "priced",
        unit: "minute",
        per: 1,
        amount,
        currency: "USD",
      });
      expect(x?.provenance.note).toContain("names no model id");
      expect(x?.provenance.note).toContain(
        `applied to ${id} by the owner's decision of 2026-11-05`,
      );
    }
  });

  it("a changed card price moves the attributed rate like the mapped one", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => t.replaceAll("$0.15", "$0.18"), "pricing"),
      SUCCESSORS(),
    );
    for (const id of ["music_v1", "music_v2_5", "music_v2"]) {
      const rates = ok(r, id);
      expect(rates, id).toHaveLength(1);
      expect((rates[0]?.fact as { amount?: string } | undefined)?.amount).toBe("0.18");
    }
  });

  it("an attributed model no longer current on the models page is needs-review, no rate", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "<td><code>eleven_text_to_sound_v3</code></td><td>",
            "<td><code>eleven_text_to_sound_v9</code></td><td>",
          ),
        "models",
      ),
      SUCCESSORS(),
    );
    expect(ok(r, "eleven_text_to_sound_v3")).toEqual([]);
    const review = reading(r, "eleven_text_to_sound_v3");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons[0]?.code).toBe("attribution-void");
    expect(review?.reasons[0]?.message).toContain("eleven_text_to_sound_v3");
  });

  it("a pricing page that names the model is needs-review, for every attribution of the card", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "Studio-grade music from natural language prompts",
            "Studio-grade music from natural language prompts (<code>music_v2_5</code>)",
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      const review = reading(r, id);
      expect(review?.outcome, id).toBe("needs-review");
      expect(
        review?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    // The mapped model's product rate stands: the card itself still prices the product.
    expect(ok(r, "music_v1")).toHaveLength(1);
  });

  it("a model-priced line inside the card voids the attribution whatever its markup", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "Studio-grade music from natural language prompts</span>",
            'Studio-grade music from natural language prompts</span><span class="tw-type-sm">Eleven Music v2.5: $0.30 per minute</span>',
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      const review = reading(r, id);
      expect(review?.outcome, id).toBe("needs-review");
      expect(
        review?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    // The headline price still prices the product for the mapped model.
    expect(ok(r, "music_v1")).toHaveLength(1);
  });

  it("a second price in any markup voids the attribution even with no model named", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "Studio-grade music from natural language prompts</span>",
            'Studio-grade music from natural language prompts</span><span class="tw-type-xs">introductory rate $0.09 per minute</span>',
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      expect(
        reading(r, id)?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
  });

  it("a version-named model in the card text voids the attribution without a price", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "Studio-grade music from natural language prompts",
            "Studio-grade music from natural language prompts (Eleven Music v2.5)",
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      expect(
        reading(r, id)?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    // A different card's attribution is untouched.
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a sibling card naming the product voids the attribution", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => t.replace(">Voice Isolator</h3>", ">Eleven Music</h3>"), "pricing"),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      expect(
        reading(r, id)?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a plan-table section named an attributed model voids that attribution", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            '<h3 class="tw-type-2xl tw-mb-2">Voice Isolator</h3>',
            '<h3 class="tw-type-2xl tw-mb-2">music_v2_5</h3>',
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    expect(ok(r, "music_v2_5")).toEqual([]);
    const review = reading(r, "music_v2_5");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons.some((q) => q.code === "attribution-void")).toBe(true);
    // The page names only music_v2_5, so only its attribution is void.
    expect(ok(r, "music_v2")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a row label naming an attributed model under a sibling section voids that attribution", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => {
        const mark = t.indexOf('<h3 class="tw-type-2xl tw-mb-2">Voice Isolator</h3>');
        const label = t.indexOf(">Price per minute</p>", mark);
        return `${t.slice(0, label)}>Price per minute (music_v2_5)</p>${t.slice(label + ">Price per minute</p>".length)}`;
      }, "pricing"),
      SUCCESSORS(),
    );
    expect(ok(r, "music_v2_5")).toEqual([]);
    const review = reading(r, "music_v2_5");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons.some((q) => q.code === "attribution-void")).toBe(true);
    // The page names no other attributed id, so theirs stands.
    expect(ok(r, "music_v2")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a model id in a footnote outside every grid voids that attribution", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "</body>",
            "<p>footnote: the music_v2 rate is set per generation, not per minute</p></body>",
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    expect(ok(r, "music_v2")).toEqual([]);
    expect(reading(r, "music_v2")?.reasons.some((q) => q.code === "attribution-void")).toBe(true);
    // An exact-token match: 'music_v2' in the footnote does not touch music_v2_5.
    expect(ok(r, "music_v2_5")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("music_v2_5 in the page text does not void music_v2 by substring", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "</body>",
            "<p>footnote: the music_v2_5 rate is set per generation, not per minute</p></body>",
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    expect(ok(r, "music_v2_5")).toEqual([]);
    expect(reading(r, "music_v2_5")?.reasons.some((q) => q.code === "attribution-void")).toBe(true);
    expect(ok(r, "music_v2")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("an attributed model listed as both current and deprecated is needs-review, no rate", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace("<td><code>music_v1</code></td><td>", "<td><code>music_v2_5</code></td><td>"),
        "models",
      ),
      SUCCESSORS(),
    );
    expect(ok(r, "music_v2_5")).toEqual([]);
    const review = reading(r, "music_v2_5");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons[0]?.code).toBe("attribution-void");
    // music_v2 stays current-only and keeps its rate.
    expect(ok(r, "music_v2")).toHaveLength(1);
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a model id in a plan-table label's markup voids the attribution", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(">Cost per Finetune</p>", ">Price per minute (<code>music_v2_5</code>)</p>"),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      const review = reading(r, id);
      expect(review?.outcome, id).toBe("needs-review");
      expect(
        review?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a version tag in an adjacent block voids the attribution despite tag boundaries", () => {
    const r = readElevenlabs(
      elevenlabsSources(
        (t) =>
          t.replace(
            "Studio-grade music from natural language prompts</span>",
            "Studio-grade music from natural language prompts</span><div>v2.5 only</div>",
          ),
        "pricing",
      ),
      SUCCESSORS(),
    );
    for (const id of ["music_v2_5", "music_v2"]) {
      expect(ok(r, id), id).toEqual([]);
      expect(
        reading(r, id)?.reasons.some((q) => q.code === "attribution-void"),
        id,
      ).toBe(true);
    }
    expect(ok(r, "eleven_text_to_sound_v3")).toHaveLength(1);
  });

  it("a successor the owner did not list still gets only the candidate", () => {
    const r = readElevenlabs(
      elevenlabsSources((t) => t.replaceAll("music_v2_5", "music_v9"), "models"),
      (() => {
        const s = SUCCESSORS();
        s.models.set("music_v9", {
          status: "available",
          hasEffort: false,
          offerings: new Set(["elevenlabs:pay-as-you-go"]),
          components: new Map(),
        });
        return s;
      })(),
    );
    expect(ok(r, "music_v9")).toEqual([]);
    const review = reading(r, "music_v9");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons[0]?.code).toBe("unstated-rate");
    expect(review?.reasons[0]?.message).toContain("candidate: $0.15 price per minute");
    // music_v2_5 is gone from the page, so its own attribution falls back to review.
    expect(ok(r, "music_v2_5")).toEqual([]);
    expect(reading(r, "music_v2_5")?.reasons[0]?.code).toBe("attribution-void");
  });

  it("without the models page the attribution cannot be confirmed either", () => {
    const r = readElevenlabs({ pricing: page(ELEVENLABS_URLS.pricing) }, SUCCESSORS());
    expect(ok(r, "music_v2_5")).toEqual([]);
    const review = reading(r, "music_v2_5");
    expect(review?.outcome).toBe("needs-review");
    expect(review?.reasons[0]?.code).toBe("attribution-void");
  });

  it("is unchanged when nothing tracks the successors", () => {
    const r = readElevenlabs(sources(), scope("elevenlabs"));
    expect(reading(r, "music_v2_5")).toBeUndefined();
    expect(ok(r, "music_v1")).toHaveLength(1);
  });
});
