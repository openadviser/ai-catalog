// The reconciler on fixtures: the saved pages, mutated, read by the real readers in a live
// run with a fake fetcher (no network, no keys). One scenario per class, generic coverage
// per provider, acknowledgements, lineage and eligibility, and the partition.
import { describe, expect, it } from "vitest";
import {
  afterAnchor,
  consistentSonnetInputChange,
  group,
  item,
  MD_SONNET_COST,
  MD_SONNET_DATES,
  MD_SONNET_FRESH,
  NOW,
  once,
  scenario,
  URLS,
} from "./helpers.ts";

const SONNET_ROW_INPUT = "| $2 / MTok<sup>3</sup> |";
const SONNET_ROW_OUTPUT = "| $10 / MTok<sup>3</sup> |";
const STANDARD = "rate|anthropic|claude-sonnet-5|anthropic:standard|..";
const BATCH = "rate|anthropic|claude-sonnet-5|anthropic:batch|..";

describe("the saved evidence", () => {
  it("reconciles to no change: every tracked fact is read and equal", async () => {
    const { plan } = await scenario();
    expect(plan.items).toEqual([]);
    expect(plan.groups).toEqual([]);
    expect(plan.unchanged).toEqual({
      anthropic: 24,
      openai: 26,
      "google-gemini": 25,
      elevenlabs: 10,
    });
  });

  it("a missing key makes each API source unreadable, 'no key', and the run goes on", async () => {
    const { plan } = await scenario();
    const noKey = plan.unreadable
      .filter((u) => u.reasons.some((r) => r.code === "no-key"))
      .map((u) => u.source);
    expect(noKey.sort()).toEqual([
      "anthropic-models-api",
      "elevenlabs-models-api",
      "gemini-models",
      "openai-models-api",
    ]);
  });
});

describe("classes", () => {
  it("confirmed: the official page and a fresh, eligible cross-check agree, within the factor", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) => once(t, SONNET_ROW_OUTPUT, "| $12 / MTok<sup>3</sup> |"),
      [URLS.modelsDev]: (t) =>
        once(
          once(t, MD_SONNET_COST, MD_SONNET_COST.replace('"output":10,', '"output":12,')),
          MD_SONNET_DATES,
          MD_SONNET_FRESH,
        ),
    });
    const [output] = item(
      plan,
      (id) => id === `amount|anthropic|claude-sonnet-5|anthropic:standard|output||..`,
    );
    expect(output?.class).toBe("confirmed");
    expect(output?.ratio).toMatchObject({ fraction: "6/5", within: true });
    // genai-prices still states 10, but its entry was last checked 2026-10-19, before the
    // catalog's own observation: not eligible, so it neither confirms nor conflicts.
    const genai = output?.crossChecks.find((e) => e.source === "genai-prices");
    expect(genai).toMatchObject({ eligible: false, agrees: false });
    expect(genai?.why).toContain("not after the catalog's observation");
    expect(group(plan, STANDARD)?.partition).toBe("confirmed");
    expect(plan.groups.map((g) => g.id)).toEqual([STANDARD]);
  });

  it("single-source: no eligible cross-check covers the change", async () => {
    const { plan } = await scenario({
      [URLS.geminiPricing]: (t) =>
        afterAnchor(
          t,
          '{% id="gemini-3.1-flash-tts-preview" %}',
          "* $1.00 (text)",
          "* $1.10 (text)",
        ),
    });
    const [input] = item(plan, (id) =>
      id.startsWith(
        "amount|google-gemini|gemini-3.1-flash-tts-preview|google-gemini:standard|input|",
      ),
    );
    expect(input?.class).toBe("single-source");
    expect(input?.crossChecks.every((e) => !e.eligible)).toBe(true);
    expect(
      group(plan, "rate|google-gemini|gemini-3.1-flash-tts-preview|google-gemini:standard|..")
        ?.partition,
    ).toBe("review");
  });

  it("conflict: an eligible cross-check disagrees", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) => once(t, SONNET_ROW_OUTPUT, "| $11 / MTok<sup>3</sup> |"),
      [URLS.modelsDev]: (t) => once(t, MD_SONNET_DATES, MD_SONNET_FRESH),
    });
    const [output] = item(
      plan,
      (id) => id === `amount|anthropic|claude-sonnet-5|anthropic:standard|output||..`,
    );
    expect(output?.class).toBe("conflict");
    expect(output?.crossChecks.find((e) => e.source === "models-dev")).toMatchObject({
      eligible: true,
      agrees: false,
    });
    expect(group(plan, STANDARD)?.partition).toBe("review");
  });

  it("needs-review: beyond the factor, even when a cross-check agrees", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) => once(t, SONNET_ROW_INPUT, "| $4 / MTok<sup>3</sup> |"),
      [URLS.modelsDev]: (t) =>
        once(
          once(t, MD_SONNET_COST, MD_SONNET_COST.replace('"input":2,', '"input":4,')),
          MD_SONNET_DATES,
          MD_SONNET_FRESH,
        ),
    });
    const [input] = item(
      plan,
      (id) => id === `amount|anthropic|claude-sonnet-5|anthropic:standard|input||..`,
    );
    expect(input?.class).toBe("needs-review");
    expect(input?.reasons.map((r) => r.code)).toContain("beyond-factor");
    expect(input?.ratio).toMatchObject({ fraction: "2/1", within: false });
  });

  it("needs-review: a reader finding in tracked scope blocks the offering", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) =>
        once(t, SONNET_ROW_OUTPUT, "| $10 / MTok<sup>3</sup><sup>9</sup> |"),
    });
    const reader = plan.items.filter(
      (i) => i.kind === "reader" && i.reasons.some((r) => r.code === "unknown-footnote"),
    );
    expect(reader.length).toBeGreaterThan(0);
    expect(reader.every((i) => i.class === "needs-review")).toBe(true);
  });

  it("unreadable: a page that cannot be fetched is listed by source, and its facts are tracked, not read", async () => {
    const { plan } = await scenario({}, { missing: [URLS.geminiThinking] });
    expect(plan.unreadable.find((u) => u.source === "gemini-thinking")?.reasons[0]?.code).toBe(
      "fetch-failed",
    );
    const [effort] = item(
      plan,
      (id) => id === "tracked-not-read|effort|google-gemini|gemini-3.8-flash",
    );
    expect(effort?.class).toBe("needs-review");
  });
});

