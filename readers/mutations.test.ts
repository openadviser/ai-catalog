// Mutation fixtures: the same saved pages with one thing changed. Every mutation in
// tracked scope must produce `needs-review` — never a wrong or partial price, never
// silence.

import {
  ANTHROPIC_URLS,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import { GEMINI_URLS, readGemini } from "@openadviser/ai-catalog-reader-gemini";
import type { Reading } from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import { mutated, page, scope, store } from "./testing.ts";

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
