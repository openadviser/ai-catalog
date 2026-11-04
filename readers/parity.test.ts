// Seed parity: run on C1's saved evidence, each reader must reproduce every value in
// the seed catalog (readers/fixtures/seed-catalog.json, the first data/catalog.json) that
// it covers — identity and amount — with no extra and no missing tracked fact. The
// catalog the update job maintains is reconciled against fresh readings instead
// (reconcile/), so these regression tests stay pinned to the seed.
//
//   rates   — every rate in an offering the seed carries, matched on the whole fact
//             identity (provider, modelId, tier, component, condition, window) plus
//             unit, per, currency and amount (decimal-compared);
//   models  — every tracked model's status (and name where stated);
//   effort  — every tracked effort's levels and default.
//
// "No extra" means: on a model the seed prices (one with offerings), the reader emits
// no rate on a seed-tracked tier the seed does not carry, and no rate contradicting a
// seed amount on the same identity.

import { readFileSync } from "node:fs";
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
import { eqDecimal, type RateReading, type Reading } from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import { page, SEED_CATALOG, scope, store } from "./testing.ts";

const catalog = JSON.parse(readFileSync(SEED_CATALOG, "utf8")) as {
  providers: {
    id: string;
    models: {
      id: string;
      name?: string;
      status: string;
      effort?: { levels: string[]; default: string };
      offerings?: {
        tier: string;
        conditionInputs?: { inputTokens: string[] };
        rates: Record<string, unknown>[];
      }[];
    }[];
  }[];
};

interface SeedRate {
  modelId: string;
  tier: string;
  component: string;
  disposition: string;
  unit?: string;
  per?: number;
  amount?: string;
  currency?: string;
  condition?: unknown;
  conditionInputs?: string[];
  validFrom?: string;
  validUntil?: string;
  reason?: string;
}

function seed(provider: string) {
  const p = catalog.providers.find((x) => x.id === provider);
  if (p === undefined) throw new Error(`provider ${provider} not in the catalog`);
  return p;
}

function seedRates(provider: string): SeedRate[] {
  const out: SeedRate[] = [];
  for (const m of seed(provider).models) {
    for (const o of m.offerings ?? []) {
      for (const r of o.rates) {
        // A conditional rate is read with the offering's condition inputs (COND-2).
        const inputs = r.condition !== undefined ? o.conditionInputs?.inputTokens : undefined;
        out.push({
          modelId: m.id,
          tier: o.tier,
          ...(r as object),
          ...(inputs !== undefined ? { conditionInputs: inputs } : {}),
        } as SeedRate);
      }
    }
  }
  return out;
}

const factKey = (x: {
  modelId: string;
  tier: string;
  component: string;
  condition?: unknown;
  validFrom?: string;
  validUntil?: string;
}): string =>
  [
    x.modelId,
    x.tier,
    x.component,
    x.condition === undefined ? "" : JSON.stringify(x.condition),
    x.validFrom ?? "",
    x.validUntil ?? "",
  ].join("|");

const isRate = (r: Reading): r is RateReading => r.kind === "rate";

