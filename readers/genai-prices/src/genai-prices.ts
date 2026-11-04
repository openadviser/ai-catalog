// The genai-prices cross-check (github.com/pydantic/genai-prices), read for the catalog's
// tracked offerings. A cross-check confirms an official reading; it is never the source
// of a value (docs/update-policy.md).
//
// What is read, all pinned to one commit so the revision and the bytes are one snapshot:
// - GitHub's commits list for `prices/new_data/v2/data.json` (the newest commit's sha);
// - `prices/new_data/v2/data.json` at that sha. The v1 `prices/data.json` is frozen and
//   no longer receives price updates (its README), so it is not read;
// - `prices/providers/<provider>.yml` at that sha, for each model's `prices_checked`
//   date: the maintainers' own statement of when they last checked the entry's prices.
//   It is the reading's revision (00:00 UTC of that day). With no date the reading is
//   never eligible to confirm.
//
// How the v2 data maps (docs/sources.md):
// - Model ids are matched exactly on the entry's `id`, never through `match` rules
//   (a `starts_with` rule can reach another model).
// - `prices` is one price object, or a list of `{constraint: {start_date}, prices}` in
//   ascending date order: windows `[∅, D₁)`, `[D₁, D₂)`, … with D at 00:00 UTC, which is
//   how genai-prices applies a start date. Any other constraint covers nothing.
// - Keys: `input_mtok` → `input`, `output_mtok` → `output`, `cache_read_mtok` →
//   `input_cached`, `cache_write_5m_mtok` → `cache_write_5m`, `cache_write_1h_mtok` →
//   `cache_write_1h`, `output_audio_mtok` → `output_audio`, `web_searches_kcount` →
//   `web_search` (per 1000 requests). The generic `cache_write_mtok` → `cache_write_5m`
//   for Anthropic only, when no 5-minute key is present: genai-prices prices a 5-minute
//   write at the generic key then, and five minutes is Anthropic's default lifetime.
//   Modality-specific input, cache or output keys leave the generic component unmapped.
// - Tiered prices `{base, tiers: [{start, price}]}` are whole-request cliffs:
//   genai-prices applies a tier's price to every token once the total input exceeds
//   `start`. They map to the conditions `{lte: S}` and `{gt: S}`. A flat key of the same
//   price object covers every schedule. Keys whose tier starts differ cover nothing.
// - `price_variants` with `when: {processing: "batch"}` are `anthropic:batch`, from each
//   variant's `start_date` (genai-prices' verification date, so a Batch variant never
//   covers an undated fact). Only the keys a variant states are read; inherited keys
//   are not. Every other variant is a tier the schema does not model, and is ignored.
// - Lineage: genai-prices took initial data from, and still pulls updates from, other
//   trackers (README "Thanks"; and models.dev, as the owner states), so it shares
//   models.dev's upstream and counts as one with it (`GENAI_PRICES_LINEAGE`).
import {
  type Anchor,
  type Condition,
  type Evidence,
  type Instant,
  type JsonNode,
  type JsonObject,
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

export const READER: ReaderId = { name: "genai-prices", version: "0.1.0" };
export const SOURCE = "genai-prices";
const REPO = "pydantic/genai-prices";
const DATA_PATH = "prices/new_data/v2/data.json";

export const GENAI_PRICES_URLS = {
  commits: `https://api.github.com/repos/${REPO}/commits?path=${DATA_PATH}&per_page=1`,
} as const;
export const GENAI_PRICES_LINEAGE = [
  "genai-prices",
  "models.dev",
  "litellm",
  "helicone",
  "llm-prices",
  "openrouter",
];

export function genaiPricesDataUrl(sha: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${sha}/${DATA_PATH}`;
}

export function genaiPricesProviderUrl(sha: string, provider: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${sha}/prices/providers/${provider}.yml`;
}

/** The catalog's provider id → the genai-prices provider id. */
export const PROVIDER_IDS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "google-gemini": "google",
  elevenlabs: "elevenlabs",
};