describe("generic coverage: one tracked row removed per provider is tracked, not read", () => {
  const notRead = (plan: Awaited<ReturnType<typeof scenario>>["plan"], prefix: string) =>
    plan.items.filter(
      (i) => i.kind === "tracked-not-read" && i.id.startsWith(`tracked-not-read|${prefix}`),
    );

  it("anthropic: the Claude Sonnet 5 row of the model-pricing table", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) => t.replace(/\| Claude Sonnet 5\s+\|[^\n]*\n/, ""),
    });
    const ids = notRead(plan, "anthropic|claude-sonnet-5|anthropic:standard|").map(
      (i) => i.subject.component,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "input",
        "output",
        "input_cached",
        "cache_write_5m",
        "cache_write_1h",
      ]),
    );
    expect(group(plan, STANDARD)?.partition).toBe("review");
  });

  it("google-gemini: the Gemini 3.8 Flash output row", async () => {
    const { plan } = await scenario({
      [URLS.geminiPricing]: (t) =>
        t.replace(
          / {2}---\n\n {2}\* Output price \(including thinking tokens\)\n {2}\* Free of charge\n {2}\* \$3\.75[\s\S]*?\n\n {2}---/,
          "  ---",
        ),
    });
    const windows = notRead(
      plan,
      "google-gemini|gemini-3.8-flash|google-gemini:standard|output|",
    ).map((i) => i.subject.window);
    expect(windows).toHaveLength(2);
  });

  it("openai: the GPT-6.1 Sol rows of the pricing table", async () => {
    const { plan } = await scenario({
      [URLS.openaiPricing]: (t) => t.replaceAll("gpt-6.1-sol", "gpt-6.1-sol-X"),
    });
    expect(notRead(plan, "openai|gpt-6.1-sol|openai:standard|input|").length).toBeGreaterThan(0);
  });

  it("elevenlabs: the eleven_v3 row of the models table", async () => {
    const { plan } = await scenario({
      [URLS.elevenlabsModels]: (t) =>
        t.replace("<td><code>eleven_v3</code></td>", "<td><code>eleven_v3_old</code></td>"),
    });
    expect(
      item(plan, (id) => id === "tracked-not-read|lifecycle|elevenlabs|eleven_v3"),
    ).toHaveLength(1);
  });

  it("works whatever the reader dropped: a fact removed from a report is tracked, not read", async () => {
    const s = await scenario();
    const report = s.run.reports.find((r) => r.provider === "elevenlabs");
    if (report === undefined) throw new Error("no report");
    report.readings = report.readings.filter(
      (r) => !(r.kind === "rate" && r.modelId === "music_v1"),
    );
    const plan = s.replan();
    expect(item(plan, (id) => id.startsWith("tracked-not-read|elevenlabs|music_v1|"))).toHaveLength(
      1,
    );
  });
});

