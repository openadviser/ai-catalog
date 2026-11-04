// The reconciler's parts: the factor, structural changes, TIME-6 apply and the tree it
// writes, the release restamp, the excerpt check, the JSON parser and cross-check readers,
// the shape of the workflows, and the local dry run of update.yml on saved evidence.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pricesChecked, readGenaiPrices } from "@openadviser/ai-catalog-reader-genai-prices";
import { readModelsDev } from "@openadviser/ai-catalog-reader-models-dev";
import {
  Evidence,
  literalToDecimal,
  NeedsReview,
  parseJsonSpans,
  type RateReading,
} from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";
import { checkData, hashLine } from "../../scripts/check-data.ts";
import { loadSchemas } from "../../scripts/schemas.ts";
import { validateCatalog } from "../../scripts/validate-catalog.ts";
import { buildPartition, nextVersion, serialize } from "../src/apply.ts";
import { build, dryRun } from "../src/cli.ts";
import { checkDerivation, containsAmount, excerptReasons } from "../src/excerpt.ts";
import { compareVersions as compareGithubVersions } from "../src/github.ts";
import { type Catalog, changeRatio } from "../src/model.ts";
import { lineageClusters } from "../src/plan.ts";
import { compareVersions, nextFreeVersion, planRelease } from "../src/release.ts";
import { loadRun, planRun, ROOT } from "../src/run.ts";
import { supersedeEvidence, writeTree } from "../src/tree.ts";
import {
  consistentSonnetInputChange,
  geminiFutureInputChange,
  NOW,
  type Scenario,
  scenario,
  seed,
  seedRoot,
} from "./helpers.ts";

const validate = loadSchemas(ROOT);

/** Replaces one official reading's value with a synthetic one cited from synthetic bytes. */
function synth(s: Scenario, match: (r: RateReading) => boolean, fact: RateReading["fact"]): void {
  const reading = s.run.reports
    .flatMap((r) => r.readings)
    .find((r): r is RateReading => r.kind === "rate" && match(r));
  if (reading === undefined) throw new Error("no such reading");
  const excerpt =
    fact.disposition === "priced"
      ? `the price is ${fact.amount} per ${fact.per}`
      : `not priced: ${fact.reason}`;
  const body = Buffer.from(excerpt, "utf8");
  const sha = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(s.run.runDir, "evidence", sha), body);
  reading.fact = fact;
  const { derivation: _d, ...rest } = reading.provenance;
  reading.provenance = {
    ...rest,
    evidence: sha,
    location: { path: "synthetic", offset: 0, excerpt },
  };
}

const sonnetOutput = (r: RateReading) =>
  r.modelId === "claude-sonnet-5" && r.tier === "anthropic:standard" && r.component === "output";
const usd = (amount: string, per = 1000000, unit = "token") =>
  ({ disposition: "priced", unit, per, amount, currency: "USD" }) as const;
const itemOf = (s: Scenario, prefix: string) =>
  s.replan().items.find((i) => i.id.startsWith(prefix));

