// The models.dev cross-check: https://models.dev/api.json, read for the catalog's tracked
// models. A cross-check confirms an official reading; it is never the source of a value
// (docs/update-policy.md).
//
// What models.dev states, and how it maps (docs/sources.md):
// - `cost` is USD per million tokens, for the provider's standard API pricing. It has no
//   dates and no tiers we model, so every reading is an undated `<provider>:standard` fact
//   with no condition: models.dev never confirms a dated window or a conditional schedule.
// - `input` → `input`, `output` → `output`, `cache_read` → `input_cached`. The generic
//   `cache_write` → `cache_write_5m` for Anthropic only, whose default cache lifetime is
//   five minutes; for other providers it names no lifetime and is unmapped.
// - A model whose `cost` holds `tiers` or any member this reader does not know covers
//   nothing: its base prices would read as unconditional when the source says they are
//   not. `input_audio`/`output_audio` that differ from `input`/`output`, and a separate
//   `reasoning` price, leave `input`/`output` unmapped for the same reason.
// - Each model's `last_updated` (a date) is its revision, read as 00:00 UTC of that day,
//   the earliest instant it can mean. The reconciler counts the reading only when that
//   postdates the catalog's own observation of the value (plan §11.2.3).
// - Model ids are matched exactly: the member name and the entry's `id` must both equal
//   the catalog's model id.
// - Lineage: models.dev's data is its own contributors' (`MODELS_DEV_LINEAGE`).
import {
  type Anchor,
  type Evidence,
  eqDecimal,
  type Instant,
  type JsonMember,
  type JsonNode,
  literalToDecimal,
  memberValue,
  NeedsReview,
  parseJsonSpans,
  provenance,
  type ReaderId,
  type Reading,
  Readings,
  readerTag,
  stringMember,
  trackedScope,
} from "@openadviser/ai-catalog-readers-kit";

export const READER: ReaderId = { name: "models-dev", version: "0.1.0" };
export const SOURCE = "models-dev";
export const MODELS_DEV_URLS = { api: "https://models.dev/api.json" } as const;
export const MODELS_DEV_LINEAGE = ["models.dev"];

/** The catalog's provider id → the models.dev provider key. */
export const PROVIDER_KEYS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "google-gemini": "google",
};

const KNOWN_COST = new Set([
  "input",
  "output",
  "cache_read",
  "cache_write",
  "input_audio",
  "output_audio",
  "reasoning",
]);

export interface ModelsDevResult {
  readings: Reading[];
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

/** A date `YYYY-MM-DD` as its 00:00 UTC instant, or undefined when it is not a real date. */
export function dateStart(date: string | undefined): Instant | undefined {
  if (date === undefined || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return undefined;
  const instant = `${date}T00:00:00Z`;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    return undefined;
  return instant;
}

export function readModelsDev(ev: Evidence, catalog: unknown): ModelsDevResult {
  // The report's provider is the source id; each reading names the catalog provider.
  const sink = new Readings(SOURCE);
  const sources = [
    { source: SOURCE, url: ev.url, evidence: ev.sha256, retrievedAt: ev.retrievedAt },
  ];
  let root: JsonNode;
  try {
    root = parseJsonSpans(ev.bytes);
  } catch (error) {
    sink.observe({
      outcome: "unreadable",
      reasons: [
        { code: "wrong-document", message: error instanceof Error ? error.message : String(error) },
      ],
      source: SOURCE,
    });
    return { readings: sink.all, sources };
  }
  if (root.type !== "object") {
    sink.observe({
      outcome: "unreadable",
      reasons: [{ code: "wrong-document", message: "api.json is not a JSON object" }],
      source: SOURCE,
    });
    return { readings: sink.all, sources };
  }

  for (const [provider, key] of Object.entries(PROVIDER_KEYS)) {
    const scope = trackedScope(catalog, provider);
    const providerNode = memberValue(root, key);
    const models = memberValue(providerNode, "models");
    for (const [modelId, tracked] of scope.models) {
      const tier = `${provider}:standard`;
      if (!tracked.offerings.has(tier)) continue;
      const entry = memberValue(models, modelId);
      if (entry?.type !== "object" || stringMember(entry, "id") !== modelId) {
        sink.observe({
          outcome: "ok",
          reasons: [],
          modelId,
          tier,
          source: SOURCE,
          note: `models.dev has no entry with the exact id ${modelId}; it covers nothing for it`,
        });
        continue;
      }
      try {
        readEntry(ev, sink, provider, key, modelId, entry);
      } catch (error) {
        if (!(error instanceof NeedsReview)) throw error;
        sink.observe({
          outcome: "ok",
          reasons: [],
          modelId,
          tier,
          source: SOURCE,
          note: `models.dev ${modelId}: ${error.message}; it covers nothing for it`,
        });
      }
    }
  }
  return { readings: sink.all, sources };
}

function readEntry(
  ev: Evidence,
  sink: Readings,
  provider: string,
  key: string,
  modelId: string,
  entry: JsonNode,
): void {
  const cost = memberValue(entry, "cost");
  if (cost?.type !== "object") throw new NeedsReview("structure", "no cost object");
  for (const m of cost.members) {
    if (!KNOWN_COST.has(m.name))
      throw new NeedsReview("structure", `cost member "${m.name}" is not one this reader maps`);
  }
  const literal = (name: string): string | undefined => {
    const value = memberValue(cost, name);
    if (value === undefined) return undefined;
    if (value.type !== "number") throw new NeedsReview("structure", `cost.${name} is not a number`);
    const decimal = literalToDecimal(value.literal);
    if (decimal === undefined)
      throw new NeedsReview("structure", `cost.${name} ${value.literal} is not an amount`);
    return decimal;
  };
  const differs = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && !eqDecimal(a, b);

  const mapped: [string, string][] = [];
  if (!differs(literal("input_audio"), literal("input"))) mapped.push(["input", "input"]);
  if (literal("reasoning") === undefined && !differs(literal("output_audio"), literal("output")))
    mapped.push(["output", "output"]);
  mapped.push(["cache_read", "input_cached"]);
  if (provider === "anthropic") mapped.push(["cache_write", "cache_write_5m"]);

  const revisedAt = dateStart(stringMember(entry, "last_updated"));
  const idMember = (entry.type === "object" ? entry.members : []).find(
    (m: JsonMember) => m.name === "id",
  );
  const anchors: Anchor[] = [];
  if (idMember !== undefined) {
    anchors.push({
      offset: idMember.nameStart,
      excerpt: ev.bytes.toString("utf8", idMember.nameStart, idMember.value.end),
    });
  }
  const tag = readerTag(READER);
  for (const [field, component] of mapped) {
    const m = cost.type === "object" ? cost.members.find((x) => x.name === field) : undefined;
    if (m === undefined) continue;
    const amount = literal(field);
    if (amount === undefined) continue;
    const excerpt = ev.bytes.toString("utf8", m.nameStart, m.value.end);
    const location = ev.cite(
      `models.dev › ${key} › models › ${modelId} › cost › ${field}`,
      m.nameStart,
      excerpt,
      anchors,
    );
    sink.push({
      kind: "rate",
      outcome: "ok",
      reasons: [],
      provider,
      modelId,
      tier: `${provider}:standard`,
      component,
      fact: { disposition: "priced", unit: "token", per: 1000000, amount, currency: "USD" },
      ...(revisedAt !== undefined ? { revisedAt } : {}),
      provenance: provenance(SOURCE, ev, tag, {
        location,
        dateRule: "undated",
        note: "models.dev cost, USD per million tokens, undated and unconditional",
      }),
    });
  }
}