describe("acknowledged observations", () => {
  it("a standing observation is acknowledged; once its content changes it is raised again and blocks the provider", async () => {
    const base = await scenario();
    expect(
      base.plan.acknowledged.some((a) => a.observation.component === "product 'Voice Isolator'"),
    ).toBe(true);
    const { plan } = await scenario({
      [URLS.elevenlabsPricing]: (t) => t.replaceAll("Voice Isolator", "Voice Isolator Pro"),
    });
    const raised = plan.items.filter(
      (i) => i.kind === "reader" && i.blocks?.provider === "elevenlabs",
    );
    expect(raised.some((i) => i.subject.component === "product 'Voice Isolator Pro'")).toBe(true);
    expect(
      plan.acknowledged.some((a) => a.observation.component === "product 'Voice Isolator'"),
    ).toBe(false);
  });
});

describe("lineage and eligibility", () => {
  it("models.dev and genai-prices share an upstream: with minIndependent 2, their agreement is one cluster", async () => {
    const s = await scenario({
      [URLS.geminiPricing]: (t) =>
        afterAnchor(
          t,
          '{% id="gemini-3.8-flash" %}',
          "$1.50 starting January 1, 2027.",
          "$1.60 starting January 1, 2027.",
        ),
      [URLS.genaiData]: (t) =>
        afterAnchor(
          t,
          '"id":"gemini-3.8-flash"',
          '{"constraint":{"start_date":"2027-01-01"},"prices":{"input_mtok":1.5,',
          '{"constraint":{"start_date":"2027-01-01"},"prices":{"input_mtok":1.6,',
        ),
      [URLS.genaiGoogle]: (t) =>
        afterAnchor(
          t,
          "  - id: gemini-3.8-flash\n",
          "prices_checked: 2026-10-14",
          "prices_checked: 2026-11-05",
        ),
    });
    const id = (p: typeof s.plan) =>
      item(p, (x) =>
        x.startsWith(
          "amount|google-gemini|gemini-3.8-flash|google-gemini:standard|input||2027-01-01T00:00:00Z..",
        ),
      )[0];
    // A future window: genai-prices covers it (same window), models.dev never covers a dated window.
    const one = id(s.plan);
    expect(one?.class).toBe("confirmed");
    expect(one?.crossChecks.map((e) => e.source)).toEqual(["genai-prices"]);
    expect(one?.op?.type).toBe("rate-replace");
    // The other window of the same offering is its own group and stays unchanged.
    expect(
      group(
        s.plan,
        "rate|google-gemini|gemini-3.8-flash|google-gemini:standard|2027-01-01T00:00:00Z..",
      )?.partition,
    ).toBe("confirmed");
    expect(
      group(
        s.plan,
        "rate|google-gemini|gemini-3.8-flash|google-gemini:standard|..2027-01-01T00:00:00Z",
      ),
    ).toBeUndefined();
    expect(id(s.replan({ crossChecks: { minIndependent: 2 } }))?.class).toBe("single-source");
  });

  it("a cross-check revised before the catalog's observation never counts", async () => {
    const { plan } = await scenario({
      [URLS.anthropicPricing]: (t) => once(t, SONNET_ROW_INPUT, "| $2.40 / MTok<sup>3</sup> |"),
      [URLS.modelsDev]: (t) =>
        once(t, MD_SONNET_COST, MD_SONNET_COST.replace('"input":2,', '"input":2.4,')),
    });
    const [input] = item(
      plan,
      (id) => id === `amount|anthropic|claude-sonnet-5|anthropic:standard|input||..`,
    );
    expect(input?.class).toBe("single-source");
    expect(input?.crossChecks.find((e) => e.source === "models-dev")).toMatchObject({
      eligible: false,
      agrees: true,
    });
  });
});

describe("partition", () => {
  it("dependent facts stay together: Batch prices derived from a confirmed base change wait for review", async () => {
    const { plan } = await scenario(consistentSonnetInputChange());
    expect(group(plan, STANDARD)?.partition).toBe("confirmed");
    const batch = group(plan, BATCH);
    expect(batch?.partition).toBe("review");
    expect(
      batch?.items.every((id) => plan.items.find((i) => i.id === id)?.class === "single-source"),
    ).toBe(true);
    expect(plan.now).toBe(NOW);
  });

  it("one unconfirmed change sends its whole offering-window to review", async () => {
    const m = consistentSonnetInputChange();
    const pricing = m[URLS.anthropicPricing] as (t: string) => string;
    const { plan } = await scenario({
      ...m,
      [URLS.anthropicPricing]: (t) =>
        once(pricing(t), SONNET_ROW_OUTPUT, "| $11 / MTok<sup>3</sup> |"),
    });
    const g = group(plan, STANDARD);
    expect(g?.partition).toBe("review");
    const classes = new Set(g?.items.map((id) => plan.items.find((i) => i.id === id)?.class));
    expect([...classes].sort()).toEqual(["confirmed", "conflict"]);
  });
});