describe("the factor", () => {
  it("is max(new/old, old/new), exact, with equality within", () => {
    expect(changeRatio("2", "3", "1.5")).toMatchObject({ fraction: "3/2", within: true });
    expect(changeRatio("3", "2", "1.5")).toMatchObject({ fraction: "3/2", within: true });
    expect(changeRatio("2", "3.000000000001", "1.5").within).toBe(false);
    expect(changeRatio("0.10", "0.1", "1.5")).toMatchObject({ fraction: "1/1", within: true });
    expect(() => changeRatio("0", "1", "1.5")).toThrow();
  });

  it("a decrease past the factor is needs-review; a decrease within it is single-source", async () => {
    const s = await scenario();
    synth(s, sonnetOutput, usd("5"));
    const half = itemOf(s, "amount|anthropic|claude-sonnet-5|anthropic:standard|output|");
    expect(half?.class).toBe("needs-review");
    expect(half?.reasons.map((r) => r.code)).toEqual(["beyond-factor"]);
    synth(s, sonnetOutput, usd("7"));
    expect(itemOf(s, "amount|anthropic|claude-sonnet-5|anthropic:standard|output|")?.class).toBe(
      "single-source",
    );
  });

  it("a change to zero is structural, never within any factor", async () => {
    const s = await scenario();
    synth(s, sonnetOutput, usd("0"));
    const zero = itemOf(s, "structural|anthropic|claude-sonnet-5|anthropic:standard|output|");
    expect(zero?.class).toBe("needs-review");
    expect(zero?.reasons.map((r) => r.code)).toEqual(["zero"]);
    expect(zero?.ratio).toBeUndefined();
  });

  it("a change of unit, per or disposition is structural, even when the price per token is the same", async () => {
    const s = await scenario();
    synth(s, sonnetOutput, usd("0.01", 1000));
    expect(
      itemOf(s, "structural|anthropic|claude-sonnet-5|anthropic:standard|output|")?.reasons[0]
        ?.code,
    ).toBe("structural");
    synth(s, sonnetOutput, { disposition: "unsupported", reason: "now billed differently" });
    expect(
      itemOf(s, "structural|anthropic|claude-sonnet-5|anthropic:standard|output|")?.reasons[0]
        ?.code,
    ).toBe("disposition");
  });

  it("a new fact in a tracked offering is structural, and a window or condition change shows as one beside a fact not read", async () => {
    const s = await scenario();
    synth(s, sonnetOutput, usd("10"));
    const reading = s.run.reports
      .flatMap((r) => r.readings)
      .find((r): r is RateReading => r.kind === "rate" && sonnetOutput(r));
    if (reading === undefined) throw new Error("no reading");
    reading.validFrom = "2027-01-01T00:00:00Z";
    const plan = s.replan();
    expect(
      plan.items.find(
        (i) =>
          i.id ===
          "new-fact|anthropic|claude-sonnet-5|anthropic:standard|output||2027-01-01T00:00:00Z..",
      )?.class,
    ).toBe("needs-review");
    expect(
      plan.items.find(
        (i) => i.id === "tracked-not-read|anthropic|claude-sonnet-5|anthropic:standard|output||..",
      ),
    ).toBeDefined();
  });
});

describe("lineage", () => {
  it("sources that share an upstream are one cluster", () => {
    expect(lineageClusters([["models.dev"], ["genai-prices", "models.dev", "litellm"]])).toBe(1);
    expect(lineageClusters([["models.dev"], ["genai-prices", "litellm"]])).toBe(2);
    expect(lineageClusters([["a"], ["b", "c"], ["c", "d"], ["e"]])).toBe(3);
  });
});

