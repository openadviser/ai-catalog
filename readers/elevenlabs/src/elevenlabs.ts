// The ElevenLabs reader.
//
// Sources of truth (docs/sources.md):
//   elevenlabs-pricing   elevenlabs.io/pricing/api — the API product cards (one per
//                        product, a $ price and a unit line) and the per-plan
//                        comparison table, which restates every product's rate in
//                        six plan columns from Free / Pay as you go to Business.
//                        Product names map to model ids (docs/sources.md); the
//                        pay-as-you-go column is the schema tier.
//   elevenlabs-models    elevenlabs.io/docs/overview/models — the current-model
//                        table, the deprecated-model table, and the deprecation
//                        notices with removal dates.
//   elevenlabs-models-api GET /v1/models — the model list; a list never retires
//                        a model.
//
// Included characters, minutes and burst pricing are plan features, not model
// rates; they are read and flagged needs-review where the page prices them, never
// silently dropped.
import { isDeepStrictEqual } from "node:util";
import {
  type ApiPage,
  asArray,
  asObject,
  type Evidence,
  eqDecimal,
  type Instant,
  jsonValueEnd,
  NeedsReview,
  type Provenance,
  provenance,
  ReaderBug,
  type ReaderId,
  type Reading,
  Readings,
  type TrackedScope,
  Unreadable,
} from "@openadviser/ai-catalog-readers-kit";

export const READER: ReaderId = { name: "elevenlabs", version: "0.3.0" };

export const ELEVENLABS_URLS = {
  pricing: "https://elevenlabs.io/pricing/api",
  models: "https://elevenlabs.io/docs/overview/models",
  apiModels: "https://api.elevenlabs.io/v1/models",
} as const;

const PROVIDER = "elevenlabs";
const TIER = "elevenlabs:pay-as-you-go";

export interface ElevenlabsSources {
  pricing?: Evidence;
  models?: Evidence;
}