interface KeyMap {
  key: string;
  component: string;
  unit: "token" | "request";
  per: number;
}

const KEYS: KeyMap[] = [
  { key: "input_mtok", component: "input", unit: "token", per: 1000000 },
  { key: "output_mtok", component: "output", unit: "token", per: 1000000 },
  { key: "cache_read_mtok", component: "input_cached", unit: "token", per: 1000000 },
  { key: "cache_write_5m_mtok", component: "cache_write_5m", unit: "token", per: 1000000 },
  { key: "cache_write_1h_mtok", component: "cache_write_1h", unit: "token", per: 1000000 },
  { key: "output_audio_mtok", component: "output_audio", unit: "token", per: 1000000 },
  { key: "web_searches_kcount", component: "web_search", unit: "request", per: 1000 },
];

export interface GenaiPricesInput {
  commits: Evidence;
  data: Evidence;
  /** The provider YAML files at the same commit, by genai-prices provider id. */
  providerFiles: Map<string, Evidence>;
}

export interface GenaiPricesResult {
  readings: Reading[];
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

/** `prices_checked` per model id from a provider YAML, by its `  - id:` blocks. */
export function pricesChecked(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  let current: string | undefined;
  for (const line of yaml.split("\n")) {
    const id = /^ {2}- id: ([^\s#]+)\s*$/.exec(line);
    if (id !== undefined && id !== null) {
      current = id[1] as string;
      seen.set(current, (seen.get(current) ?? 0) + 1);
      continue;
    }
    if (/^\S/.test(line)) current = undefined;
    const checked = /^ {4}prices_checked: ([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/.exec(line);
    if (checked !== null && current !== undefined) out.set(current, checked[1] as string);
  }
  // An id that heads two blocks is ambiguous: its date is not used.
  for (const [modelId, count] of seen) if (count > 1) out.delete(modelId);
  return out;
}

function dateStart(date: string | undefined): Instant | undefined {
  if (date === undefined || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return undefined;
  const instant = `${date}T00:00:00Z`;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    return undefined;
  return instant;
}

interface Window {
  from?: Instant;
  until?: Instant;
  prices: JsonObject;
  /** The constraint's date member, cited as an anchor. */
  dateNode?: JsonNode;
}

/** The windows of a `prices` member: one object, or a list of dated entries. */
function windows(prices: JsonNode): Window[] {
  if (prices.type === "object") return [{ prices }];
  if (prices.type !== "array")
    throw new NeedsReview("structure", "prices is neither an object nor a list");
  const dated: { from?: Instant; prices: JsonObject; dateNode?: JsonNode }[] = [];
  prices.items.forEach((item, i) => {
    const inner = memberValue(item, "prices");
    if (inner?.type !== "object") throw new NeedsReview("structure", "a price entry has no prices");
    const constraint = memberValue(item, "constraint");
    if (constraint === undefined) {
      if (i !== 0) throw new NeedsReview("structure", "an unconstrained price entry is not first");
      dated.push({ prices: inner });
      return;
    }
    const start = memberValue(constraint, "start_date");
    const from = dateStart(start?.type === "string" ? start.value : undefined);
    if (
      constraint.type !== "object" ||
      constraint.members.length !== 1 ||
      from === undefined ||
      start === undefined
    )
      throw new NeedsReview("structure", "a price constraint other than one start_date");
    const previous = dated[dated.length - 1]?.from;
    if (previous !== undefined && previous >= from)
      throw new NeedsReview("structure", "price entries are not in ascending start_date order");
    dated.push({ from, prices: inner, dateNode: start });
  });
  return dated.map((d, i) => {
    const until = dated[i + 1]?.from;
    const w: Window = { prices: d.prices };
    if (d.from !== undefined) w.from = d.from;
    if (until !== undefined) w.until = until;
    if (d.dateNode !== undefined) w.dateNode = d.dateNode;
    return w;
  });
}

interface PricePoint {
  amount: string;
  condition?: Condition;
  /** The cited bytes: the flat member, a tier's base member, or one tier object. */
  start: number;
  end: number;
  note: string;
}

function amountOf(node: JsonNode | undefined, what: string): string {
  if (node?.type !== "number") throw new NeedsReview("structure", `${what} is not a number`);
  const decimal = literalToDecimal(node.literal);
  if (decimal === undefined)
    throw new NeedsReview("structure", `${what} ${node.literal} is not an amount`);
  return decimal;
}

/** The schedule boundaries every tiered key of a price object shares, or throws. */
function boundaries(prices: JsonObject): number[] {
  let shared: number[] | undefined;
  for (const m of prices.members) {
    if (m.value.type !== "object") continue;
    const tiers = memberValue(m.value, "tiers");
    if (tiers?.type !== "array") throw new NeedsReview("structure", `${m.name} has no tiers`);
    const starts = tiers.items.map((t) => {
      const s = memberValue(t, "start");
      if (s?.type !== "number" || !/^(0|[1-9][0-9]*)$/.test(s.literal))
        throw new NeedsReview("structure", `${m.name} has a tier without an integer start`);
      return Number(s.literal);
    });
    for (let i = 1; i < starts.length; i += 1)
      if ((starts[i] as number) <= (starts[i - 1] as number))
        throw new NeedsReview("structure", `${m.name} tiers are not ascending`);
    if (shared === undefined) shared = starts;
    else if (shared.join(",") !== starts.join(","))
      throw new NeedsReview("structure", "the tiered keys do not share their tier starts");
  }
  return shared ?? [];
}

function scheduleOf(bounds: number[], index: number): Condition | undefined {
  if (bounds.length === 0) return undefined;
  const gt = index === 0 ? undefined : bounds[index - 1];
  const lte = bounds[index];
  const inputTokens: { gt?: number; lte?: number } = {};
  if (gt !== undefined) inputTokens.gt = gt;
  if (lte !== undefined) inputTokens.lte = lte;
  return { inputTokens };
}

/** Every price point of one key in one price object, by schedule. */
function points(key: string, value: JsonNode, start: number, bounds: number[]): PricePoint[] {
  if (value.type === "number") {
    const amount = amountOf(value, key);
    if (bounds.length === 0)
      return [{ amount, start, end: value.end, note: "genai-prices, flat price" }];
    return Array.from({ length: bounds.length + 1 }, (_, i) => {
      const point: PricePoint = {
        amount,
        start,
        end: value.end,
        note: "genai-prices, flat price: the same in every input-token schedule of the entry",
      };
      const condition = scheduleOf(bounds, i);
      if (condition !== undefined) point.condition = condition;
      return point;
    });
  }
  if (value.type !== "object") throw new NeedsReview("structure", `${key} is not a price`);
  const base = (value.members.find((m) => m.name === "base") ?? null) as {
    nameStart: number;
    value: JsonNode;
  } | null;
  if (base === null) throw new NeedsReview("structure", `${key} has no base`);
  const tiers = memberValue(value, "tiers");
  if (tiers?.type !== "array") throw new NeedsReview("structure", `${key} has no tiers`);
  const out: PricePoint[] = [];
  const first: PricePoint = {
    amount: amountOf(base.value, `${key}.base`),
    start: base.nameStart,
    end: base.value.end,
    note: `genai-prices tiered price: base, for a request of at most ${bounds[0]} input tokens`,
  };
  const c0 = scheduleOf(bounds, 0);
  if (c0 !== undefined) first.condition = c0;
  out.push(first);
  tiers.items.forEach((tier, i) => {
    const point: PricePoint = {
      amount: amountOf(memberValue(tier, "price"), `${key}.tiers[${i}].price`),
      start: tier.start,
      end: tier.end,
      note: `genai-prices tiered price: the whole request above ${bounds[i]} input tokens (a cliff: genai-prices applies a tier to every token once the total input exceeds its start)`,
    };
    const c = scheduleOf(bounds, i + 1);
    if (c !== undefined) point.condition = c;
    out.push(point);
  });
  return out;
}

export function readGenaiPrices(input: GenaiPricesInput, catalog: unknown): GenaiPricesResult {
  const sink = new Readings(SOURCE);
  const { data } = input;
  const sources = [
    {
      source: "genai-prices-revision",
      url: input.commits.url,
      evidence: input.commits.sha256,
      retrievedAt: input.commits.retrievedAt,
    },
    { source: SOURCE, url: data.url, evidence: data.sha256, retrievedAt: data.retrievedAt },
    ...[...input.providerFiles.values()].map((ev) => ({
      source: "genai-prices-checked",
      url: ev.url,
      evidence: ev.sha256,
      retrievedAt: ev.retrievedAt,
    })),
  ];
  let root: JsonNode;
  try {
    root = parseJsonSpans(data.bytes);
    if (root.type !== "array") throw new NeedsReview("structure", "data.json is not a list");
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
  const tag = readerTag(READER);

  for (const [provider, genaiId] of Object.entries(PROVIDER_IDS)) {
    const scope = trackedScope(catalog, provider);
    const providerNode = root.items.find((p) => stringMember(p, "id") === genaiId);
    const models = memberValue(providerNode, "models");
    const yaml = input.providerFiles.get(genaiId);
    const checked = yaml === undefined ? new Map<string, string>() : pricesChecked(yaml.text);
    for (const [modelId, tracked] of scope.models) {
      if (tracked.offerings.size === 0) continue;
      const matches =
        models?.type === "array"
          ? models.items.filter((m) => stringMember(m, "id") === modelId)
          : [];
      if (matches.length !== 1) {
        sink.observe({
          outcome: "ok",
          reasons: [],
          modelId,
          source: SOURCE,
          note:
            matches.length === 0
              ? `genai-prices has no entry with the exact id ${modelId}; it covers nothing for it`
              : `genai-prices has ${matches.length} entries with the id ${modelId}; it covers nothing for it`,
        });
        continue;
      }
      const entry = matches[0] as JsonNode;
      const revisedAt = dateStart(checked.get(modelId));
      const idMember =
        entry.type === "object" ? entry.members.find((m) => m.name === "id") : undefined;
      const idAnchor: Anchor | undefined =
        idMember === undefined
          ? undefined
          : {
              offset: idMember.nameStart,
              excerpt: data.bytes.toString("utf8", idMember.nameStart, idMember.value.end),
            };
      const emit = (
        tier: string,
        w: Window,
        where: string,
        keyName: string,
        key: KeyMap,
        p: PricePoint,
      ) => {
        const anchors: Anchor[] = [];
        if (idAnchor !== undefined) anchors.push(idAnchor);
        if (w.dateNode !== undefined) {
          anchors.push({
            offset: w.dateNode.start,
            excerpt: data.bytes.toString("utf8", w.dateNode.start, w.dateNode.end),
          });
        }
        const location = data.cite(
          `genai-prices › ${genaiId} › ${modelId} › ${where} › ${keyName}`,
          p.start,
          data.bytes.toString("utf8", p.start, p.end),
          anchors,
        );
        sink.push({
          kind: "rate",
          outcome: "ok",
          reasons: [],
          provider,
          modelId,
          tier,
          component: key.component,
          fact: {
            disposition: "priced",
            unit: key.unit,
            per: key.per,
            amount: p.amount,
            currency: "USD",
          },
          ...(p.condition !== undefined ? { condition: p.condition } : {}),
          ...(w.from !== undefined ? { validFrom: w.from } : {}),
          ...(w.until !== undefined ? { validUntil: w.until } : {}),
          ...(revisedAt !== undefined ? { revisedAt } : {}),
          provenance: provenance(SOURCE, data, tag, {
            location,
            dateRule: w.from !== undefined || w.until !== undefined ? "date-only-utc" : "undated",
            note: p.note,
          }),
        });
      };
      const readPrices = (tier: string, w: Window, where: string) => {
        const bounds = boundaries(w.prices);
        const names = new Set(w.prices.members.map((m) => m.name));
        const modality = (prefix: string) =>
          [...names].some((n) => new RegExp(`^${prefix}_(audio|text|image|video)_`).test(n));
        for (const key of KEYS) {
          if (key.component === "input" && modality("input")) continue;
          if (key.component === "output" && modality("output")) continue;
          if (key.component.startsWith("cache_") || key.component === "input_cached") {
            if (modality("cache")) continue;
          }
          const m = w.prices.members.find((x) => x.name === key.key);
          if (m === undefined) continue;
          for (const p of points(key.key, m.value, m.nameStart, bounds))
            emit(tier, w, where, key.key, key, p);
        }
        if (provider === "anthropic" && !names.has("cache_write_5m_mtok") && !modality("cache")) {
          const m = w.prices.members.find((x) => x.name === "cache_write_mtok");
          if (m !== undefined) {
            const key: KeyMap = {
              key: "cache_write_mtok",
              component: "cache_write_5m",
              unit: "token",
              per: 1000000,
            };
            for (const p of points(key.key, m.value, m.nameStart, bounds))
              emit(tier, w, where, key.key, key, p);
          }
        }
      };
      try {
        const prices = memberValue(entry, "prices");
        if (prices === undefined) throw new NeedsReview("structure", "no prices");
        if (
          tracked.offerings.has(`${provider}:standard`) ||
          tracked.offerings.has(`${provider}:pay-as-you-go`)
        ) {
          const tier = tracked.offerings.has(`${provider}:standard`)
            ? `${provider}:standard`
            : `${provider}:pay-as-you-go`;
          for (const w of windows(prices)) readPrices(tier, w, "prices");
        }
        if (provider === "anthropic" && tracked.offerings.has("anthropic:batch")) {
          for (const w of batchWindows(memberValue(entry, "price_variants"))) {
            readPrices("anthropic:batch", w, "price_variants[processing: batch]");
          }
        }
      } catch (error) {
        if (!(error instanceof NeedsReview)) throw error;
        sink.observe({
          outcome: "ok",
          reasons: [],
          modelId,
          source: SOURCE,
          note: `genai-prices ${modelId}: ${error.message}; it covers nothing for it`,
        });
      }
    }
  }
  return { readings: sink.all, sources };
}

/** The Batch windows of `price_variants`: `when` exactly `{processing: "batch"}`. */
function batchWindows(variants: JsonNode | undefined): Window[] {
  if (variants === undefined) return [];
  if (variants.type !== "array") throw new NeedsReview("structure", "price_variants is not a list");
  const batch: { from?: Instant; prices: JsonObject; dateNode?: JsonNode }[] = [];
  for (const v of variants.items) {
    const when = memberValue(v, "when");
    if (
      when?.type !== "object" ||
      when.members.length !== 1 ||
      stringMember(when, "processing") !== "batch"
    )
      continue;
    const prices = memberValue(v, "prices");
    if (prices?.type !== "object")
      throw new NeedsReview("structure", "a batch variant has no prices");
    const constraint = memberValue(v, "constraint");
    if (constraint === undefined) {
      batch.push({ prices });
      continue;
    }
    const start = memberValue(constraint, "start_date");
    const from = dateStart(start?.type === "string" ? start.value : undefined);
    if (
      constraint.type !== "object" ||
      constraint.members.length !== 1 ||
      from === undefined ||
      start === undefined
    )
      throw new NeedsReview("structure", "a batch variant constraint other than one start_date");
    batch.push({ from, prices, dateNode: start });
  }
  if (batch.filter((b) => b.from === undefined).length > 1)
    throw new NeedsReview("structure", "two undated batch variants");
  batch.sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
  return batch.map((b, i) => {
    const w: Window = { prices: b.prices };
    if (b.from !== undefined) w.from = b.from;
    const until = batch[i + 1]?.from;
    if (until !== undefined) w.until = until;
    if (b.dateNode !== undefined) w.dateNode = b.dateNode;
    return w;
  });
}