describe("apply, TIME-6 and the tree", () => {
  it("an undated confirmed change closes the old entry at the stamp and starts the new one there; the tree checks out", async () => {
    const s = await scenario(consistentSonnetInputChange());
    const built = buildPartition(s.catalog, s.plan, "confirmed", NOW, validate);
    expect(built.applied).toEqual(["rate|anthropic|claude-sonnet-5|anthropic:standard|.."]);
    expect(built.version).toBe("2026.11.05.1");
    const rates = built.catalog.providers[0]?.models[0]?.offerings[0]?.rates ?? [];
    const input = rates.filter((r) => r.component === "input");
    expect(input.map((r) => [r.amount, r.validFrom, r.validUntil, r.provenance.dateRule])).toEqual([
      ["2", undefined, NOW, "undated"],
      ["2.40", NOW, undefined, "undated"],
    ]);
    expect(validateCatalog(built.bytes, validate)).toBeUndefined();
    const root = seedRoot();
    const { copied } = writeTree(root, s.catalog, built, s.run.evidenceDirs);
    expect(copied.length).toBeGreaterThan(0);
    expect(checkData(root, validate)).toEqual([]);
  });

  it("the review partition applies the groups that wait, group by group, and lists one it cannot apply", async () => {
    const s = await scenario(consistentSonnetInputChange());
    const reading = s.run.reports
      .flatMap((r) => r.readings)
      .find(
        (r): r is RateReading =>
          r.kind === "rate" &&
          r.modelId === "claude-sonnet-5" &&
          r.tier === "anthropic:standard" &&
          r.component === "web_search",
      );
    if (reading === undefined) throw new Error("no reading");
    // A condition on one entry of an unconditional offering: conditions-mixed if applied.
    const plan = s.replan();
    const extra = { ...reading, condition: { inputTokens: { gt: 200000 } } };
    s.run.reports[0]?.readings.push(extra);
    const withExtra = s.replan();
    const built = buildPartition(s.catalog, withExtra, "review", NOW, validate);
    expect(built.applied).toContain("rate|anthropic|claude-sonnet-5|anthropic:batch|..");
    expect(built.skipped.map((x) => x.group)).toContain(
      "rate|anthropic|claude-sonnet-5|anthropic:standard|..",
    );
    expect(plan.groups.find((g) => g.id.endsWith("anthropic:standard|.."))?.partition).toBe(
      "confirmed",
    );
  });

  it("evidence is never deleted: a body no value cites any more is listed as superseded, and check-data accepts it", async () => {
    const root = seedRoot();
    const { catalog } = seed();
    // Replace Gemini 3.8 Flash's effort list outright: its seed evidence is then cited by
    // nothing but the thinking page's other rows… here, by nothing at all.
    const changed = structuredClone(catalog);
    const gemini = changed.providers
      .find((p) => p.id === "google-gemini")
      ?.models.find((m) => m.id === "gemini-3.8-flash");
    if (gemini?.effort === undefined) throw new Error("no effort");
    const old = gemini.effort.provenance.evidence;
    gemini.effort.provenance = {
      ...(changed.providers[0]?.models[0]?.offerings[0]?.rates[0]
        ?.provenance as typeof gemini.effort.provenance),
    };
    const bytes = serialize(changed);
    writeFileSync(join(root, "data", "catalog.json"), bytes);
    writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(bytes));
    expect(checkData(root, validate).some((p) => p.includes(old))).toBe(true);
    expect(supersedeEvidence(root, changed, NOW)).toEqual([old]);
    expect(existsSync(join(root, "evidence", old))).toBe(true);
    expect(checkData(root, validate)).toEqual([]);
    // Cited again, it leaves the list.
    expect(supersedeEvidence(root, catalog, NOW)).toEqual([]);
    const doc = JSON.parse(readFileSync(join(root, "evidence", "superseded.json"), "utf8"));
    expect(doc.superseded).toEqual([]);
  });

  it("a future window is replaced while it is still future, and not once it has begun", async () => {
    const s = await scenario(geminiFutureInputChange());
    const g = "rate|google-gemini|gemini-3.8-flash|google-gemini:standard|2027-01-01T00:00:00Z..";
    expect(buildPartition(s.catalog, s.plan, "confirmed", NOW, validate).applied).toEqual([g]);
    const late = buildPartition(s.catalog, s.plan, "confirmed", "2027-01-01T00:00:01Z", validate);
    expect(late.applied).toEqual([]);
    expect(late.skipped[0]?.error).toContain("has begun");
  });

  it("the provisional publishedAt never precedes the readings, whatever the building runner's clock", async () => {
    const s = await scenario(consistentSonnetInputChange());
    const root = seedRoot();
    planRun(loadRun(s.run.runDir, root), join(root, "data", "catalog.json"), NOW, root);
    const ctx = {
      repo: "openadviser/ai-catalog",
      runUrl: "(test)",
      ref: "main",
      baseRef: "main",
      dryRun: true,
    };
    const { summary } = build(s.run.runDir, "confirmed", root, "2026-11-04T23:00:00Z", {
      commit: false,
      ctx,
    });
    expect(summary.stamp).toBe(NOW);
    expect(checkData(root, validate)).toEqual([]);
  });

  it("the provisional version follows main's", () => {
    expect(nextVersion("2026.11.04.1", "2026-11-04T22:00:00Z")).toBe("2026.11.04.2");
    expect(nextVersion("2026.11.04.9", "2026-11-05T00:00:01Z")).toBe("2026.11.05.1");
  });
});