export interface ElevenlabsResult {
  readings: Reading[];
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

interface Ctx {
  scope: TrackedScope;
  readings: Readings;
  sources: ElevenlabsResult["sources"];
  /** What the models page lists in this reading (see `modelsPageListing`); absent when not read. */
  listing?: ModelsPageListing | undefined;
}

function src(ctx: Ctx, source: string, ev: Evidence): void {
  ctx.sources.push({ source, url: ev.url, evidence: ev.sha256, retrievedAt: ev.retrievedAt });
}

function prov(source: string, ev: Evidence, extra: Parameters<typeof provenance>[3]): Provenance {
  return provenance(source, ev, `${READER.name}@${READER.version}`, extra);
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function innerText(html: string): string {
  return unescapeHtml(html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "")).trim();
}

/**
 * Readable text where every tag is a word boundary. `innerText` concatenates across tags,
 * which is right for a value a cell renders, but wrong for scanning prose: `…prompts</p>
 * <div>v2.5 only` must scan as `prompts v2.5`, not `promptsv2.5`, or a token loses its
 * word boundary and hides.
 */
function blockText(html: string): string {
  return unescapeHtml(html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the page renders, as one text: scripts and styles dropped (serialized state in a
 * `<script>` is not something the page says to a reader), every remaining tag a boundary.
 * The page-wide attribution guard scans this — a card, a grid row, a heading, a footnote;
 * a model id anywhere in it is the page naming a model.
 */
function renderedText(html: string): string {
  return blockText(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
}

const MONTHS: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

/** "January 31, 2027" → "2027-01-31"; anything else is NeedsReview. */
function longDate(text: string, where: string): string {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const mm = m !== null ? MONTHS[m[1] ?? ""] : undefined;
  if (m === null || mm === undefined) {
    throw new NeedsReview(
      "structure",
      `${where}: ${JSON.stringify(text)} is not a 'Month D, YYYY' date`,
    );
  }
  return `${m[3]}-${mm}-${(m[2] ?? "").padStart(2, "0")}`;
}

// ---------- the pricing page ----------

/**
 * The product card names the page uses for each tracked model (docs/sources.md). The pricing
 * page names products, not model ids, so a card prices the one model listed here and no other.
 *
 * A successor model is never added to this map on the strength of a migration suggestion: the
 * models page's "Replacement model suggestion" says what to move to, not what it costs. The card's
 * rate is shown for a successor as a `needs-review` candidate (`successorCandidate`), and a rate
 * is entered only when a page lists the model under the product or states its price.
 */
const CARD_TO_MODEL = new Map<string, string>([
  ["v4", "eleven_v4"],
  ["v3", "eleven_v3"],
  ["v2 Multilingual", "eleven_multilingual_v2"],
  ["Music", "music_v1"],
  ["Sound Effects", "eleven_text_to_sound_v2"],
]);

/**
 * The owner's attribution of a product's rate to a successor model (docs/sources.md, "Owner
 * attributions"). The pricing page prices products and names no model id, so no page states a
 * rate for these models; the owner decided on 2026-11-05 that the product's rate applies to
 * them anyway (decision "A"). An attribution is exactly that: the owner's word, recorded with
 * its date, read fresh from the card on every run — never a rate the page states, and never a
 * frozen copy of one.
 *
 * An entry is an owner decision: it is added, dated and worded by the owner, never by the
 * reader on the strength of a migration suggestion. A successor with no entry here stays a
 * `successorCandidate`, and a successor the models page names a replacement for is not listed
 * here twice — the attribution wins over the candidate.
 *
 * An attribution fails closed: the model must be a current model of the models page in the
 * same reading — and not a deprecated one; a model in both tables is contradictory evidence
 * — and the pricing page must stay model-agnostic. Its rendered text must name the model id
 * nowhere — no card, grid row, heading or note may carry it — and the card itself must show
 * no model id or version tag, no price beside the headline's, no sibling card or section
 * that distinguishes inside the product. Otherwise the reading is `needs-review`, no rate.
 */
interface OwnerAttribution {
  /** The pricing page's product card name. */
  card: string;
  /** The model the owner prices at the card's rate. */
  modelId: string;
  /** When the owner decided, YYYY-MM-DD. */
  decided: string;
  /** The decision's name in the owner's notes. */
  decision: string;
}

const OWNER_ATTRIBUTIONS: OwnerAttribution[] = [
  { card: "Music", modelId: "music_v2_5", decided: "2026-11-05", decision: "A" },
  { card: "Music", modelId: "music_v2", decided: "2026-11-05", decision: "A" },
  {
    card: "Sound Effects",
    modelId: "eleven_text_to_sound_v3",
    decided: "2026-11-05",
    decision: "A",
  },
];

/**
 * A token that looks like an API model id (`music_v2_5`, `eleven_v4`) — a word carrying an
 * underscore — or a version tag the page would use to name a model (`v2`, `v2.5`). The
 * pricing page's product names, attributed card texts and plan-table labels carry none;
 * the page keeps its ids in markup the reader never reaches, so one in the readable text
 * means the page started naming models.
 */
const MODEL_ID_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[vV]\d+(?:\.\d+)*\b/;

/** The card unit lines the schema can price. */
const UNIT_MAP = new Map<string, { component: string; unit: string; per: number }>([
  ["Price per 1K characters", { component: "characters", unit: "character", per: 1000 }],
  ["Price per minute", { component: "output_audio_duration", unit: "minute", per: 1 }],
]);

const PLAN_NAMES = ["Free / Pay as you go", "Starter", "Creator", "Pro", "Scale", "Business"];

interface Card {
  name: string;
  /** Byte offset of `>name</h3>`. */
  nameOffset: number;
  price: string;
  /** Byte offset of `>$X</span>`. */
  priceOffset: number;
  unitLabel: string;
  /** Byte offset of `>label</p>`. */
  unitOffset: number;
  /** The card's own markup, from its `<h3>` to the next heading — where an owner attribution checks for model ids and extra prices. */
  seg: string;
}

/** Page headings that are not product cards — section titles and promo panels. */
const NON_PRODUCT_HEADINGS = new Set([
  "Pay as you go",
  "Startup Grants Program",
  "Enterprise Plan",
]);

function readCards(ev: Evidence, ctx: Ctx, end: number): Card[] {
  const segEnd = end < 0 ? ev.text.length : end;
  const cards: Card[] = [];
  const h3s = [...ev.text.matchAll(/<h3 class="[^"]*tw-type-3xl[^"]*">([^<]+)<\/h3>/g)].filter(
    (m) => (m.index ?? 0) < segEnd,
  );
  for (let i = 0; i < h3s.length; i++) {
    const m = h3s[i];
    if (m === undefined) continue;
    const name = (m[1] ?? "").trim();
    const segStart = (m.index ?? 0) + m[0].length;
    const segStop = i + 1 < h3s.length ? (h3s[i + 1]?.index ?? segEnd) : segEnd;
    const seg = ev.text.slice(segStart, segStop);
    const pm = /<span class="tw-type-2xl">(\$[0-9]+(?:\.[0-9]+)?)<\/span>/.exec(seg);
    const um = /<p class="tw-opacity-80 tw-type-xs">([^<]+)<\/p>/.exec(seg);
    const nameOffset = ev.byteOffset((m.index ?? 0) + m[0].indexOf(">"));
    if (pm === null || um === null) {
      if (NON_PRODUCT_HEADINGS.has(name)) continue;
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `product card '${name}' has no \`$…\` price or unit line this reader can read`,
        },
      ]);
      continue;
    }
    cards.push({
      name,
      nameOffset,
      price: (pm[1] ?? "").slice(1),
      priceOffset: ev.byteOffset(segStart + pm.index + pm[0].indexOf(">")),
      unitLabel: (um[1] ?? "").trim(),
      unitOffset: ev.byteOffset(segStart + um.index + um[0].indexOf(">")),
      seg,
    });
  }
  if (cards.length === 0) {
    throw new NeedsReview("structure", "the pricing page has no product cards");
  }
  return cards;
}

interface MetricGrid {
  /** The product the grid prices: the group label, or the section when unlabeled. */
  product: string;
  /** Metric labels in label-column order. */
  labels: string[];
  /** The six plan columns, each a list of cell texts in label order. */
  cols: string[][];
}

function readMetricGrids(html: string, where: string): MetricGrid[] {
  // The product each grid prices is named by the nearest preceding marker: a
  // group label (`tw-type-2xs`) or a section title (`h3.tw-type-2xl`).
  const markers = [
    ...[...html.matchAll(/<h3 class="tw-type-2xl tw-mb-2">([\s\S]*?)<\/h3>/g)].map((m) => ({
      pos: m.index ?? 0,
      name: blockText(m[1] ?? ""),
    })),
    ...[...html.matchAll(/tw-text-gray-600 tw-font-medium tw-type-2xs">([\s\S]*?)<\/div>/g)].map(
      (m) => ({ pos: m.index ?? 0, name: blockText(m[1] ?? "") }),
    ),
  ].sort((a, b) => a.pos - b.pos);
  const grids: MetricGrid[] = [];
  const gridRe =
    /<div class="tw-grid tw-grid-cols-2 md:tw-grid-cols-\[1\.5fr_repeat\(6,1fr\)\][^"]*">/g;
  const starts = [...html.matchAll(gridRe)].map((m) => m.index ?? 0);
  for (let gi = 0; gi < starts.length; gi++) {
    const g0 = starts[gi] ?? 0;
    const g1 = gi + 1 < starts.length ? (starts[gi + 1] ?? html.length) : html.length;
    const gseg = html.slice(g0, g1);
    // A label parses whatever markup it carries — a `<code>` in one must never make
    // the row invisible to the attribution guard or the unclaimed-row sweep.
    const labels = [
      ...gseg.matchAll(
        /<p class="tw-text-gray-700 tw-line-clamp-3 tw-f-paragraph-03">([\s\S]*?)<\/p>/g,
      ),
    ].map((m) => blockText(m[1] ?? ""));
    if (labels.length === 0) continue;
    let product = "";
    for (const mk of markers) {
      if (mk.pos < g0) product = mk.name;
      else break;
    }
    if (product === "") {
      throw new NeedsReview("structure", `${where}: a priced grid has no product heading`);
    }
    const colSegs = gseg.split(/<div class="tw-align-top tw-px-1[^"]*">/).slice(1);
    if (colSegs.length !== PLAN_NAMES.length) {
      throw new NeedsReview(
        "structure",
        `${where}: a product grid has ${colSegs.length} plan columns, expected ${PLAN_NAMES.length}`,
      );
    }
    const cols = colSegs.map((c) =>
      [...c.matchAll(/<p class="tw-f-paragraph-03">([\s\S]*?)<\/p>/g)].map((v) =>
        innerText(v[1] ?? ""),
      ),
    );
    grids.push({ product, labels, cols });
  }
  return grids;
}

/**
 * A plan cell: the whole text must be `$0.08`, or `$0.08~$0.08/minute` with the
 * hint's price equal to the cell's. Anything else starting with a price — an
 * added charge, a validity window, a different hint unit — is needs-review,
 * never silently read as the flat rate. A non-price like `10,000~10 min` is
 * included allowance, not a price.
 */
function planValue(text: string, where: string): string | null {
  const bare = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(text);
  if (bare !== null) return bare[1] ?? "";
  const hint = /^\$([0-9]+(?:\.[0-9]+)?)~\$([0-9]+(?:\.[0-9]+)?)\/(\S+)$/.exec(text);
  if (hint !== null) {
    if (hint[3] !== "minute") {
      throw new NeedsReview(
        "structure",
        `${where}: cell ${JSON.stringify(text)}'s hint unit is ${JSON.stringify(hint[3])}, expected "minute"`,
      );
    }
    if (!eqDecimal(hint[2] ?? "", hint[1] ?? "")) {
      throw new NeedsReview(
        "structure",
        `${where}: cell ${JSON.stringify(text)}'s per-unit hint does not match its price`,
      );
    }
    return hint[1] ?? "";
  }
  if (/^\$/.test(text)) {
    throw new NeedsReview(
      "structure",
      `${where}: cell ${JSON.stringify(text)} is not a declared price form`,
    );
  }
  return null;
}

/** A deprecated model's replacement, as the models page's "Deprecated models" table states it. */
interface Replacement {
  successor: string;
  evidence: Evidence;
  /** Byte offset and exact bytes of the `<code>successor</code>` cell. */
  offset: number;
  excerpt: string;
}

/** What the models page lists in one reading: the current and deprecated tables, and the
 * replacement each deprecated model has where the successor is itself a current model of the
 * page. A replacement names a candidate, never a price: see `successorCandidate`. */
interface ModelsPageListing {
  /** Ids of the current-model table (`Model ID, Description, Languages`). */
  current: Set<string>;
  /** Ids of the deprecated-model table (`…, Replacement model suggestion`). */
  deprecated: Set<string>;
  /** Deprecated model → its current-model replacement, with the cited cell. */
  replacements: Map<string, Replacement>;
}

/**
 * The models page's lists, read once so the pricing page's owner attributions and successor
 * candidates judge the model on the same bytes `readModelsPage` reports.
 *
 * A page this cannot read yields empty lists — every attribution then falls back to review;
 * `readModelsPage` reports the page itself.
 */
function modelsPageListing(ev: Evidence): ModelsPageListing {
  const out: ModelsPageListing = {
    current: new Set(),
    deprecated: new Set(),
    replacements: new Map(),
  };
  let tables: FernTable[];
  try {
    tables = fernTables(ev);
  } catch (error) {
    if (error instanceof NeedsReview) return out;
    throw error;
  }
  const deprecated: { id: string; successor: string; at: number }[] = [];
  for (const t of tables) {
    if (JSON.stringify(t.headers) === JSON.stringify(["Model ID", "Description", "Languages"])) {
      for (const row of t.rows) {
        const id = codeId(row[0] ?? "");
        if (id !== null) out.current.add(id);
      }
    } else if (
      JSON.stringify(t.headers) ===
      JSON.stringify(["Model ID", "Description", "Languages", "Replacement model suggestion"])
    ) {
      for (const row of t.rows) {
        const id = codeId(row[0] ?? "");
        const successor = codeId(row[3] ?? "");
        if (id !== null) {
          out.deprecated.add(id);
          if (successor !== null) {
            deprecated.push({ id, successor, at: ev.offsetOf(`<code>${id}</code>`, t.offset) });
          }
        }
      }
    }
  }
  for (const d of deprecated) {
    if (!out.current.has(d.successor) || out.replacements.has(d.id)) continue;
    const cell = `<code>${d.successor}</code></td></tr>`;
    const offset = ev.offsetOf(cell, d.at);
    if (offset < 0) continue;
    out.replacements.set(d.id, {
      successor: d.successor,
      evidence: ev,
      offset,
      excerpt: `<code>${d.successor}</code>`,
    });
  }
  return out;
}

/**
 * Why a successor's rate is not entered. The pricing page prices a product; it names no model id
 * and states no rate for `modelId`. The models page calls it the replacement of `baseId`, which is
 * a migration suggestion and not a statement that the two cost the same.
 */
function successorCandidate(
  modelId: string,
  card: string,
  baseId: string,
  via: Replacement,
  candidate: string,
): { code: string; message: string } {
  return {
    code: "unstated-rate",
    message: `no page states a rate for ${modelId}: the '${card}' card prices a product, and the models page only names ${modelId} the replacement of ${baseId} (${JSON.stringify(via.excerpt)} at offset ${via.offset}); the card's rate (candidate: ${candidate}) is shown for a person and is not entered until a page lists ${modelId} under the product or states its price`,
  };
}

function readPricingPage(ev: Evidence, ctx: Ctx): void {
  const tableAt = ev.text.indexOf('id="pricing-table"');
  if (tableAt < 0) throw new NeedsReview("structure", "the pricing page has no plan table");
  const faqAt = ev.text.indexOf('id="pricing-faq"', tableAt);
  const tableEnd = faqAt < 0 ? ev.text.length : faqAt;

  const cards = readCards(ev, ctx, tableAt);
  const planAnchorAt = ev.offsetOf(">Free / Pay as you go</div>", tableAt);

  // The plan header names the six columns; the first is the schema tier.
  const headerSeg = ev.text.slice(tableAt, tableAt + 12000);
  const names = [...headerSeg.matchAll(/tw-text-black tw-type-lg[^"]*">([^<]+)<\/div>/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
  if (JSON.stringify(names.slice(0, PLAN_NAMES.length)) !== JSON.stringify(PLAN_NAMES)) {
    throw new NeedsReview(
      "structure",
      `the plan columns are ${JSON.stringify(names.slice(0, 8))}, expected ${JSON.stringify(PLAN_NAMES)}`,
    );
  }

  const grids = readMetricGrids(ev.text.slice(tableAt, tableEnd), "plan table");
  const byProduct = new Map<string, MetricGrid[]>();
  for (const g of grids) {
    const list = byProduct.get(g.product) ?? [];
    list.push(g);
    byProduct.set(g.product, list);
  }

  const emitted = new Set<string>();
  const claimedRows = new Set<string>();
  /**
   * The page-wide attribution guard (see `OWNER_ATTRIBUTIONS`): the page is model-agnostic
   * for an attributed model only while its rendered text names the id nowhere — no card,
   * grid row, heading or note may carry it. An exact-token match (`music_v2` does not see
   * `music_v2_5`): the id is `[a-z0-9_]`, so `\b` bounds it.
   */
  const pageText = renderedText(ev.text);
  const pageNames = new Map(
    OWNER_ATTRIBUTIONS.map((a) => [a.modelId, new RegExp(`\\b${a.modelId}\\b`).test(pageText)]),
  );
  for (const card of cards) {
    const baseId = CARD_TO_MODEL.get(card.name);
    const unit = UNIT_MAP.get(card.unitLabel);
    const replacement = baseId === undefined ? undefined : ctx.listing?.replacements.get(baseId);
    const attributed = OWNER_ATTRIBUTIONS.filter((a) => a.card === card.name);
    /**
     * The card's model, the successor the models page names for it, and every model the owner
     * attributed the card's rate to. The successor is only a candidate: its reading is always
     * `needs-review` (see `successorCandidate`). An attributed model gets the card's rate, and
     * an attribution wins over the candidate the models page suggests for the same model.
     */
    const targets: { modelId: string; via?: Replacement; attribution?: OwnerAttribution }[] =
      baseId === undefined
        ? []
        : [
            { modelId: baseId },
            ...(replacement !== undefined &&
            !attributed.some((a) => a.modelId === replacement.successor)
              ? [{ modelId: replacement.successor, via: replacement }]
              : []),
            ...attributed.map((a) => ({ modelId: a.modelId, attribution: a })),
          ];
    const loc = (
      modelId: string,
      via?: Replacement,
      attribution?: OwnerAttribution,
      voided?: boolean,
    ) =>
      prov("elevenlabs-pricing", ev, {
        location: ev.cite(
          `API pricing › product card '${card.name}' › price (${card.unitLabel})`,
          card.priceOffset,
          `>$${card.price}</span>`,
          [
            { offset: card.nameOffset, excerpt: `>${card.name}</h3>` },
            { offset: card.unitOffset, excerpt: `>${card.unitLabel}</p>` },
            ...(planAnchorAt >= 0
              ? [{ offset: planAnchorAt, excerpt: ">Free / Pay as you go</div>" }]
              : []),
          ],
        ),
        dateRule: "undated",
        note:
          attribution !== undefined
            ? voided === true
              ? `the '${card.name}' card's rate is attributed to ${modelId} by the owner's decision of ${attribution.decided} (decision ${JSON.stringify(attribution.decision)}, docs/sources.md); the attribution is void this run — the page no longer meets its condition (see reasons)`
              : `the '${card.name}' card prices a product, not a model id: the pricing page names no model id and states no rate for ${modelId} — this is the '${card.name}' product's rate, applied to ${modelId} by the owner's decision of ${attribution.decided} (decision ${JSON.stringify(attribution.decision)}, docs/sources.md); the per-plan table gives the same rate in every plan column — included characters and minutes are not modelled`
            : `product name mapped to ${modelId} (docs/sources.md, ElevenLabs product names); the per-plan table gives the same rate in every plan column — included characters and minutes are not modelled${
                via === undefined
                  ? ""
                  : `. The pricing page names no model id and states no rate for ${modelId}: this is the '${card.name}' product's rate, shown as a candidate because the models page's Deprecated models table names ${modelId} the replacement of ${baseId} (evidence ${via.evidence.sha256}, offset ${via.offset}, ${JSON.stringify(via.excerpt)})`
              }`,
      });
    if (baseId === undefined || unit === undefined) {
      ctx.readings.review(
        { component: `product '${card.name}'` },
        [
          {
            code: "structure",
            message:
              baseId === undefined
                ? `a priced product '${card.name}' (${card.unitLabel}) is not a tracked model`
                : `the '${card.name}' card's unit '${card.unitLabel}' is not a schema component`,
          },
        ],
        undefined,
        loc(baseId ?? "?"),
      );
      continue;
    }
    const tracked = targets.filter((t) => ctx.scope.models.has(t.modelId));
    if (tracked.length === 0) {
      ctx.readings.review({ modelId: baseId }, [
        { code: "structure", message: `card '${card.name}' maps to untracked model ${baseId}` },
      ]);
      continue;
    }
    for (const t of tracked) emitted.add(t.modelId);
    // Every matching per-plan grid must restate the card's rate in all six
    // columns — a second grid under the same product cannot hide a different
    // schedule behind the first.
    const matching = (byProduct.get(card.name) ?? []).filter((g) =>
      g.labels.includes(card.unitLabel),
    );
    const problems: { code: string; message: string }[] = [];
    /**
     * The card-scoped attribution guard (see `OWNER_ATTRIBUTIONS`; the page-wide id check
     * is `pageNames`): the card's rate is read for an attributed model only while the page
     * stays model-agnostic. A model id or version tag in the card's own text or its
     * plan-table rows, any price beside the headline's, a sibling card or section that
     * distinguishes inside the product — each voids every attribution of this card.
     */
    const blocks: { code: string; message: string }[] = [];
    if (attributed.length > 0) {
      // Scanned as rendered blocks: a tag must give a token its word boundary.
      const text = blockText(card.seg);
      const named = MODEL_ID_TOKEN.exec(text)?.[0];
      if (named !== undefined) {
        blocks.push({
          code: "attribution-void",
          message: `the '${card.name}' card's text names ${JSON.stringify(named)} — the page now names a model inside the product, so the owner's attribution no longer reads a plain product rate`,
        });
      }
      /**
       * The headline price is the only `$` the card's readable text may carry. A second
       * amount is a price whatever markup presents it — a model-priced line or a promo —
       * and the attribution cannot tell which rate is the product's.
       */
      const signs = text.match(/\$/g) ?? [];
      if (signs.length > 1) {
        const amounts = text.match(/\$[0-9]+(?:\.[0-9]+)?/g) ?? [];
        blocks.push({
          code: "attribution-void",
          message: `the '${card.name}' card's text carries ${signs.length} prices (${amounts.join(", ")}) — the product's rate no longer stands alone`,
        });
      }
      const productWord = new RegExp(`\\b${card.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      for (const other of cards) {
        if (other.name === card.name) continue;
        if (productWord.test(other.name)) {
          blocks.push({
            code: "attribution-void",
            message: `a second card '${other.name}' names the '${card.name}' product — the page now distinguishes inside it`,
          });
        }
      }
      for (const g of byProduct.get(card.name) ?? []) {
        for (const label of g.labels) {
          const hit = MODEL_ID_TOKEN.exec(label)?.[0];
          if (hit !== undefined) {
            blocks.push({
              code: "attribution-void",
              message: `the plan table's '${card.name}' section has a row '${label}' naming ${JSON.stringify(hit)} — a model of the product is now priced on its own`,
            });
          }
        }
      }
      for (const g of grids) {
        if (g.product !== card.name && productWord.test(g.product)) {
          blocks.push({
            code: "attribution-void",
            message: `the plan table has a '${g.product}' section beside '${card.name}' — the page now distinguishes inside the product`,
          });
        }
      }
    }
    if (matching.length === 0) {
      problems.push({
        code: "structure",
        message: `no '${card.unitLabel}' row under '${card.name}' in the plan table`,
      });
    } else {
      claimedRows.add(`${card.name}|${card.unitLabel}`);
      for (const grid of matching) {
        for (let idx = 0; idx < grid.labels.length; idx++) {
          if (grid.labels[idx] !== card.unitLabel) continue;
          for (let p = 0; p < PLAN_NAMES.length; p++) {
            const cell = grid.cols[p]?.[idx];
            const value =
              cell === undefined
                ? null
                : planValue(cell, `'${card.name}' › '${card.unitLabel}' › ${PLAN_NAMES[p]}`);
            if (value === null || !eqDecimal(value, card.price)) {
              problems.push({
                code: "structure",
                message: `the ${PLAN_NAMES[p]} column prices '${card.name}' at ${cell ?? "(absent)"}, the card says $${card.price}`,
              });
            }
          }
        }
      }
    }
    for (const t of tracked) {
      if (t.via !== undefined) {
        // A successor is never given a rate: the card's rate is only a candidate, and the model
        // is reported for a person, like any tracked model no page prices.
        ctx.readings.review(
          { modelId: t.modelId, component: unit.component },
          [
            successorCandidate(
              t.modelId,
              card.name,
              baseId,
              t.via,
              `$${card.price} ${card.unitLabel.toLowerCase()}`,
            ),
            ...problems,
          ],
          undefined,
          loc(t.modelId, t.via),
        );
        continue;
      }
      if (t.attribution !== undefined) {
        // The owner's attribution reads the card's rate for the model only while the page stays
        // model-agnostic and the models page lists it as current — and not deprecated — in
        // this same reading. A model in both tables is contradictory evidence, not a listing.
        const listed =
          ctx.listing === undefined
            ? "unread"
            : ctx.listing.current.has(t.modelId)
              ? ctx.listing.deprecated.has(t.modelId)
                ? "conflicted"
                : "current"
              : ctx.listing.deprecated.has(t.modelId)
                ? "deprecated"
                : "absent";
        const void_ = [
          ...(listed === "current"
            ? []
            : [
                {
                  code: "attribution-void",
                  message:
                    listed === "unread"
                      ? `the models page was not read this run, so ${t.modelId} cannot be confirmed a current model for the '${card.name}' attribution`
                      : listed === "conflicted"
                        ? `the models page lists ${t.modelId} in both the current and the deprecated tables — contradictory lifecycle evidence voids the '${card.name}' attribution`
                        : listed === "deprecated"
                          ? `the models page lists ${t.modelId} as deprecated — the '${card.name}' attribution covers only a current model`
                          : `the models page no longer lists ${t.modelId} — the '${card.name}' attribution covers only a current model`,
                },
              ]),
          ...blocks,
          ...(pageNames.get(t.modelId) === true
            ? [
                {
                  code: "attribution-void",
                  message: `the pricing page's rendered text names ${t.modelId} — the page is no longer model-agnostic for it, so the '${card.name}' card's product rate cannot be read as its rate`,
                },
              ]
            : []),
        ];
        if (void_.length > 0) {
          ctx.readings.review(
            { modelId: t.modelId, component: unit.component },
            void_,
            undefined,
            loc(t.modelId, undefined, t.attribution, true),
          );
          continue;
        }
        ctx.readings.rate({
          modelId: t.modelId,
          tier: TIER,
          component: unit.component,
          fact: {
            disposition: "priced",
            unit: unit.unit,
            per: unit.per,
            amount: card.price,
            currency: "USD",
          },
          ...(problems.length > 0 ? { outcome: "needs-review" as const, reasons: problems } : {}),
          provenance: loc(t.modelId, undefined, t.attribution),
        });
        continue;
      }
      ctx.readings.rate({
        modelId: t.modelId,
        tier: TIER,
        component: unit.component,
        fact: {
          disposition: "priced",
          unit: unit.unit,
          per: unit.per,
          amount: card.price,
          currency: "USD",
        },
        ...(problems.length > 0 ? { outcome: "needs-review" as const, reasons: problems } : {}),
        provenance: loc(t.modelId),
      });
    }
  }