function checkParity(provider: string, readings: Reading[]): void {
  const rates = readings.filter(isRate);
  const seedFact = seedRates(provider);
  // The condition inputs are the offering's (COND-2): every reading that states them must
  // state the offering's, and a conditional offering must have them stated somewhere.
  const inputProblems: string[] = [];
  for (const s of seedFact) {
    if (s.conditionInputs === undefined) continue;
    const stated = rates.filter(
      (x) => factKey(x) === factKey(s) && x.conditionInputs !== undefined,
    );
    for (const x of stated)
      if (JSON.stringify(x.conditionInputs) !== JSON.stringify(s.conditionInputs))
        inputProblems.push(`condition inputs ${factKey(s)}: ${JSON.stringify(x.conditionInputs)}`);
  }
  for (const m of seed(provider).models)
    for (const o of m.offerings ?? [])
      if (
        o.conditionInputs !== undefined &&
        !rates.some(
          (x) => x.modelId === m.id && x.tier === o.tier && x.conditionInputs !== undefined,
        )
      )
        inputProblems.push(`condition inputs of ${m.id} ${o.tier}: not stated by any reading`);
  expect(inputProblems).toEqual([]);
  const seededModels = new Set(
    seed(provider)
      .models.filter((m) => (m.offerings ?? []).length > 0)
      .map((m) => m.id),
  );
  const seedTiers = new Set(seedFact.map((s) => s.tier));

  // Every seed fact is reproduced: identity, disposition, and amount where priced.
  const problems: string[] = [];
  for (const s of seedFact) {
    const found = rates.filter((x) => factKey(x) === factKey(s));
    if (found.length === 0) {
      problems.push(`missing ${factKey(s)}`);
      continue;
    }
    const x = found[0];
    if (x === undefined) continue;
    if (x.fact.disposition !== s.disposition) {
      problems.push(`disposition ${factKey(s)}: ${x.fact.disposition} ≠ ${s.disposition}`);
    } else if (x.fact.disposition === "priced") {
      if (
        x.fact.unit !== s.unit ||
        x.fact.per !== s.per ||
        x.fact.currency !== s.currency ||
        !eqDecimal(x.fact.amount, s.amount ?? "")
      ) {
        problems.push(
          `amount ${factKey(s)}: ${JSON.stringify(x.fact)} ≠ ${s.amount} ${s.currency} per ${s.per} ${s.unit}`,
        );
      }
    }
  }

  // No extra tracked fact: on a model the seed prices, no rate the seed does not
  // carry on a seed-tracked tier, and nothing contradicting a seed amount.
  for (const x of rates) {
    if (!seededModels.has(x.modelId) || !seedTiers.has(x.tier)) continue;
    const sameIdentity = seedFact.filter((s) => factKey(s) === factKey(x));
    if (sameIdentity.length === 0) {
      problems.push(`extra ${factKey(x)}`);
      continue;
    }
    for (const s of sameIdentity) {
      if (
        x.fact.disposition === "priced" &&
        s.disposition === "priced" &&
        !eqDecimal(x.fact.amount, s.amount ?? "")
      ) {
        problems.push(`contradicts ${factKey(x)}: ${x.fact.amount} ≠ ${s.amount}`);
      }
    }
  }

  // Model and effort facts.
  for (const m of seed(provider).models) {
    const statuses = readings.filter(
      (r): r is Extract<Reading, { kind: "model" }> =>
        r.kind === "model" && r.modelId === m.id && r.status !== undefined,
    );
    if (!statuses.some((r) => r.status === m.status))
      problems.push(`model status ${m.id}: ${m.status} not read`);
    if (m.effort !== undefined) {
      const e = readings.filter(
        (r): r is Extract<Reading, { kind: "effort" }> => r.kind === "effort" && r.modelId === m.id,
      );
      if (
        !e.some(
          (r) =>
            JSON.stringify(r.levels) === JSON.stringify(m.effort?.levels) &&
            r.default === m.effort?.default,
        )
      ) {
        problems.push(
          `effort ${m.id}: ${JSON.stringify(m.effort.levels)}/${m.effort.default} not read`,
        );
      }
    }
  }
  expect(problems).toEqual([]);
}

describe("seed parity", () => {
  it("anthropic reproduces every catalog fact it covers", () => {
    const result = readAnthropic(
      {
        pricing: page(ANTHROPIC_URLS.pricing),
        models: page(ANTHROPIC_URLS.models),
        effort: page(ANTHROPIC_URLS.effort),
        modelPage: (id) => store().latest(modelPageUrl(id.replace(/^claude-/, ""))),
      },
      scope("anthropic"),
    );
    checkParity("anthropic", result.readings);
  });

  it("google-gemini reproduces every catalog fact it covers", () => {
    const result = readGemini(
      { pricing: page(GEMINI_URLS.pricing), thinking: page(GEMINI_URLS.thinking) },
      scope("google-gemini"),
    );
    checkParity("google-gemini", result.readings);
  });

  it("openai reproduces every catalog fact it covers", () => {
    const result = readOpenai(
      {
        pricing: page(OPENAI_URLS.pricing),
        modelPage: (id) => store().latest(openaiModelPageUrl(id)),
      },
      scope("openai"),
    );
    checkParity("openai", result.readings);
  });

  it("elevenlabs reproduces every catalog fact it covers", () => {
    const result = readElevenlabs(
      { pricing: page(ELEVENLABS_URLS.pricing), models: page(ELEVENLABS_URLS.models) },
      scope("elevenlabs"),
    );
    checkParity("elevenlabs", result.readings);
  });
});