describe("the release restamp", () => {
  const { bytes: seedBytes } = seed();

  it("the seed's first release: today's .1, publishedAt now, nothing else rewritten", () => {
    const r = planRelease(seedBytes, [], () => undefined, "2026-11-05T08:00:00Z");
    expect(r).toMatchObject({
      action: "publish",
      version: "2026.11.05.1",
      publishedAt: "2026-11-05T08:00:00Z",
      rewritten: 0,
    });
    const c = JSON.parse(r.bytes.toString("utf8")) as Catalog;
    expect(c.version).toBe("2026.11.05.1");
    expect(validateCatalog(r.bytes, validate)).toBeUndefined();
    expect(hashLine(r.bytes)).toMatch(/^[0-9a-f]{64} {2}catalog\.json\n$/);
  });

  it("a later release restamps the pending bounds to publishedAt, takes the next number of the day, and passes TIME-6", async () => {
    const released = planRelease(seedBytes, [], () => undefined, "2026-11-05T08:00:00Z");
    const s = await scenario(consistentSonnetInputChange(), {
      catalog: JSON.parse(released.bytes.toString("utf8")) as Catalog,
    });
    const built = buildPartition(s.catalog, s.plan, "confirmed", NOW, validate);
    const r = planRelease(
      built.bytes,
      ["data-v2026.11.05.1"],
      (v) => (v === "2026.11.05.1" ? released.bytes : undefined),
      "2026-11-05T11:00:00Z",
    );
    // Four components changed: each old entry is closed and each new one opened at the stamp.
    expect(r).toMatchObject({
      action: "publish",
      version: "2026.11.05.2",
      rewritten: 8,
      previous: "2026.11.05.1",
    });
    const input = (
      JSON.parse(r.bytes.toString("utf8")) as Catalog
    ).providers[0]?.models[0]?.offerings[0]?.rates.filter((x) => x.component === "input");
    expect(input?.map((x) => [x.validFrom, x.validUntil])).toEqual([
      [undefined, "2026-11-05T11:00:00Z"],
      ["2026-11-05T11:00:00Z", undefined],
    ]);
  });

  it("main already tagged with its exact bytes is a resume; with other bytes it is a new version", () => {
    const released = planRelease(seedBytes, [], () => undefined, "2026-11-05T08:00:00Z");
    const tags = ["data-v2026.11.05.1"];
    const at = (v: string) => (v === "2026.11.05.1" ? released.bytes : undefined);
    expect(planRelease(released.bytes, tags, at, "2026-11-05T09:00:00Z").action).toBe("resume");
    const changed = Buffer.from(
      released.bytes
        .toString("utf8")
        .replace('"name": "Claude Sonnet 5"', '"name": "Claude Sonnet Five"'),
    );
    expect(planRelease(changed, tags, at, "2026-11-05T09:00:00Z")).toMatchObject({
      action: "publish",
      version: "2026.11.05.2",
    });
  });

  it("an undated change that does not start at publishedAt fails TIME-6", () => {
    const c = JSON.parse(seedBytes.toString("utf8")) as Catalog;
    const rate = c.providers[0]?.models[0]?.offerings[0]?.rates[0];
    if (rate === undefined) throw new Error("no rate");
    rate.validFrom = "2026-11-01T00:00:00Z";
    expect(() => planRelease(serialize(c), [], () => undefined, "2026-11-05T08:00:00Z")).toThrow(
      /TIME-6/,
    );
  });

  it("refuses to go back in time, and compares versions as integers", () => {
    const released = planRelease(seedBytes, [], () => undefined, "2026-11-05T08:00:00Z");
    expect(() =>
      planRelease(seedBytes, ["data-v2026.11.05.1"], () => released.bytes, "2026-11-05T07:00:00Z"),
    ).toThrow(/not after/);
    expect(compareVersions("2026.11.04.10", "2026.11.04.9")).toBeGreaterThan(0);
    expect(
      nextFreeVersion(
        ["data-v2026.11.05.1", "data-v2026.11.05.10", "data-v2026.11.04.3"],
        "2026-11-05T12:00:00Z",
      ),
    ).toBe("2026.11.05.11");
    expect(compareGithubVersions("2026.11.04.10", "2026.11.04.9")).toBeGreaterThan(0);
    expect(compareGithubVersions("2026.11.05.1", "2026.11.05.1")).toBe(0);
  });

  const released = () => {
    const r = planRelease(seedBytes, [], () => undefined, "2026-11-05T08:00:00Z");
    return {
      tags: ["data-v2026.11.05.1"],
      at: (v: string) => (v === "2026.11.05.1" ? r.bytes : undefined),
      bytes: r.bytes,
    };
  };

  it("a released undated price edited in place, without a split, fails: it would reprice published instants", () => {
    const l = released();
    const c = JSON.parse(l.bytes.toString("utf8")) as Catalog;
    const rate = c.providers[0]?.models[0]?.offerings[0]?.rates[0];
    if (rate === undefined) throw new Error("no rate");
    rate.amount = "2.2";
    c.publishedAt = "2026-11-05T09:00:00Z";
    expect(() => planRelease(serialize(c), l.tags, l.at, "2026-11-05T10:00:00Z")).toThrow(
      /would change for instants already published/,
    );
  });

  it("a replaced future window fails once it has begun by the release, and passes while it is still future", () => {
    const l = released();
    const c = JSON.parse(l.bytes.toString("utf8")) as Catalog;
    const gemini = c.providers.find((p) => p.id === "google-gemini")?.models[0]?.offerings[0];
    const future = gemini?.rates.find(
      (r) => r.component === "input" && r.validFrom === "2027-01-01T00:00:00Z",
    );
    if (future === undefined) throw new Error("no future window");
    future.amount = "1.60";
    c.publishedAt = "2026-11-05T09:00:00Z";
    expect(planRelease(serialize(c), l.tags, l.at, "2026-11-05T10:00:00Z").action).toBe("publish");
    expect(() => planRelease(serialize(c), l.tags, l.at, "2027-01-01T01:00:00Z")).toThrow(
      /would change for instants already published/,
    );
  });

  it("a bound the provider stated is never restamped, even when it equals the pending stamp", () => {
    const l = released();
    const c = JSON.parse(l.bytes.toString("utf8")) as Catalog;
    const pending = "2026-11-06T00:00:00Z";
    c.publishedAt = pending;
    const offering = c.providers[0]?.models[0]?.offerings[0];
    const web = offering?.rates.find((r) => r.component === "web_search");
    if (offering === undefined || web === undefined) throw new Error("no rate");
    // A provider-stated change at midnight: the old entry ends, the new one starts there.
    web.validUntil = pending;
    offering.rates.push({
      ...structuredClone(web),
      amount: "12",
      validFrom: pending,
      validUntil: undefined,
      provenance: { ...web.provenance, dateRule: "stated-instant" },
    } as never);
    const r = planRelease(serialize(c), l.tags, l.at, pending);
    const after = (
      JSON.parse(r.bytes.toString("utf8")) as Catalog
    ).providers[0]?.models[0]?.offerings[0]?.rates.filter((x) => x.component === "web_search");
    // Both bounds are the provider's: the successor is stated, so neither moves.
    expect(after?.map((x) => [x.validFrom, x.validUntil])).toEqual([
      [undefined, pending],
      [pending, undefined],
    ]);
    expect(r.rewritten).toBe(0);
    expect(validateCatalog(r.bytes, validate)).toBeUndefined();
    // Published an hour after the stated start, the change would reprice an hour already
    // published at the old price: refused, never silently moved.
    expect(() => planRelease(serialize(c), l.tags, l.at, "2026-11-06T01:00:00Z")).toThrow(
      /would change for instants already published/,
    );
  });
});