  // Every priced row the mapping does not claim is surfaced, never dropped.
  for (const grid of grids) {
    for (let i = 0; i < grid.labels.length; i++) {
      const label = grid.labels[i] ?? "";
      const cell = grid.cols[0]?.[i];
      if (cell === undefined) continue;
      if (planValue(cell, `'${grid.product}' › '${label}'`) === null) continue;
      if (claimedRows.has(`${grid.product}|${label}`)) continue;
      ctx.readings.review({ component: `'${grid.product}' › '${label}'` }, [
        {
          code: "structure",
          message: `the plan table prices '${grid.product}' › '${label}' at ${cell} — a priced row outside the tracked product rates`,
        },
      ]);
    }
  }

  for (const id of ctx.scope.models.keys()) {
    if (!emitted.has(id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `no product card maps to tracked model ${id}: the pricing page names products, not model ids, and no page states a rate for ${id} or lists it under a product — its rate is not stated, so it is not guessed`,
        },
      ]);
    }
  }
}

// ---------- the models overview page ----------

interface FernTable {
  headers: string[];
  /** Row cells as raw inner HTML. */
  rows: string[][];
  /** Byte offset of `<table`. */
  offset: number;
}

function fernTables(ev: Evidence): FernTable[] {
  const out: FernTable[] = [];
  for (const m of ev.text.matchAll(/<table class="fern-table">([\s\S]*?)<\/table>/g)) {
    const body = m[1] ?? "";
    const headM = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(body);
    if (headM === null) throw new NeedsReview("structure", "a fern-table has no <thead>");
    const headers = [...(headM[1] ?? "").matchAll(/<th>([\s\S]*?)<\/th>/g)].map((h) =>
      innerText(h[1] ?? ""),
    );
    const tbodyM = /<tbody>([\s\S]*?)<\/tbody>/.exec(body);
    const rows: string[][] = [];
    if (tbodyM !== null) {
      for (const tr of (tbodyM[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        rows.push([...(tr[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? ""));
      }
    }
    out.push({ headers, rows, offset: ev.byteOffset(m.index ?? 0) });
  }
  return out;
}

/** `code` ids in a `<td>` cell — the first cell of a model row names the model. */
function codeId(cell: string): string | null {
  const m = /^<code>([^<]+)<\/code>$/.exec(cell.trim());
  return m !== null ? (m[1] ?? null) : null;
}

function readModelsPage(ev: Evidence, ctx: Ctx): void {
  const tables = fernTables(ev);
  if (tables.length === 0) throw new NeedsReview("structure", "the models page has no tables");

  const available = new Map<string, { offset: number; cell: string }>();
  const deprecated = new Map<string, { offset: number; cell: string; replacement: string }>();
  const otherIds = new Set<string>();

  for (const t of tables) {
    const first = t.headers[0] ?? "";
    if (first === "Model ID") {
      const lifecycle =
        JSON.stringify(t.headers) === JSON.stringify(["Model ID", "Description", "Languages"]);
      const isDeprecated =
        JSON.stringify(t.headers) ===
        JSON.stringify(["Model ID", "Description", "Languages", "Replacement model suggestion"]);
      for (const row of t.rows) {
        const id = codeId(row[0] ?? "");
        if (id === null) {
          ctx.readings.review({}, [
            {
              code: "structure",
              message: `a Model ID row's first cell is not \`<code>id</code>\`: ${JSON.stringify(row[0]?.slice(0, 80))}`,
            },
          ]);
          continue;
        }
        if (lifecycle) {
          const offset = ev.offsetOf(`<code>${id}</code>`, t.offset);
          available.set(id, { offset, cell: `<code>${id}</code>` });
        } else if (isDeprecated) {
          const offset = ev.offsetOf(`<code>${id}</code>`, t.offset);
          deprecated.set(id, {
            offset,
            cell: `<code>${id}</code>`,
            replacement: innerText(row[3] ?? ""),
          });
        } else {
          // Another Model ID table (character limits and friends): the id must
          // be one the lifecycle tables already named.
          otherIds.add(id);
        }
      }
    } else if (first === "Plan") {
    } else {
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `a table headed ${JSON.stringify(t.headers.slice(0, 4))} is not a known models-page table`,
        },
      ]);
    }
  }

  const seen = new Set([...available.keys(), ...deprecated.keys()]);
  for (const id of otherIds) {
    if (!seen.has(id)) {
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `model id '${id}' appears in a capability table but not in the current or deprecated model tables`,
        },
      ]);
    }
  }
  for (const id of available.keys()) {
    if (deprecated.has(id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "structure",
          message: `${id} is in both the current and the deprecated model tables`,
        },
      ]);
    }
  }

  // The deprecation notices: removal dates for the deprecated ids. Two notices
  // for the same model must agree — a conflict is needs-review, never a silent
  // overwrite.
  const retiresOn = new Map<string, { date: string; offset: number; excerpt: string }>();
  const retireConflicts = new Set<string>();
  const noticeRe =
    /<code>([^<]+)<\/code> model is deprecated and will be removed on <strong[^>]*>([^<]+)<\/strong>/g;
  for (const m of ev.text.matchAll(noticeRe)) {
    const id = m[1] ?? "";
    const date = longDate(m[2] ?? "", `deprecation notice for ${id}`);
    const prior = retiresOn.get(id);
    if (prior !== undefined && prior.date !== date) {
      retireConflicts.add(id);
      ctx.readings.review({ modelId: id }, [
        {
          code: "structure",
          message: `two removal notices for ${id} disagree: ${prior.date} vs ${date}`,
        },
      ]);
      continue;
    }
    retiresOn.set(id, {
      date,
      offset: ev.byteOffset(m.index ?? 0),
      excerpt: m[0],
    });
  }

  // The page's other 'deprecated … removed on' sentences must agree with the notices.
  const looseRe = /<code>([^<]+)<\/code>([^<]{0,160}?removed on ([A-Z][a-z]+ [0-9]+, [0-9]{4}))/g;
  for (const m of ev.text.matchAll(looseRe)) {
    if (/<strong/.test(m[0])) continue; // the notice itself
    const id = m[1] ?? "";
    const date = longDate(m[3] ?? "", `deprecation sentence for ${id}`);
    const want = retiresOn.get(id);
    if (want === undefined || want.date !== date) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "structure",
          message: `the page says '${id}' is removed on ${m[3]} but the notice says ${want?.date ?? "nothing"}`,
        },
      ]);
    }
  }

  for (const [id, cell] of available) {
    ctx.readings.model({
      modelId: id,
      status: "available",
      provenance: prov("elevenlabs-models", ev, {
        location: ev.cite(`Models overview › ${id}`, cell.offset, cell.cell, [
          { offset: ev.offsetOf(">Model ID</th>", 0), excerpt: ">Model ID</th>" },
        ]),
      }),
    });
  }
  for (const [id, d] of deprecated) {
    const notice = retiresOn.get(id);
    const reasons: { code: string; message: string }[] = [];
    if (notice === undefined && ctx.scope.models.has(id)) {
      reasons.push({
        code: "structure",
        message: `${id} is deprecated but no removal date notice was found`,
      });
    }
    if (retireConflicts.has(id)) {
      reasons.push({
        code: "structure",
        message: `conflicting removal dates stated for ${id}; the retirement date is not safe`,
      });
    }
    ctx.readings.model({
      modelId: id,
      status: "deprecated",
      ...(notice !== undefined ? { retiresOn: notice.date } : {}),
      ...(d.replacement !== "" ? { notice: `deprecated; replacement: ${d.replacement}` } : {}),
      ...(reasons.length > 0 ? { outcome: "needs-review" as const, reasons } : {}),
      provenance: prov("elevenlabs-models", ev, {
        location: ev.cite(`Deprecated models › ${id}`, d.offset, d.cell, [
          {
            offset: ev.offsetOf(">Replacement model suggestion</th>", 0),
            excerpt: ">Replacement model suggestion</th>",
          },
        ]),
      }),
      ...(notice !== undefined
        ? {
            statusProvenance: prov("elevenlabs-models", ev, {
              location: ev.cite(
                `Deprecated models › notice › ${id}`,
                notice.offset,
                notice.excerpt,
              ),
            }),
          }
        : {}),
    });
  }

  for (const id of ctx.scope.models.keys()) {
    if (!seen.has(id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `${id} is in neither the current nor the deprecated model table`,
        },
      ]);
    }
  }
}

