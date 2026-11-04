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

function anthropicSources(mutate: (text: string) => string) {
  return {
    pricing: mutated(page(ANTHROPIC_URLS.pricing), mutate),
    models: page(ANTHROPIC_URLS.models),
    effort: page(ANTHROPIC_URLS.effort),
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
});