describe("the excerpt check", () => {
  it("finds an amount as a number token, not as part of another", () => {
    expect(containsAmount("| $2.50 / MTok |", "2.5")).toBe(true);
    expect(containsAmount("| $12.50 / MTok |", "2.5")).toBe(false);
    expect(containsAmount("$1,000 per day", "1000")).toBe(true);
  });

  it("a derivation must multiply out to the amount, with every operand cited", () => {
    const base = {
      kind: "rate",
      outcome: "ok",
      reasons: [],
      provider: "anthropic",
      modelId: "m",
      tier: "anthropic:batch",
      component: "input_cached",
      fact: usd("0.1"),
      provenance: {
        source: "s",
        url: "https://x.test/",
        readAt: NOW,
        reader: "r@0.1.0",
        evidence: "0".repeat(64),
        derivation: {
          formula: "0.1 × $2 (base) × 0.5 (Batch) = $0.1 per MTok",
          inputs: [
            {
              evidence: "0".repeat(64),
              url: "https://x.test/",
              path: "p",
              offset: 0,
              excerpt: "| $2 / MTok |",
            },
            {
              evidence: "0".repeat(64),
              url: "https://x.test/",
              path: "p",
              offset: 0,
              excerpt: "Cache hits: 0.1x base input",
            },
            {
              evidence: "0".repeat(64),
              url: "https://x.test/",
              path: "p",
              offset: 0,
              excerpt: "a 50 percent discount",
            },
          ],
        },
      },
    } as unknown as RateReading;
    expect(checkDerivation(base)).toEqual([]);
    const wrong = { ...base, fact: usd("0.2") } as RateReading;
    expect(checkDerivation(wrong)[0]).toContain("not the amount");
    const uncited = structuredClone(base);
    (uncited.provenance.derivation as { inputs: { excerpt: string }[] }).inputs[2] = {
      ...(uncited.provenance.derivation as { inputs: { excerpt: string }[] }).inputs[2],
      excerpt: "a discount",
    } as never;
    expect(checkDerivation(uncited)[0]).toContain("0.5");
  });

  it("a reading whose excerpt lacks its value is needs-review, and blocks its group", async () => {
    const s = await scenario();
    synth(s, sonnetOutput, usd("10"));
    const reading = s.run.reports
      .flatMap((r) => r.readings)
      .find((r): r is RateReading => r.kind === "rate" && sonnetOutput(r));
    if (reading?.kind !== "rate" || reading.fact.disposition !== "priced")
      throw new Error("no reading");
    reading.fact = usd("11");
    expect(excerptReasons(reading, s.run.lookup)[0]?.message).toContain(
      "does not contain the amount 11",
    );
    const plan = s.replan();
    expect(
      plan.items.find(
        (i) => i.id === "excerpt|anthropic|claude-sonnet-5|anthropic:standard|output||..",
      )?.class,
    ).toBe("needs-review");
  });
});