// ---------- GET /v1/models ----------

/** Byte spans of the elements of a top-level JSON array. */
function topLevelArraySpans(text: string): { start: number; end: number }[] {
  let i = 0;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  if (text[i] !== "[") throw new NeedsReview("structure", "the response is not a JSON array");
  i += 1;
  const spans: { start: number; end: number }[] = [];
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
    if (text[i] === "]") return spans;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (i >= text.length) throw new NeedsReview("structure", "unterminated top-level array");
    const end = jsonValueEnd(text, i);
    spans.push({ start: i, end });
    i = end;
  }
}

export function readElevenlabsApi(pages: ApiPage<unknown>[], ctx: Ctx): void {
  for (const { evidence: ev, json } of pages) {
    src(ctx, "elevenlabs-models-api", ev);
    const items = asArray(json, "GET /v1/models");
    const text = ev.text;
    const spans = topLevelArraySpans(text).map((s) => ({
      start: ev.byteOffset(s.start),
      end: ev.byteOffset(s.end),
      charStart: s.start,
      charEnd: s.end,
    }));
    items.forEach((item, i) => {
      const span = spans[i];
      if (
        span !== undefined &&
        !isDeepStrictEqual(JSON.parse(text.slice(span.charStart, span.charEnd)), item)
      ) {
        throw new ReaderBug(`models[${i}]'s cited span does not decode to the item`);
      }
      const model = asObject(item, `models[${i}]`);
      const id = model.model_id;
      if (typeof id !== "string") {
        ctx.readings.review({}, [
          {
            code: "structure",
            message: `models[${i}].model_id is ${JSON.stringify(id)}, expected a string`,
          },
        ]);
        return;
      }
      const location =
        span !== undefined
          ? ev.cite(
              `GET /v1/models › models[${i}]`,
              span.start,
              ev.bytes.subarray(span.start, span.end).toString("utf8"),
            )
          : undefined;
      ctx.readings.model({
        modelId: id,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        status: "available",
        provenance: prov("elevenlabs-models-api", ev, {
          ...(location !== undefined ? { location } : {}),
        }),
      });
      // A cost multiplier is a priced modifier the catalog does not model: it is
      // recorded for the reconciler's cross-check, never read as a price.
      const rates = model.model_rates;
      if (rates !== undefined && rates !== null) {
        const r = asObject(rates, `models[${i}].model_rates`);
        for (const [k, v] of Object.entries(r)) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            ctx.readings.review({ modelId: id }, [
              {
                code: "structure",
                message: `models[${i}].model_rates.${k} is ${JSON.stringify(v)}, expected a number`,
              },
            ]);
            continue;
          }
          ctx.readings.observe({
            outcome: "ok",
            reasons: [],
            modelId: id,
            component: `model_rates.${k}`,
            note: `model_rates.${k} = ${v} — a cost multiplier for the reconciler's cross-check, not a price`,
            provenance: prov("elevenlabs-models-api", ev, {
              ...(location !== undefined ? { location } : {}),
            }),
          });
          if (v !== 1 && ctx.scope.models.has(id)) {
            ctx.readings.review({ modelId: id }, [
              {
                code: "structure",
                message: `models[${i}].model_rates.${k} is ${v} — a priced modifier on a tracked model the flat rate does not cover`,
              },
            ]);
          }
        }
      }
    });
  }
}

// ---------- the read ----------

export function readElevenlabs(
  sources: ElevenlabsSources,
  scope: TrackedScope,
  apiPages: ApiPage<unknown>[] = [],
): ElevenlabsResult {
  const readings = new Readings(PROVIDER);
  const ctx: Ctx = {
    scope,
    readings,
    sources: [],
    listing: sources.models !== undefined ? modelsPageListing(sources.models) : undefined,
  };

  if (sources.pricing !== undefined) {
    src(ctx, "elevenlabs-pricing", sources.pricing);
    try {
      readPricingPage(sources.pricing, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `elevenlabs-pricing: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "elevenlabs-pricing",
        });
      } else {
        throw error;
      }
    }
  }

  if (sources.models !== undefined) {
    src(ctx, "elevenlabs-models", sources.models);
    try {
      readModelsPage(sources.models, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `elevenlabs-models: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "elevenlabs-models",
        });
      } else {
        throw error;
      }
    }
  }

  if (apiPages.length > 0) {
    try {
      readElevenlabsApi(apiPages, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `elevenlabs-models-api: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "elevenlabs-models-api",
        });
      } else {
        throw error;
      }
    }
  }

  return { readings: readings.all, sources: ctx.sources };
}