describe("the JSON span parser", () => {
  it("keeps byte offsets across multibyte text and number literals exactly", () => {
    const bytes = Buffer.from('{"name":"Gémini ›","cost":{"input":0.075}}', "utf8");
    const root = parseJsonSpans(bytes);
    if (root.type !== "object") throw new Error("not an object");
    const cost = root.members[1];
    expect(bytes.toString("utf8", cost?.nameStart, cost?.value.end)).toBe('"cost":{"input":0.075}');
    expect(literalToDecimal("0.075")).toBe("0.075");
    expect(literalToDecimal("1.5e-1")).toBe("0.15");
    expect(literalToDecimal("12e2")).toBe("1200");
    expect(literalToDecimal("-1")).toBeUndefined();
  });

  it("refuses a duplicate member", () => {
    expect(() => parseJsonSpans(Buffer.from('{"a":1,"a":2}'))).toThrow(NeedsReview);
  });
});

describe("the cross-check readers", () => {
  const fixture = (dir: string, url: string) => {
    const base = join(ROOT, "readers", dir, "fixtures", "evidence");
    const recordName = readdirSync(base).find(
      (n) =>
        n.endsWith(".json") &&
        (JSON.parse(readFileSync(join(base, n), "utf8")) as { requestedUrl: string })
          .requestedUrl === url,
    ) as string;
    const record = JSON.parse(readFileSync(join(base, recordName), "utf8")) as {
      sha256: string;
      retrievedAt: string;
    };
    return new Evidence({
      bytes: readFileSync(join(base, record.sha256)),
      url,
      retrievedAt: record.retrievedAt,
    });
  };

  it("models.dev: undated standard prices for exact ids, its revision, and nothing for a tiered model", () => {
    const r = readModelsDev(fixture("models-dev", "https://models.dev/api.json"), seed().catalog);
    const sonnet = r.readings.filter(
      (x): x is RateReading => x.kind === "rate" && x.modelId === "claude-sonnet-5",
    );
    expect(
      sonnet
        .map((x) => `${x.component}=${x.fact.disposition === "priced" ? x.fact.amount : ""}`)
        .sort(),
    ).toEqual(["cache_write_5m=2.5", "input=2", "input_cached=0.2", "output=10"]);
    expect(
      sonnet.every(
        (x) =>
          x.revisedAt === "2026-06-30T00:00:00Z" &&
          x.validFrom === undefined &&
          x.condition === undefined,
      ),
    ).toBe(true);
    expect(r.readings.some((x) => x.kind === "rate" && x.modelId === "gpt-6.1-sol")).toBe(false);
  });

  it("genai-prices: cliff tiers as conditions, start dates as windows, Batch from its verification date", () => {
    const sha = "46103ff230160ed751d68b5c2b19334b6c8f5132";
    const raw = `https://raw.githubusercontent.com/pydantic/genai-prices/${sha}`;
    const r = readGenaiPrices(
      {
        commits: fixture(
          "genai-prices",
          "https://api.github.com/repos/pydantic/genai-prices/commits?path=prices/new_data/v2/data.json&per_page=1",
        ),
        data: fixture("genai-prices", `${raw}/prices/new_data/v2/data.json`),
        providerFiles: new Map(
          ["anthropic", "openai", "google"].map((p) => [
            p,
            fixture("genai-prices", `${raw}/prices/providers/${p}.yml`),
          ]),
        ),
      },
      seed().catalog,
    );
    const rates = r.readings.filter((x): x is RateReading => x.kind === "rate");
    const sol = rates.filter((x) => x.modelId === "gpt-6.1-sol" && x.component === "input");
    expect(
      sol.map((x) => [
        JSON.stringify(x.condition),
        x.fact.disposition === "priced" ? x.fact.amount : "",
      ]),
    ).toEqual([
      ['{"inputTokens":{"lte":272000}}', "2"],
      ['{"inputTokens":{"gt":272000}}', "4"],
    ]);
    const flash = rates.filter((x) => x.modelId === "gemini-3.8-flash" && x.component === "input");
    expect(flash.map((x) => [x.validFrom, x.validUntil])).toEqual([
      [undefined, "2027-01-01T00:00:00Z"],
      ["2027-01-01T00:00:00Z", undefined],
    ]);
    const batch = rates.filter((x) => x.tier === "anthropic:batch");
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((x) => x.validFrom === "2026-10-14T00:00:00Z")).toBe(true);
    expect(rates.find((x) => x.modelId === "claude-sonnet-5")?.revisedAt).toBe(
      "2026-10-19T00:00:00Z",
    );
  });

  it("prices_checked is read per model block, and an id that heads two blocks has no date", () => {
    const yaml =
      "models:\n  - id: a\n    prices_checked: 2026-01-02\n  - id: b\n    name: B\n    prices_checked: 2026-03-04\n  - id: a\n";
    const m = pricesChecked(yaml);
    expect(m.get("b")).toBe("2026-03-04");
    expect(m.has("a")).toBe(false);
  });
});

describe("the workflows", () => {
  // Without comment lines, so a comment can never satisfy or break an assertion.
  const strip = (text: string) =>
    text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  const update = strip(readFileSync(join(ROOT, ".github/workflows/update.yml"), "utf8"));
  const release = strip(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));

  it("pin every action by sha, grant nothing by default, and time out every job", () => {
    for (const text of [update, release]) {
      expect(text).toMatch(/^permissions: \{\}$/m);
      for (const m of text.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
        const ref = m[1] as string;
        if (ref.startsWith("./")) continue;
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
      const jobs = [...text.slice(text.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z-]+):$/gm)].map(
        (m) => m[1],
      );
      const timeouts = text.match(/timeout-minutes:/g)?.length ?? 0;
      // The update workflow's release job calls a reusable workflow, which sets its own.
      expect(timeouts).toBe(jobs.filter((j) => j !== "release" || text === release).length);
    }
  });

  it("give contents: write only to the jobs that push, and the keys only to the read step", () => {
    const writers = [
      ...update.matchAll(/^ {2}([a-z-]+):$([\s\S]*?)(?=^ {2}[a-z-]+:$|(?![\s\S]))/gm),
    ]
      .filter((m) => /contents: write/.test(m[2] as string))
      .map((m) => m[1]);
    expect(writers).toEqual(["confirmed", "release", "review"]);
    expect(update.match(/secrets\./g)?.length).toBe(4);
    expect(update).toMatch(
      /concurrency:\n {2}group: catalog-update\n {2}cancel-in-progress: false/,
    );
    expect(update).toMatch(/schedule:/);
    expect(update).toMatch(/dry_run:/);
    const releaseWriters = [
      ...release.matchAll(/^ {2}([a-z-]+):$([\s\S]*?)(?=^ {2}[a-z-]+:$|(?![\s\S]))/gm),
    ]
      .filter((m) => /contents: write/.test(m[2] as string))
      .map((m) => m[1]);
    expect(releaseWriters).toEqual(["publish"]);
  });

  it("run the reconciler's commands in the order the local dry run does", () => {
    const steps = [
      ...update.matchAll(
        /(node reconcile\/src\/(?:cli|github)\.ts [a-z-]+(?: [^\n]*)?|npm run check|\.\/\.github\/workflows\/release\.yml)/g,
      ),
    ].map((m) => (m[1] as string).replace(/"\$RUNNER_TEMP\/run"/g, "RUN"));
    expect(steps).toEqual([
      "node reconcile/src/cli.ts read --live --run RUN",
      "node reconcile/src/cli.ts baseline",
      "node reconcile/src/cli.ts plan --run RUN",
      "node reconcile/src/cli.ts build --run RUN --partition confirmed --commit",
      "npm run check",
      "node reconcile/src/cli.ts seal --run RUN --partition confirmed",
      "node reconcile/src/github.ts propose --run RUN --partition confirmed",
      "./.github/workflows/release.yml",
      "node reconcile/src/cli.ts baseline",
      "node reconcile/src/cli.ts plan --run RUN",
      "node reconcile/src/cli.ts build --run RUN --partition review --commit",
      "npm run check",
      "node reconcile/src/cli.ts seal --run RUN --partition review",
      "node reconcile/src/cli.ts issues --run RUN",
      "node reconcile/src/github.ts propose --run RUN --partition review",
      "node reconcile/src/github.ts issues --run RUN",
    ]);
  });

  it("the jobs that hold a write token run only code with no dependency", () => {
    const source = readFileSync(join(ROOT, "reconcile/src/github.ts"), "utf8");
    const imports = [...source.matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i?.startsWith("node:"))).toBe(true);
    expect(source).not.toMatch(/import\(/);
  });
});

describe("a dry run of update.yml, locally, on saved evidence", () => {
  it("the seed's saved evidence proposes nothing and files no findings", async () => {
    const out = mkdtempSync(join(tmpdir(), "ai-catalog-dry-"));
    const { plan, reviewPlan } = await dryRun({
      out,
      root: seedRoot(),
      now: "2026-11-04T22:00:00Z",
    });
    expect(plan.items).toEqual([]);
    expect(reviewPlan.items).toEqual([]);
    for (const f of ["confirmed-body.md", "review-body.md", "findings-issue.md", "summary.txt"])
      expect(existsSync(join(out, f))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "run", "issues.json"), "utf8")).findings.open).toBe(
      false,
    );
  });

  it("a changed page: the confirmed tree and the review tree are built, checked, and described", async () => {
    const s = await scenario(consistentSonnetInputChange());
    const out = mkdtempSync(join(tmpdir(), "ai-catalog-dry-"));
    const { plan, reviewPlan } = await dryRun({
      out,
      root: seedRoot(),
      runDir: s.run.runDir,
      now: NOW,
    });
    expect(plan.groups.map((g) => `${g.partition} ${g.id}`)).toEqual([
      "review rate|anthropic|claude-sonnet-5|anthropic:batch|..",
      "confirmed rate|anthropic|claude-sonnet-5|anthropic:standard|..",
    ]);
    // After the confirmed merge and its release, only the review group is left.
    expect(reviewPlan.groups.map((g) => g.id)).toEqual([
      "rate|anthropic|claude-sonnet-5|anthropic:batch|..",
    ]);
    const confirmed = JSON.parse(
      readFileSync(join(s.run.runDir, "confirmed", "summary.json"), "utf8"),
    );
    const review = JSON.parse(readFileSync(join(s.run.runDir, "review", "summary.json"), "utf8"));
    expect(confirmed).toMatchObject({ hasChanges: true, check: { passed: true } });
    expect(review).toMatchObject({ hasChanges: true, check: { passed: true } });
    const body = readFileSync(join(out, "confirmed-body.md"), "utf8");
    expect(body).toContain("✅ confirmed");
    expect(body).toContain("models-dev");
    expect(readFileSync(join(out, "review-body.md"), "utf8")).toContain("🟡 single-source");
  });
});
