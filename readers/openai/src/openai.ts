// The OpenAI reader.
//
// Sources of truth (docs/sources.md):
//   openai-pricing     developers.openai.com/api/docs/pricing — the Flagship models
//                      section: a context-length selector (Short ≤272K / Long >272K
//                      input tokens), four speed panes (Standard, Batch, Fast,
//                      Ultrafast) rendered as astro-island props plus an SSR table,
//                      a footnote, and the Tools table (row-span grouped). Only
//                      Standard is a schema 1.0.0 tier.
//   openai-model-page  developers.openai.com/api/docs/models/<id> — the effort
//                      sentence, the Pricing summary cards and notes (cache
//                      multipliers, the long-context surcharge, tier multipliers,
//                      the regional premium), the Snapshots list.
//   openai-models-api  GET /v1/models — the model list; a list never retires a model.
//
// The Standard table's prices apply to prompts of at most 272K input tokens; each
// model page states the >272K surcharge as 2x input and cache rates, 1.5x output,
// for the full request. Whether "cache rates" covers cache writes is not stated,
// so cache writes above 272K are `unsupported`. "272K" is read as 272,000.
import { isDeepStrictEqual } from "node:util";
import {
  type Anchor,
  type ApiPage,
  asArray,
  asObject,
  type EffortLevel,
  type Evidence,
  eqDecimal,
  type Instant,
  jsonArraySpans,
  mulDecimal,
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

export const READER: ReaderId = { name: "openai", version: "0.3.0" };

export const OPENAI_URLS = {
  pricing: "https://developers.openai.com/api/docs/pricing",
  apiModels: "https://api.openai.com/v1/models",
} as const;

/** The model-page URL for a tracked model. */
export function modelPageUrl(id: string): string {
  return `https://developers.openai.com/api/docs/models/${id}`;
}

/** The model-page URL for every tracked model — what a live read fetches and stores. */
export function openaiModelPageUrls(scope: TrackedScope): { id: string; url: string }[] {
  return [...scope.models.keys()].map((id) => ({ id, url: modelPageUrl(id) }));
}

const PROVIDER = "openai";
const TIER_STANDARD = "openai:standard";
const TIER_NOT_IN_SCHEMA = "tier not in schema 1.0.0";
const PER_TOKEN = 1_000_000;

/**
 * The input the long-context condition is judged on. The page prices a request by its
 * prompt's input tokens (the Short/Long context selector, and the model page's "Prompts with
 * more than 272K input tokens"), and OpenAI reports those as `usage.input_tokens`: uncached
 * input, cache reads and cache writes together (specification §15). Every conditional
 * reading states it, so the reconciler sees the condition's definition, not only its bound.
 */
const CONDITION_INPUTS = ["input", "input_cached", "cache_write_30m", "cache_write_12h"];

export interface OpenaiSources {
  /** Absent only when a live fetch failed — each source is read independently. */
  pricing?: Evidence;
  /** Per-model pages, for effort, pricing notes and the long-context surcharge. */
  modelPage?: (modelId: string) => Evidence | undefined;
}

export interface OpenaiResult {
  readings: Reading[];
  /** The source keys read, with their evidence, in consumption order. */
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

interface Ctx {
  scope: TrackedScope;
  readings: Readings;
  sources: OpenaiResult["sources"];
}

function src(ctx: Ctx, source: string, ev: Evidence): void {
  ctx.sources.push({ source, url: ev.url, evidence: ev.sha256, retrievedAt: ev.retrievedAt });
}

function prov(source: string, ev: Evidence, extra: Parameters<typeof provenance>[3]): Provenance {
  return provenance(source, ev, `${READER.name}@${READER.version}`, extra);
}

// ---------- small HTML helpers ----------

/** Entity-unescaped text: serialized props and labels use &quot; &amp; &lt; &gt; &#39;. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The inner text of an HTML fragment (tags removed, entities unescaped). */
function innerText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, "")).trim();
}

/**
 * A model page's text without the `<span …>` wrappers the catalogue renderer puts around
 * text (`<span data-catalogue-label="">Pricing</span>`), with each kept character's index in
 * the original. Pages before 2026-11-23 have none, and read the same through it. A citation
 * always quotes the original bytes, wrappers included.
 */
interface Plain {
  text: string;
  /** `at[i]` is the original index of `text[i]`; `at[text.length]` is the original's length. */
  at: number[];
}

function plain(raw: string): Plain {
  let text = "";
  const at: number[] = [];
  let from = 0;
  const copy = (to: number) => {
    for (let i = from; i < to; i++) {
      text += raw[i];
      at.push(i);
    }
  };
  for (const m of raw.matchAll(/<span\b[^>]*>|<\/span>/g)) {
    copy(m.index ?? 0);
    from = (m.index ?? 0) + m[0].length;
  }
  copy(raw.length);
  at.push(raw.length);
  return { text, at };
}

/** The original bytes of the plain range `[a, b)`, with the byte offset they start at. */
function quote(ev: Evidence, pl: Plain, a: number, b: number): { offset: number; excerpt: string } {
  const start = pl.at[a] ?? 0;
  const end = (pl.at[b - 1] ?? start) + 1;
  return { offset: ev.byteOffset(start), excerpt: ev.text.slice(start, end) };
}

/** The plain index of a section label's closing `</div>` marker, `>Pricing</div>` and so on. */
function labelAt(pl: Plain, label: string, from = 0): number {
  return pl.text.indexOf(`>${label}</div>`, from);
}

// ---------- astro serialized props ----------

/** Astro serializes props as tagged values: [0, v] leaf, [1, [items]] array. */
function deval(x: unknown): unknown {
  if (Array.isArray(x)) {
    if (x.length === 2 && typeof x[0] === "number") {
      if (x[0] === 0) return deval(x[1]);
      if (x[0] === 1 && Array.isArray(x[1])) return x[1].map(deval);
      return x[1];
    }
    return x.map(deval);
  }
  if (typeof x === "object" && x !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = deval(v);
    return out;
  }
  return x;
}

/** The `props="..."` attribute of an astro-island, decoded and deserialized. */
function islandProps(fragment: string, where: string): Record<string, unknown> {
  const m = /props="([^"]*)"/.exec(fragment);
  if (m === null) throw new NeedsReview("structure", `${where}: astro-island has no props`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unescapeHtml(m[1] ?? ""));
  } catch {
    throw new NeedsReview("structure", `${where}: astro-island props are not JSON`);
  }
  const value = deval(parsed);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NeedsReview("structure", `${where}: props do not decode to an object`);
  }
  return value as Record<string, unknown>;
}

// ---------- the model pages ----------

const LEVEL_VOCAB = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EXPECTED_LABELS = new Set([
  "Pricing",
  "Modalities",
  "Endpoints",
  "Features",
  "Tools",
  "Snapshots",
  "Model IDs",
  "Cloud providers",
  "Rate limits",
]);

interface NoteCheck {
  /** The sentence text (for derivation excerpts). */
  sentence: string;
  /** Byte offset of the sentence's inner text in the evidence. */
  offset: number;
  /** Byte length of the inner text. */
  length: number;
  kind: "cached" | "cache-write" | "explicit-writes" | "write-12h" | "tier-mult" | "long-context";
  /** percent / multiplier / first explicit price, depending on kind. */
  a: string;
  /** second explicit price (explicit-writes) or pane name (tier-mult). */
  b?: string | undefined;
  /** For tier-mult: the two-pane split when the note covers Batch and Flex. */
  panes?: string[];
}

export interface ModelPageFacts {
  ev: Evidence;
  /** The display name from the title block. */
  name?: string;
  /** The long-context surcharge the page states, if any. */
  longContext?: { thresholdK: number; inputMult: string; outputMult: string; note: NoteCheck };
  /** Two stated long-context multipliers disagree — derived rates are needs-review. */
  longContextConflict?: boolean;
  /** The pricing claims that must agree with the pricing table. */
  checks: NoteCheck[];
  /** The pricing summary cards: label → $ amount. */
  summary: Map<string, string>;
}

/** The `>Pricing</div>` notes column: one `<p>` per statement, each classified. */
function pricingNotes(
  ev: Evidence,
  pl: Plain,
  modelId: string,
  ctx: Ctx,
  name: string,
): NoteCheck[] {
  const labelIdx = labelAt(pl, "Pricing");
  if (labelIdx < 0) {
    ctx.readings.review({ modelId }, [
      { code: "structure", message: "the model page has no Pricing notes section" },
    ]);
    return [];
  }
  // The framing sentence: "Pricing is based on the number of tokens used…", and from
  // 2026-11-23 on some pages "Prices are per 1M tokens. See the pricing page for…".
  const intro =
    /Pricing is based on the number of tokens used/.test(
      pl.text.slice(labelIdx, labelIdx + 3000),
    ) ||
    /Prices are per 1M tokens\. See the pricing page for processing tiers and billing details\./.test(
      innerText(pl.text.slice(labelIdx, labelIdx + 3000)),
    );
  if (!intro) {
    ctx.readings.review({ modelId }, [
      {
        code: "structure",
        message: "the Pricing section's framing sentence is missing or changed",
      },
    ]);
  }
  const notesStart = pl.text.indexOf("text-2xl font-semibold", labelIdx);
  const end = pl.text.indexOf("h-px w-full bg-primary-soft", labelIdx);
  const regionStart = notesStart < 0 ? labelIdx : notesStart;
  const region = pl.text.slice(regionStart, end < 0 ? pl.text.length : end);
  const checks: NoteCheck[] = [];
  for (const m of region.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const rawInner = m[1] ?? "";
    const innerAt = regionStart + (m.index ?? 0) + m[0].indexOf(">") + 1;
    const { offset, excerpt } =
      rawInner === ""
        ? { offset: ev.byteOffset(pl.at[innerAt] ?? 0), excerpt: "" }
        : quote(ev, pl, innerAt, innerAt + rawInner.length);
    const length = Buffer.byteLength(excerpt, "utf8");
    const sentence = innerText(rawInner);
    const cite = (what: string) =>
      prov("openai-model-page", ev, {
        location: ev.cite(`${name} › Pricing › ${what}`, offset, excerpt),
      });
    const unrecognized = () =>
      ctx.readings.review(
        { modelId },
        [
          {
            code: "structure",
            message: `a Pricing note this reader does not understand: ${JSON.stringify(sentence.slice(0, 140))}`,
          },
        ],
        undefined,
        cite("unrecognized note"),
      );
    const cachedM =
      /^Cached input tokens are priced at ([0-9]+)% of the uncached input token rate\.$/.exec(
        sentence,
      );
    const writeM = /^Cache writes are billed at ([0-9.]+)x the uncached input token rate\.$/.exec(
      sentence,
    );
    const longM =
      /^(?:API prompts|Prompts) with more than ([0-9]+)K input tokens are priced at ([0-9.]+)x input and cache rates and ([0-9.]+)x output for the full request\.$/.exec(
        sentence,
      );
    // The 2026-11 wording: "input and cache rates double", "output costs 1.5 times".
    const longM2 =
      /^For requests with more than ([0-9]+)K input tokens, input and cache rates double and output costs ([0-9.]+) times the short-context rate for the full request\.$/.exec(
        sentence,
      );
    const write12M =
      /^The cache write price is for 30 minutes of retention\. A 12-hour cache write costs \$([0-9.]+) per million tokens for short-context requests at Standard pricing\.$/.exec(
        sentence,
      );
    const writesM =
      /^Cache-write prices shown use 30-minute retention\. Standard cache writes cost \$([0-9.]+) per million tokens for 30-minute retention and \$([0-9.]+) for 12-hour retention, before long-context adjustments\.$/.exec(
        sentence,
      );
    if (cachedM !== null) {
      checks.push({
        sentence,
        offset,
        length,
        kind: "cached",
        a: cachedM[1] ?? "",
      });
    } else if (writeM !== null) {
      checks.push({
        sentence,
        offset,
        length,
        kind: "cache-write",
        a: writeM[1] ?? "",
      });
    } else if (longM !== null) {
      checks.push({
        sentence,
        offset,
        length,
        kind: "long-context",
        a: `${longM[1]}|${longM[2]}|${longM[3]}`,
      });
    } else if (longM2 !== null) {
      checks.push({
        sentence,
        offset,
        length,
        kind: "long-context",
        a: `${longM2[1]}|2|${longM2[2]}`,
      });
    } else if (write12M !== null) {
      checks.push({ sentence, offset, length, kind: "write-12h", a: write12M[1] ?? "" });
    } else if (/^(?:Batch|Fast mode|Ultrafast) costs /.test(sentence)) {
      // The 2026-11 wording of the speed tiers, one or more clauses per <p>. None is a
      // schema tier: each is an observation, and any other clause is unrecognized.
      const known: [RegExp, (m: RegExpExecArray) => { a: string; panes: string[] }][] = [
        [
          /^Batch costs ([0-9]+)% of Standard rates\.$/,
          (m) => ({ a: String(Number(m[1]) / 100), panes: ["batch"] }),
        ],
        [
          /^Fast mode costs twice the Standard rate for the same context length\.$/,
          () => ({ a: "2", panes: ["fast"] }),
        ],
        [
          /^Ultrafast costs 3 times the Standard rate through February 28, 2027, and 6 times the Standard rate starting March 1, 2027 \(Pacific time\)\.$/,
          () => ({ a: "3, then 6", panes: ["ultrafast"] }),
        ],
      ];
      const clauses = sentence.split(/(?<=\.) (?=[A-Z])/);
      const found = clauses.map((c) => {
        for (const [re, f] of known) {
          const m = re.exec(c);
          if (m !== null) return f(m);
        }
        return undefined;
      });
      if (found.some((f) => f === undefined)) unrecognized();
      else
        for (const f of found)
          if (f !== undefined) checks.push({ sentence, offset, length, kind: "tier-mult", ...f });
    } else if (writesM !== null) {
      checks.push({
        sentence,
        offset,
        length,
        kind: "explicit-writes",
        a: writesM[1] ?? "",
        b: writesM[2],
      });
    } else if (/^(?:Batch and Flex|Fast mode|Ultrafast mode)/.test(sentence)) {
      // Speed-tier clauses, one or more per <p>: "Fast mode prices are 2x
      // Standard", "Fast mode is priced at 2x the applicable rates", "Batch and
      // Flex prices are 50% lower than Standard", "Batch and Flex are priced at
      // 50% of Standard rates", "Ultrafast mode prices are 6x Standard".
      const clause =
        /(Fast mode|Batch and Flex|Ultrafast mode)(?: prices)? (?:are|is)(?: priced at)? ([0-9.]+)(x|%)(?: (lower than|of))?(?: the applicable| Standard)(?: rates)?\./g;
      const checks0 = checks.length;
      for (const t of sentence.matchAll(clause)) {
        const pct = t[3] === "%";
        const lower = t[4] === "lower than";
        const mult = pct ? String((lower ? 100 - Number(t[2]) : Number(t[2])) / 100) : (t[2] ?? "");
        const head = t[1] ?? "";
        const panes =
          head === "Batch and Flex"
            ? ["batch", "flex"]
            : head === "Ultrafast mode"
              ? ["ultrafast"]
              : ["fast"];
        checks.push({
          sentence,
          offset,
          length,
          kind: "tier-mult",
          a: mult,
          panes,
        });
      }
      const rest = sentence.replace(clause, "").replace(/^[\s.]+|[\s.]+$/g, "");
      if (rest !== "" || checks.length === checks0) unrecognized();
    } else if (/^Regional processing adds a 10% premium where available\./.test(sentence)) {
      const rest = sentence.replace(
        /^Regional processing adds a 10% premium where available\.\s*/,
        "",
      );
      if (
        rest !== "" &&
        rest !== "EU data residency is available with Standard, Fast, Flex, and Batch processing."
      ) {
        unrecognized();
      } else {
        ctx.readings.observe({
          outcome: "ok",
          reasons: [],
          modelId,
          component: "regional",
          note: "Regional processing adds a 10% premium (and EU data residency where stated); not modelled — spec §15 openai:standard is a global endpoint.",
          provenance: cite("regional processing"),
        });
      }
    } else if (
      /^GPT-6\.1 Sol uses a default context window of 500K tokens in Codex and ChatGPT Work\. Usage drawn from your subscription has no long-context surcharge\. See Codex pricing\.$/.test(
        sentence,
      )
    ) {
      ctx.readings.observe({
        outcome: "ok",
        reasons: [],
        modelId,
        component: "codex",
        note: "Codex/ChatGPT Work subscription usage carries no long-context surcharge; the API tier is unaffected.",
        provenance: cite("Codex context note"),
      });
    } else {
      unrecognized();
    }
  }
  return checks;
}

/**
 * The effort sentence: `reasoning.effort` supports `a`, `b` (default), … . A page that
 * states no list is read as stating none when the catalog holds no effort for the model;
 * for a model whose effort the catalog tracks, a missing sentence is `needs-review`.
 */
function readEffort(ev: Evidence, pl: Plain, modelId: string, ctx: Ctx): void {
  const mark = "<code>reasoning.effort</code> supports";
  const at = pl.text.indexOf(mark);
  if (at < 0) {
    if (ctx.scope.models.get(modelId)?.hasEffort === false) return;
    ctx.readings.review({ modelId }, [
      { code: "structure", message: "the reasoning.effort sentence is missing or changed" },
    ]);
    return;
  }
  const tail = pl.text.slice(at);
  const endMatch = /\.(?=<\/p>|\s|$)/.exec(tail.slice(mark.length));
  if (endMatch === null) {
    ctx.readings.review({ modelId }, [
      { code: "structure", message: "the reasoning.effort sentence has no terminator" },
    ]);
    return;
  }
  const sentence = tail.slice(0, mark.length + endMatch.index + 1);
  const listPart = sentence.slice(mark.length);
  const items = [...listPart.matchAll(/<code>([a-z]+)<\/code>(\s*\(default\))?/g)];
  const stripped = listPart.replace(/<code>[a-z]+<\/code>\s*(\(default\))?/g, "");
  const leftover = stripped.replace(/\band\b/g, "").replace(/\(default\)/g, "");
  const okShape = items.length > 0 && /^[\s,.]*$/.test(leftover);
  const levels: string[] = [];
  let def: string | null = null;
  const reasons: { code: string; message: string }[] = [];
  if (!okShape) {
    reasons.push({
      code: "structure",
      message: `the reasoning.effort list has unexplained text: ${JSON.stringify(listPart.slice(0, 120))}`,
    });
  }
  for (const item of items) {
    const lvl = item[1] ?? "";
    if (!LEVEL_VOCAB.has(lvl)) {
      reasons.push({
        code: "structure",
        message: `effort level ${JSON.stringify(lvl)} is not in the vocabulary`,
      });
    }
    levels.push(lvl);
    if (item[2]?.includes("default")) {
      if (def !== null)
        reasons.push({ code: "structure", message: "the sentence marks two defaults" });
      def = lvl;
    }
  }
  const { offset, excerpt } = quote(ev, pl, at, at + sentence.length);
  ctx.readings.effort({
    modelId,
    levels: levels as EffortLevel[],
    default: def as EffortLevel | null,
    ...(reasons.length > 0 ? { outcome: "needs-review" as const, reasons } : {}),
    provenance: prov("openai-model-page", ev, {
      location: ev.cite("Model page › the reasoning.effort sentence", offset, excerpt),
    }),
  });
}

/** A tracked model's own page: id check, section labels, effort, summary, notes, snapshots. */
export function readOpenaiModelPage(ev: Evidence, modelId: string, ctx: Ctx): ModelPageFacts {
  const facts: ModelPageFacts = { ev, checks: [], summary: new Map() };

  const idCell = `<code class="text-xs">${modelId}</code>`;
  if (!ev.text.includes(idCell)) {
    ctx.readings.observe({
      outcome: "unreadable",
      reasons: [
        {
          code: "wrong-document",
          message: `the page at ${ev.url} does not state model id ${modelId}`,
        },
      ],
      modelId,
      source: "openai-model-page",
    });
    return facts;
  }
  const pl = plain(ev.text);
  const name = /<div class="text-2xl font-semibold whitespace-nowrap">([^<]+)<\/div>/.exec(
    pl.text,
  )?.[1];
  if (name !== undefined) facts.name = name;

  for (const m of pl.text.matchAll(/<div class="flex w-\[200px\]">([^<]+)<\/div>/g)) {
    const label = (m[1] ?? "").trim();
    if (!EXPECTED_LABELS.has(label)) {
      ctx.readings.review(
        { modelId },
        [
          {
            code: "structure",
            message: `new model-page section "${label}" this reader does not cover`,
          },
        ],
        undefined,
        prov("openai-model-page", ev, {
          location: (({ offset, excerpt }) =>
            ev.cite("Model page › section label", offset, excerpt))(
            quote(ev, pl, m.index, m.index + m[0].length),
          ),
        }),
      );
    }
  }

  readEffort(ev, pl, modelId, ctx);

  // The Pricing summary cards: `<div>LABEL</div><div class="text-2xl font-semibold">$X</div>`,
  // under a "Text tokens … Per 1M tokens" denomination line.
  const pricingAt = labelAt(pl, "Pricing");
  if (pricingAt >= 0) {
    const sumEnd = pl.text.indexOf("_MarkdownContent", pricingAt);
    const sumRegion = pl.text.slice(pricingAt, sumEnd < 0 ? pricingAt + 8000 : sumEnd);
    const denoms = [...sumRegion.matchAll(/<div>(Per [0-9]+[KMGT]? tokens)<\/div>/g)].map(
      (m) => m[1] ?? "",
    );
    if (denoms.length === 0 || denoms.some((d) => d !== "Per 1M tokens")) {
      ctx.readings.review({ modelId }, [
        {
          code: "structure",
          message: `the Pricing denomination reads ${JSON.stringify(denoms)}, expected "Per 1M tokens"`,
        },
      ]);
    }
    for (const m of sumRegion.matchAll(
      /<div>([A-Za-z ]+)<\/div><div class="text-2xl font-semibold">(\$[0-9.]+)<\/div>/g,
    )) {
      const label = (m[1] ?? "").trim();
      if (!["Input", "Cached input", "Cache writes", "Output"].includes(label)) {
        ctx.readings.review({ modelId }, [
          { code: "structure", message: `a Pricing summary card '${label}' is not understood` },
        ]);
        continue;
      }
      facts.summary.set(label, (m[2] ?? "").slice(1));
    }
  }

  // Every recognized long-context statement must agree — conflicting
  // multipliers mark the derived rates needs-review, never silently win.
  const longClaims: {
    thresholdK: number;
    inputMult: string;
    outputMult: string;
    note: NoteCheck;
  }[] = [];
  for (const n of pricingNotes(ev, pl, modelId, ctx, name ?? modelId)) {
    if (n.kind === "long-context") {
      const [k, inputMult, outputMult] = n.a.split("|");
      longClaims.push({
        thresholdK: Number(k),
        inputMult: inputMult ?? "",
        outputMult: outputMult ?? "",
        note: n,
      });
    } else {
      facts.checks.push(n);
    }
  }
  const [first, ...rest] = longClaims;
  if (first !== undefined) {
    facts.longContext = first;
    if (
      rest.some(
        (c) =>
          c.thresholdK !== first.thresholdK ||
          c.inputMult !== first.inputMult ||
          c.outputMult !== first.outputMult,
      )
    ) {
      facts.longContextConflict = true;
      ctx.readings.review({ modelId }, [
        {
          code: "structure",
          message: `conflicting long-context statements: ${longClaims.map((c) => `>${c.thresholdK}K at ${c.inputMult}x/${c.outputMult}x`).join(" vs ")}`,
        },
      ]);
    }
  }

  for (const m of ev.text.matchAll(/reasoning_effort`? set to <code>([a-z]+)<\/code>/g)) {
    if (!LEVEL_VOCAB.has(m[1] ?? "")) {
      ctx.readings.review({ modelId }, [
        {
          code: "structure",
          message: `a reasoning_effort mention names ${JSON.stringify(m[1])}, not a known level`,
        },
      ]);
    }
  }

  // Snapshots (from 2026-11-23 on some pages, "Model IDs"): the model id must appear in the
  // list — lifecycle evidence.
  const listLabel = ["Snapshots", "Model IDs"].find((l) => labelAt(pl, l) >= 0);
  const snapStart = listLabel === undefined ? -1 : labelAt(pl, listLabel);
  const ends = [">Cloud providers</div>", ">Rate limits</div>"]
    .map((m) => (snapStart < 0 ? -1 : pl.text.indexOf(m, snapStart)))
    .filter((i) => i >= 0);
  const snapEnd = ends.length === 0 ? -1 : Math.min(...ends);
  const snapRegion =
    snapStart < 0 ? "" : pl.text.slice(snapStart, snapEnd < 0 ? pl.text.length : snapEnd);
  const snapCells = [
    ...snapRegion.matchAll(
      /<div class="text-sm font-semibold">([^<]+)<\/div>|<div>([^<]+)<\/div>/g,
    ),
  ].map((m) => m[1] ?? m[2] ?? "");
  const idAt = snapRegion.indexOf(`>${modelId}<`);
  const reasons: { code: string; message: string }[] = [];
  if (snapStart < 0) reasons.push({ code: "structure", message: "no Snapshots section" });
  else if (!snapCells.some((c) => c === modelId)) {
    reasons.push({ code: "structure", message: `the Snapshots list does not name ${modelId}` });
  } else if (idAt < 0) {
    reasons.push({ code: "structure", message: `no snapshot cell cites ${modelId} verbatim` });
  }
  const useCell = idAt >= 0;
  const cell = useCell
    ? quote(ev, pl, snapStart + idAt, snapStart + idAt + modelId.length + 2)
    : { offset: ev.offsetOf(idCell), excerpt: idCell };
  const labelQuote =
    listLabel === undefined
      ? undefined
      : quote(ev, pl, snapStart + 1, snapStart + 1 + listLabel.length);
  ctx.readings.model({
    modelId,
    ...(name !== undefined ? { name } : {}),
    ...(reasons.length === 0
      ? { status: "available" as const }
      : { outcome: "needs-review" as const, reasons }),
    provenance: prov("openai-model-page", ev, {
      location: ev.cite(
        `Model page › ${listLabel ?? "Snapshots"} › ${modelId}`,
        cell.offset,
        cell.excerpt,
        labelQuote !== undefined ? [labelQuote] : [],
      ),
    }),
  });
  return facts;
}

// ---------- the pricing page ----------

interface SsrCell {
  text: string;
  /** Byte offset of the `>` closing the opening `<span>` tag. */
  offset: number;
}

interface SsrRow {
  name: string;
  cells: SsrCell[];
  /** Byte offset of the `<tr` in the evidence. */
  offset: number;
}

const STD_COLS = ["Model", "Input", "Output", "Cached input", "30m write", "12h write"];

/** The pane's rendered table: asserted headers, then body rows. */
function ssrTable(paneHtml: string, paneOffset: number, where: string): SsrRow[] {
  const tableAt = paneHtml.indexOf("<table");
  if (tableAt < 0) throw new NeedsReview("structure", `${where}: no rendered table in the pane`);
  const theadEnd = paneHtml.indexOf("</thead>", tableAt);
  if (theadEnd < 0) throw new NeedsReview("structure", `${where}: no </thead>`);
  const head = paneHtml.slice(tableAt, theadEnd);
  const headTexts = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    innerText(m[1] ?? ""),
  );
  const group = headTexts.find((t) => t !== "" && !STD_COLS.includes(t));
  const cols = headTexts.filter((t) => t !== "" && t !== "Prompt caching");
  if (group !== "Prompt caching" || JSON.stringify(cols) !== JSON.stringify(STD_COLS)) {
    throw new NeedsReview(
      "structure",
      `${where}: table headers are ${JSON.stringify(headTexts)}, expected Model/Input/Output + Prompt caching(Cached input, 30m write, 12h write)`,
    );
  }
  const tbodyAt = paneHtml.indexOf("<tbody>", theadEnd);
  const tbodyEnd = paneHtml.indexOf("</tbody>", tbodyAt);
  if (tbodyAt < 0 || tbodyEnd < 0) throw new NeedsReview("structure", `${where}: no <tbody>`);
  const body = paneHtml.slice(tbodyAt, tbodyEnd);
  const rows: SsrRow[] = [];
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1] ?? "";
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const trByteOffset =
      paneOffset + Buffer.byteLength(paneHtml.slice(0, tbodyAt + (m.index ?? 0)), "utf8");
    const innerByteOffset = trByteOffset + Buffer.byteLength(openTag, "utf8");
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    const cells: SsrCell[] = tds.map((c) => {
      const inner = c[1] ?? "";
      // The whole cell must be exactly one text span — a footnote marker or any
      // other element the span does not explain is a structure change.
      const span =
        /^<span style="align-items:center;display:flex;width:100%">([^<]*)<\/span>$/.exec(inner);
      if (span === null) {
        throw new NeedsReview(
          "structure",
          `${where}: a table cell holds ${JSON.stringify(inner.slice(0, 80))}, not the one-span form`,
        );
      }
      // The offset lands on the `>` immediately before the cell text: the td's
      // open tag, then the span's open tag.
      const m0 = c[0];
      const textAt = m0.indexOf(">") + 1 + inner.indexOf(">");
      return {
        text: innerText(span[1] ?? ""),
        offset: innerByteOffset + Buffer.byteLength(tr.slice(0, (c.index ?? 0) + textAt), "utf8"),
      };
    });
    if (cells.length !== 6) {
      throw new NeedsReview("structure", `${where}: a row has ${cells.length} cells, expected 6`);
    }
    rows.push({ name: cells[0]?.text ?? "", cells, offset: trByteOffset });
  }
  if (rows.length === 0) throw new NeedsReview("structure", `${where}: the table has no rows`);
  return rows;
}

/** A serialized pricing row: `[name, input, cachedInput, write30m?, output]`. */
interface PropsRow {
  name: string;
  /** The page marks the row `deprecated` (its name is then an object `{label, deprecated}`). */
  deprecated?: true;
  input: string | null;
  cached: string | null;
  write30m: string | null;
  output: string | null;
}

function propsValue(v: unknown, where: string): string | null {
  if (v === null || v === "-") return null;
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(v)) return v;
  throw new NeedsReview("bad-amount", `${where}: a props cell is ${JSON.stringify(v)}`);
}

function propsRows(rows: unknown, where: string): PropsRow[] {
  if (!Array.isArray(rows))
    throw new NeedsReview("structure", `${where}: props.rows is not an array`);
  const out: PropsRow[] = [];
  for (const r of rows) {
    const head: unknown = Array.isArray(r) ? r[0] : undefined;
    const labelled =
      typeof head === "object" &&
      head !== null &&
      typeof (head as { label?: unknown }).label === "string" &&
      (head as { deprecated?: unknown }).deprecated === true;
    if (
      !Array.isArray(r) ||
      r.length < 4 ||
      r.length > 5 ||
      (typeof head !== "string" && !labelled)
    ) {
      throw new NeedsReview(
        "structure",
        `${where}: a props row is not [name, input, cached, 30m?, output]`,
      );
    }
    out.push({
      name: labelled ? (head as { label: string }).label : (head as string),
      ...(labelled ? { deprecated: true as const } : {}),
      input: propsValue(r[1], where),
      cached: propsValue(r[2], where),
      write30m: r.length === 5 ? propsValue(r[3], where) : null,
      output: r.length === 5 ? propsValue(r[4], where) : propsValue(r[3], where),
    });
  }
  return out;
}

const PRICE_CELL_RE = /^\$([0-9]+(?:\.[0-9]+)?)$/;

interface Pane {
  value: string;
  label: string;
  rows: PropsRow[];
  alternateRows?: PropsRow[];
  ssr: SsrRow[];
  collapsed: number | undefined;
  /** Byte offset of the pane's `data-content-switcher-pane` marker. */
  offset: number;
  /** Byte offset of the props attribute's value in the evidence. */
  propsOffset: number;
  propsText: string;
  /** Byte offset just past the pane's end. */
  end: number;
}

const EXPECTED_LABEL = {
  standard: "Standard",
  batch: "Batch",
  flex: "Flex",
  fast: "Fast",
  ultrafast: "Ultrafast",
};

function readPane(
  _ev: Evidence,
  sectionHtml: string,
  sectionStart: number,
  value: string,
  where: string,
): Pane | undefined {
  const re = new RegExp(`data-content-switcher-pane="true" data-value="${value}"`, "g");
  const m = re.exec(sectionHtml);
  if (m === null) return undefined;
  const next = re.exec(sectionHtml);
  const paneHtml = sectionHtml.slice(m.index, next !== null ? next.index : undefined);
  const labelMatch = /<div class="hidden">([^<]+)<\/div>/.exec(paneHtml);
  if ((labelMatch?.[1] ?? "") !== EXPECTED_LABEL[value as keyof typeof EXPECTED_LABEL]) {
    throw new NeedsReview(
      "structure",
      `${where}: pane '${value}' is labelled ${JSON.stringify(labelMatch?.[1])}`,
    );
  }
  const islandAt = paneHtml.indexOf("<astro-island");
  if (islandAt < 0)
    throw new NeedsReview("structure", `${where}: pane '${value}' has no astro-island`);
  const island = paneHtml.slice(islandAt);
  const exportMatch = /component-export="([^"]+)"/.exec(island);
  if (exportMatch?.[1] !== "TextTokenPricingTables") {
    throw new NeedsReview("structure", `${where}: pane '${value}' exports ${exportMatch?.[1]}`);
  }
  const propsM = /props="([^"]*)"/.exec(island);
  if (propsM === null) throw new NeedsReview("structure", `${where}: pane '${value}' has no props`);
  const props = islandProps(island, `${where} › pane '${value}'`);
  if (props.tier !== value) {
    throw new NeedsReview(
      "structure",
      `${where}: pane '${value}' declares tier ${JSON.stringify(props.tier)}`,
    );
  }
  if (props.latestSectionLabel !== null && props.latestSectionLabel !== undefined) {
    throw new NeedsReview(
      "structure",
      `${where}: pane '${value}' carries latestSectionLabel ${JSON.stringify(props.latestSectionLabel)}`,
    );
  }
  const rows = propsRows(props.rows, `${where} › pane '${value}'`);
  const alternateRows =
    props.alternateRows !== undefined
      ? propsRows(props.alternateRows, `${where} › pane '${value}' › alternateRows`)
      : undefined;
  const collapsed =
    props.collapsedLatestRowCount === null || props.collapsedLatestRowCount === undefined
      ? undefined
      : typeof props.collapsedLatestRowCount === "number"
        ? props.collapsedLatestRowCount
        : (() => {
            throw new NeedsReview(
              "structure",
              `${where}: collapsedLatestRowCount is ${JSON.stringify(props.collapsedLatestRowCount)}`,
            );
          })();
  const paneOffset = sectionStart + Buffer.byteLength(sectionHtml.slice(0, m.index), "utf8");
  const propsOffset =
    paneOffset + Buffer.byteLength(paneHtml.slice(0, islandAt + propsM.index + 7), "utf8");
  const end =
    sectionStart +
    Buffer.byteLength(
      sectionHtml.slice(0, next !== null ? next.index : sectionHtml.length),
      "utf8",
    );
  return {
    value,
    label: labelMatch?.[1] ?? "",
    rows,
    ...(alternateRows !== undefined ? { alternateRows } : {}),
    ssr: ssrTable(paneHtml, paneOffset, `${where} › pane '${value}'`),
    collapsed,
    offset: paneOffset,
    propsOffset,
    propsText: propsM[1] ?? "",
    end,
  };
}

/** `$10.00` → `"10.00"`; a `-`/empty cell is not a price. */
function cellAmount(text: string, where: string): string | null {
  const m = PRICE_CELL_RE.exec(text);
  if (m !== null) return m[1] ?? "";
  if (text === "-" || text === "" || text === "—") return null;
  throw new NeedsReview("bad-amount", `${where}: ${JSON.stringify(text)} is not a $ price`);
}

function bareName(name: string): string {
  const m = /^(.+?)\s*\(<272K context length\)$/.exec(name);
  return (m?.[1] ?? name).trim();
}

function sameAmount(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return eqDecimal(a, b);
}

/** The column header anchor inside the same pane: `>Input</th>` or `<span>30m write</span>`. */
function headerAnchor(ev: Evidence, col: string, from: number, to: number): Anchor {
  for (const f of [`>${col}</th>`, `<span>${col}</span>`]) {
    const at = ev.offsetOf(f, from);
    if (at >= 0 && at < to) return { offset: at, excerpt: f };
  }
  for (const f of [`>${col}</th>`, `<span>${col}</span>`]) {
    const at = ev.offsetOf(f);
    if (at >= 0) return { offset: at, excerpt: f };
  }
  throw new ReaderBug(`no '${col}' header in the pricing page`);
}

/** `&quot;name&quot;` inside a pane's props value — the serialized row name. */
function propsNameAnchor(pane: Pane, name: string, after = "&quot;rows&quot;"): Anchor {
  const esc = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const needle = `&quot;${esc}&quot;`;
  const keyAt = pane.propsText.indexOf(after);
  const rel = pane.propsText.indexOf(needle, Math.max(keyAt, 0));
  if (rel < 0) {
    throw new NeedsReview("structure", `pane '${pane.value}': no serialized row named ${name}`);
  }
  return {
    offset: pane.propsOffset + Buffer.byteLength(pane.propsText.slice(0, rel), "utf8"),
    excerpt: needle,
  };
}

/**
 * The serialized row of `name` in a pane's props, from its name cell through the row's closing
 * brackets: `[0,&quot;gpt-6-luna&quot;],[0,0.1],[0,0.01],[0,0.125],[0,0.5]]`. The page renders only
 * its first rows into the table, so a later row's prices are cited here.
 */
function propsRowCite(pane: Pane, name: string): { offset: number; excerpt: string } {
  const anchor = propsNameAnchor(pane, name);
  const rel = pane.propsText.indexOf(
    `[0,${anchor.excerpt}]`,
    Math.max(pane.propsText.indexOf("&quot;rows&quot;"), 0),
  );
  const at = rel < 0 ? -1 : pane.propsText.indexOf("]]", rel);
  if (rel < 0 || at < 0) {
    throw new NeedsReview("structure", `pane '${pane.value}': the serialized row ${name} is cut`);
  }
  return {
    offset: pane.propsOffset + Buffer.byteLength(pane.propsText.slice(0, rel), "utf8"),
    excerpt: pane.propsText.slice(rel, at + 2),
  };
}

// ---------- the flagship section ----------

const PANE_ORDER = ["standard", "batch", "flex", "fast", "ultrafast"] as const;

interface Flagship {
  standard: Pane;
  sectionHtml: string;
  sectionStart: number;
  end: number;
  /** The stated context boundary in tokens — `≤272K` / `>272K` as 272,000. */
  boundary: number;
}

/** The `id="text-tokens"` section: four asserted panes plus the footnote. */
function readFlagship(ev: Evidence, ctx: Ctx): Flagship {
  const start = ev.text.indexOf('id="text-tokens"');
  if (start < 0) {
    throw new NeedsReview("structure", "the pricing page has no 'text-tokens' section");
  }
  // The section ends at the next `<h2`: "cyber-models" on the 2026-11-04 page, "image-tokens"
  // since the page was reorganized (the cyber models moved into "specialized-models").
  const end = ev.text.indexOf("<h2", start + 1);
  if (end < 0) {
    throw new NeedsReview("structure", "the pricing page has no section after 'text-tokens'");
  }
  const sectionHtml = ev.text.slice(start, end);
  const sectionStart = ev.byteOffset(start);

  // The context-length selector states the boundary the tier conditions use:
  // `aria-label="Short: ≤272K input tokens"` / `Long: >272K input tokens`.
  const shortM = /aria-label="Short: (?:≤|&le;)([0-9]+)K input tokens"/.exec(sectionHtml);
  const longM = /aria-label="Long: (?:>|&gt;)([0-9]+)K input tokens"/.exec(sectionHtml);
  if (shortM === null || longM === null || shortM[1] !== longM[1]) {
    throw new NeedsReview(
      "structure",
      "Flagship models: the Short/Long context-length selector is missing or changed",
    );
  }
  const boundary = Number(shortM[1]) * 1000;

  // The stated denomination: every `pricing-switcher-meta` small in the section
  // must read exactly "Prices per 1M tokens." — a changed unit silently rescales
  // every rate the section emits.
  const metas = [
    ...sectionHtml.matchAll(/<small class="pricing-switcher-meta[^"]*">([^<]*)<\/small>/g),
  ];
  if (metas.length === 0) {
    throw new NeedsReview(
      "structure",
      "Flagship models: the 'Prices per 1M tokens.' denomination line is missing",
    );
  }
  for (const m of metas) {
    if ((m[1] ?? "").trim() !== "Prices per 1M tokens.") {
      throw new NeedsReview(
        "structure",
        `Flagship models: the denomination line reads ${JSON.stringify(m[1])}, expected "Prices per 1M tokens."`,
      );
    }
  }

  // Every pane the switcher renders must be a known tier — a new pane touching
  // tracked models is needs-review, never silently unpriced.
  const paneValues = [
    ...sectionHtml.matchAll(/data-content-switcher-pane="true" data-value="([^"]+)"/g),
  ].map((m) => m[1] ?? "");
  for (const value of new Set(paneValues)) {
    if (!(PANE_ORDER as readonly string[]).includes(value)) {
      const at = sectionHtml.indexOf(`data-value="${value}"`);
      const label = /<div class="hidden">([^<]+)<\/div>/.exec(
        sectionHtml.slice(Math.max(at, 0), Math.max(at, 0) + 4000),
      )?.[1];
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `Flagship models: pane '${value}'${label !== undefined ? ` ('${label}')` : ""} is not a known tier`,
        },
      ]);
    }
  }
  if (paneValues.length !== new Set(paneValues).size) {
    throw new NeedsReview(
      "structure",
      `Flagship models: duplicate panes ${JSON.stringify(paneValues)}`,
    );
  }

  const panes: Pane[] = [];
  for (const value of PANE_ORDER) {
    const pane = readPane(ev, sectionHtml, sectionStart, value, "Flagship models");
    if (pane !== undefined) panes.push(pane);
  }
  const [standard, ...others] = panes;
  // Batch, Fast and Ultrafast; since 2026-11-23 also a Flex pane of its own.
  const shape = panes.map((p) => p.value).join(",");
  if (
    standard?.value !== "standard" ||
    (shape !== "standard,batch,fast,ultrafast" && shape !== "standard,batch,flex,fast,ultrafast")
  ) {
    throw new NeedsReview(
      "structure",
      `Flagship models: panes are ${JSON.stringify(panes.map((p) => p.value))}`,
    );
  }

  // SSR/serialized agreement: the first `collapsedLatestRowCount` serialized rows
  // render verbatim in the SSR table — a cross-check, not a second source.
  const rendered = standard.collapsed ?? standard.ssr.length;
  if (standard.ssr.length !== rendered) {
    throw new NeedsReview(
      "structure",
      `Flagship › Standard: ${standard.ssr.length} SSR rows but collapsedLatestRowCount is ${standard.collapsed}`,
    );
  }
  for (let i = 0; i < standard.ssr.length; i++) {
    const ssr = standard.ssr[i];
    const row = standard.rows[i];
    if (ssr === undefined || row === undefined) {
      throw new NeedsReview("structure", "Flagship › Standard: SSR/serialized row mismatch");
    }
    if (bareName(ssr.name) !== row.name) {
      throw new NeedsReview(
        "structure",
        `Flagship › Standard row ${i + 1}: SSR names ${JSON.stringify(ssr.name)}, props name ${JSON.stringify(row.name)}`,
      );
    }
    const pairs: [string, string | null, string | null][] = [
      [
        "Input",
        cellAmount(ssr.cells[1]?.text ?? "", `Flagship › Standard › '${ssr.name}' › Input`),
        row.input,
      ],
      [
        "Output",
        cellAmount(ssr.cells[2]?.text ?? "", `Flagship › Standard › '${ssr.name}' › Output`),
        row.output,
      ],
      [
        "Cached input",
        cellAmount(ssr.cells[3]?.text ?? "", `Flagship › Standard › '${ssr.name}' › Cached input`),
        row.cached,
      ],
      [
        "30m write",
        cellAmount(ssr.cells[4]?.text ?? "", `Flagship › Standard › '${ssr.name}' › 30m write`),
        row.write30m,
      ],
      [
        "12h write",
        cellAmount(ssr.cells[5]?.text ?? "", `Flagship › Standard › '${ssr.name}' › 12h write`),
        row.write30m === null ? null : mulDecimal(row.write30m, "2"),
      ],
    ];
    for (const [col, ssrAmt, propsAmt] of pairs) {
      if (!sameAmount(ssrAmt, propsAmt)) {
        throw new NeedsReview(
          "structure",
          `Flagship › Standard › '${ssr.name}' › ${col}: SSR states ${ssrAmt ?? "-"}, props state ${propsAmt ?? "-"}`,
        );
      }
    }
  }

  // Every alternate pane is a non-schema tier; its rows are reviewed, never priced.
  for (const pane of others) {
    for (const r of pane.rows) {
      ctx.readings.rate({
        modelId: bareName(r.name),
        tier: `openai:${pane.value}`,
        component: TIER_NOT_IN_SCHEMA,
        fact: {
          disposition: "unsupported",
          reason: `the ${pane.label} tier is not in schema 1.0.0`,
        },
        outcome: "needs-review",
        reasons: [{ code: "structure", message: `the ${pane.label} tier is not in schema 1.0.0` }],
        provenance: prov("openai-pricing", ev, {
          location: ev.cite(
            `Flagship models › ${pane.label} › ${bareName(r.name)}`,
            pane.offset,
            `data-content-switcher-pane="true" data-value="${pane.value}"`,
            [propsNameAnchor(pane, r.name)],
          ),
        }),
      });
    }
    for (const r of pane.alternateRows ?? []) {
      ctx.readings.rate({
        modelId: bareName(r.name),
        tier: `openai:${pane.value}`,
        component: TIER_NOT_IN_SCHEMA,
        fact: {
          disposition: "unsupported",
          reason: `a ${pane.label} alternate (Flex) row is not in schema 1.0.0`,
        },
        outcome: "needs-review",
        reasons: [
          { code: "structure", message: `a ${pane.label} alternate row is not in schema 1.0.0` },
        ],
        provenance: prov("openai-pricing", ev, {
          location: ev.cite(
            `Flagship models › ${pane.label} › alternate › ${bareName(r.name)}`,
            pane.offset,
            `data-content-switcher-pane="true" data-value="${pane.value}"`,
            [propsNameAnchor(pane, r.name, "&quot;alternateRows&quot;")],
          ),
        }),
      });
    }
  }

  // The footnote: four understood clauses; anything else in it needs review.
  const foot = /<div class="pricing-footnote"><p>([\s\S]*?)<\/p><\/div>/.exec(sectionHtml);
  if (foot === null) {
    throw new NeedsReview("structure", "Flagship models: the pricing footnote is missing");
  }
  const footText = innerText(foot[1] ?? "");
  const clauses = footText
    .split(/\.\s+/)
    .map((c) => c.replace(/\.$/, "").trim())
    .filter(Boolean);
  const KNOWN = [
    /^Regional processing \(data residency\) endpoints are charged a 10% uplift for models released on or after March 5, 2026$/,
    /^Starting Nov 1, 2026, FedRAMP endpoints are also charged a 10% uplift$/,
    /^Priority processing was renamed Fast mode on July 30, 2026$/,
    /^GPT-5\.6 Sol’s promotional pricing is available at least through November 21, 2026$/,
    // Flex, which is not a schema tier: its beta is wound down (2026-11-23).
    /^\* Flex remains available on the models listed here as we wind down the beta$/,
    /^We won’t be adding Flex to new models$/,
    /^We’ll publish the retirement date in the Flex processing guide once confirmed$/,
  ];
  for (const c of clauses) {
    if (!KNOWN.some((k) => k.test(c))) {
      ctx.readings.review({}, [
        {
          code: "unknown-footnote",
          message: `a pricing footnote this reader does not understand: ${JSON.stringify(c.slice(0, 140))}`,
        },
      ]);
    }
  }

  return { standard, sectionHtml, sectionStart, end: ev.byteOffset(end), boundary };
}

const STD_COMPONENTS: { col: string; component: string; pick: (r: PropsRow) => string | null }[] = [
  { col: "Input", component: "input", pick: (r) => r.input },
  { col: "Output", component: "output", pick: (r) => r.output },
  { col: "Cached input", component: "input_cached", pick: (r) => r.cached },
  { col: "30m write", component: "cache_write_30m", pick: (r) => r.write30m },
  {
    col: "12h write",
    component: "cache_write_12h",
    pick: (r) => (r.write30m === null ? null : mulDecimal(r.write30m, "2")),
  },
];

const GT_COMPONENTS = new Set(["input", "input_cached", "output"]);
const GT_UNSUPPORTED = new Set(["cache_write_30m", "cache_write_12h"]);

/** The `<span>` cell text for a tracked row in the standard SSR table, if rendered. */
function ssrRowFor(pane: Pane, name: string): SsrRow | undefined {
  return pane.ssr.find((r) => bareName(r.name) === name);
}

/** Emit the Standard rates for one tracked flagship row (≤272K, plus >272K derivations). */
function emitStandardRow(
  ev: Evidence,
  pane: Pane,
  row: PropsRow,
  modelId: string,
  facts: ModelPageFacts | undefined,
  boundary: number,
  ctx: Ctx,
  contradicted = false,
): void {
  const tainted = contradicted
    ? {
        outcome: "needs-review" as const,
        reasons: [
          {
            code: "structure",
            message: `the model page's Pricing claims disagree with the Standard table for ${modelId}`,
          },
        ],
      }
    : {};
  const lte: { inputTokens: { lte: number } } = { inputTokens: { lte: boundary } };
  const gt: { inputTokens: { gt: number } } = { inputTokens: { gt: boundary } };
  const ssr = ssrRowFor(pane, row.name);
  const nameAnchor: Anchor =
    ssr !== undefined
      ? { offset: ssr.cells[0]?.offset ?? ssr.offset, excerpt: `>${row.name}</span>` }
      : propsNameAnchor(pane, row.name);
  const rowWhere = `Flagship models › Standard › row '${modelId}'`;
  const labelAt = ev.offsetOf(`<div class="hidden">${pane.label}</div>`, pane.offset);
  const paneAnchor: Anchor =
    labelAt >= 0 && labelAt < pane.end
      ? { offset: labelAt, excerpt: `<div class="hidden">${pane.label}</div>` }
      : {
          offset: pane.offset,
          excerpt: `data-content-switcher-pane="true" data-value="${pane.value}"`,
        };

  for (const { col, component, pick } of STD_COMPONENTS) {
    const amount = pick(row);
    const colIdx = STD_COLS.indexOf(col);
    const ssrCell = ssr?.cells[colIdx];
    const propsRow = ssrCell === undefined ? propsRowCite(pane, row.name) : undefined;
    const loc = prov("openai-pricing", ev, {
      location: ev.cite(
        `Pricing › ${rowWhere} › column '${col}'`,
        ssrCell?.offset ?? propsRow?.offset ?? pane.offset,
        ssrCell !== undefined ? `>${ssrCell.text}</span>` : (propsRow?.excerpt ?? ""),
        [paneAnchor, headerAnchor(ev, col, pane.offset, pane.end), nameAnchor],
      ),
      dateRule: "undated",
    });
    const unstated12h = col === "12h write" && ssrCell === undefined && amount !== null;
    if (unstated12h) {
      // The serialized row has no 12-hour column; the page's script shows twice the 30-minute
      // write, which its HTML never states for a row it does not render. Not stated, so no price.
      ctx.readings.rate({
        modelId,
        tier: TIER_STANDARD,
        component,
        fact: {
          disposition: "unsupported",
          reason: `The page's HTML states no 12-hour cache write price for ${modelId}: its serialized row holds the input, cached input, 30-minute write and output prices only, and the table renders its first rows alone. No price is entered.`,
        },
        condition: lte,
        conditionInputs: CONDITION_INPUTS,
        ...tainted,
        provenance: loc,
      });
    } else if (amount === null) {
      ctx.readings.rate({
        modelId,
        tier: TIER_STANDARD,
        component,
        fact: {
          disposition: "inapplicable",
          reason: `the Standard table shows no ${col} price for ${modelId}`,
        },
        outcome: "needs-review",
        reasons: [
          { code: "structure", message: `${modelId} has no ${col} price in the Standard table` },
        ],
        provenance: loc,
      });
      continue;
    } else {
      ctx.readings.rate({
        modelId,
        tier: TIER_STANDARD,
        component,
        fact: { disposition: "priced", unit: "token", per: PER_TOKEN, amount, currency: "USD" },
        condition: lte,
        conditionInputs: CONDITION_INPUTS,
        ...tainted,
        provenance: loc,
      });
    }

    // Above the boundary: the model page's multiplier produces the derived rate.
    const lc = facts?.longContext;
    if (facts === undefined || lc === undefined) continue;
    const boundaryOk = lc.thresholdK * 1000 === boundary;
    const cond = boundaryOk ? gt : { inputTokens: { gt: lc.thresholdK * 1000 } };
    const noteExcerpt = facts.ev.bytes
      .subarray(lc.note.offset, lc.note.offset + lc.note.length)
      .toString("utf8");
    const noteProv = prov("openai-model-page", facts.ev, {
      location: facts.ev.cite(
        `${facts.name ?? modelId} › Pricing › long-context note`,
        lc.note.offset,
        noteExcerpt,
      ),
    });
    const mult = component === "output" ? lc.outputMult : lc.inputMult;
    if (GT_COMPONENTS.has(component)) {
      const derived = mulDecimal(amount, mult);
      ctx.readings.rate({
        modelId,
        tier: TIER_STANDARD,
        component,
        fact: {
          disposition: "priced",
          unit: "token",
          per: PER_TOKEN,
          amount: derived,
          currency: "USD",
        },
        condition: cond,
        conditionInputs: CONDITION_INPUTS,
        ...tainted,
        ...(facts.longContextConflict === true
          ? {
              outcome: "needs-review" as const,
              reasons: [
                {
                  code: "structure",
                  message: `the model page states conflicting long-context multipliers; this derivation is not safe`,
                },
              ],
            }
          : boundaryOk
            ? {}
            : {
                outcome: "needs-review" as const,
                reasons: [
                  {
                    code: "structure",
                    message: `the model page's >${lc.thresholdK}K surcharge does not match the pricing page's ${boundary / 1000}K boundary`,
                  },
                ],
              }),
        provenance: prov("openai-pricing", ev, {
          derivation: {
            formula: `${mult} × $${amount} (${col}, prompts of at most ${lc.thresholdK}K) = $${derived} per 1M tokens, for the full request above ${lc.thresholdK}K input tokens`,
            inputs: [
              {
                evidence: ev.sha256,
                url: ev.url,
                path: `Pricing › ${rowWhere} › column '${col}'`,
                offset: loc.location?.offset ?? pane.offset,
                excerpt: loc.location?.excerpt ?? `&quot;${row.name}&quot;`,
              },
              {
                evidence: facts.ev.sha256,
                url: facts.ev.url,
                path: `${facts.name ?? modelId} › Pricing › long-context note`,
                offset: lc.note.offset,
                excerpt: noteExcerpt,
              },
            ],
          },
          dateRule: "undated",
          note: `"${lc.thresholdK}K" is read as ${lc.thresholdK * 1000}.`,
        }),
      });
    } else if (GT_UNSUPPORTED.has(component)) {
      ctx.readings.rate({
        modelId,
        tier: TIER_STANDARD,
        component,
        fact: {
          disposition: "unsupported",
          reason: `Above ${lc.thresholdK}K input tokens the model page prices "input and cache rates" at ${lc.inputMult}x; whether that covers the 30-minute and 12-hour cache-write rates is not stated, so no price is entered.`,
        },
        condition: cond,
        ...tainted,
        ...(facts.longContextConflict === true
          ? {
              outcome: "needs-review" as const,
              reasons: [
                {
                  code: "structure",
                  message: `the model page states conflicting long-context multipliers; this derivation is not safe`,
                },
              ],
            }
          : boundaryOk
            ? {}
            : {
                outcome: "needs-review" as const,
                reasons: [
                  {
                    code: "structure",
                    message: `the model page's >${lc.thresholdK}K surcharge does not match the pricing page's ${boundary / 1000}K boundary`,
                  },
                ],
              }),
        provenance: noteProv,
      });
    }
  }
}

/** A model-page claim must agree with the table value for its model. Returns false on any mismatch. */
function verifyChecks(
  _ev: Evidence,
  _pane: Pane,
  row: PropsRow,
  modelId: string,
  facts: ModelPageFacts,
  ctx: Ctx,
): boolean {
  let ok = true;
  const fail = (message: string) => {
    ok = false;
    ctx.readings.review({ modelId }, [{ code: "structure", message }]);
  };
  const noteProv = (n: NoteCheck, what: string) =>
    prov("openai-model-page", facts.ev, {
      location: facts.ev.cite(
        `${facts.name ?? modelId} › Pricing › ${what}`,
        n.offset,
        facts.ev.bytes.subarray(n.offset, n.offset + n.length).toString("utf8"),
      ),
    });
  for (const n of facts.checks) {
    if (n.kind === "cached") {
      if (
        row.input === null ||
        row.cached === null ||
        !eqDecimal(row.cached, mulDecimal(row.input, String(Number(n.a) / 100)))
      ) {
        fail(
          `the model page says cached input is ${n.a}% of input but the table shows input=${row.input ?? "-"}, cached=${row.cached ?? "-"}`,
        );
      }
    } else if (n.kind === "cache-write") {
      if (
        row.input === null ||
        row.write30m === null ||
        !eqDecimal(row.write30m, mulDecimal(row.input, n.a))
      ) {
        fail(
          `the model page says cache writes are ${n.a}x input but the table shows input=${row.input ?? "-"}, 30m write=${row.write30m ?? "-"}`,
        );
      }
    } else if (n.kind === "explicit-writes") {
      const w12 = row.write30m === null ? null : mulDecimal(row.write30m, "2");
      if (!eqDecimal(row.write30m ?? "", n.a) || !eqDecimal(w12 ?? "", n.b ?? "")) {
        fail(
          `the model page states 30m=$${n.a}/12h=$${n.b} cache writes but the table shows ${row.write30m ?? "-"}/${w12 ?? "-"}`,
        );
      }
    } else if (n.kind === "write-12h") {
      const w12 = row.write30m === null ? null : mulDecimal(row.write30m, "2");
      if (w12 === null || !eqDecimal(w12, n.a)) {
        fail(
          `the model page states a 12-hour cache write of $${n.a} but the table shows ${w12 ?? "-"}`,
        );
      }
    } else if (n.kind === "tier-mult") {
      ctx.readings.observe({
        outcome: "ok",
        reasons: [],
        modelId,
        note: `the model page confirms the ${n.panes?.join("/") ?? ""} tier multiplier ${n.a}x; non-schema tier`,
        provenance: noteProv(n, "tier multiplier"),
      });
    }
  }
  // The summary cards restate the table: disagreeing numbers need review.
  const cardMap: [string, string | null][] = [
    ["Input", row.input],
    ["Cached input", row.cached],
    ["Cache writes", row.write30m],
    ["Output", row.output],
  ];
  for (const [label, want] of cardMap) {
    const got = facts.summary.get(label);
    if (got === undefined || want === null || !eqDecimal(got, want)) {
      if (got === undefined && want === null) continue;
      if (got !== undefined || want !== null) {
        fail(
          `the Pricing summary card '${label}' says ${got ?? "(absent)"} but the Standard table shows ${want ?? "-"}`,
        );
      }
    }
  }
  return ok;
}

// ---------- the Tools table ----------

interface ToolRow {
  group: string;
  details: string;
  /** The cost cell's visible text before any `<small>` note. */
  cost: string;
  /** The `<small>` note text, when present. */
  small: string | null;
  /** Byte offset of the row's `<tr` match. */
  offset: number;
  /** The full `<tr>...</tr>` bytes. */
  tr: string;
  /** The details cell's raw inner HTML. */
  detailsInner: string;
}

function readTools(ev: Evidence, boundary: number, ctx: Ctx): void {
  const start = ev.text.indexOf('id="built-in-tools"');
  if (start < 0) {
    throw new NeedsReview("structure", "the pricing page has no 'built-in-tools' section");
  }
  // Up to the next `<h2`: "specialized-models" on the 2026-11-04 page, "cloud-platforms" since.
  const end = ev.text.indexOf("<h2", start + 1);
  if (end < 0) {
    throw new NeedsReview("structure", "the pricing page has no section after 'built-in-tools'");
  }
  const html = ev.text.slice(start, end);
  const tableAt = html.indexOf("<table");
  if (tableAt < 0) throw new NeedsReview("structure", "built-in-tools: no table");
  const theadEnd = html.indexOf("</thead>", tableAt);
  const headTexts = [...html.slice(tableAt, theadEnd).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
    (m) => innerText(m[1] ?? ""),
  );
  if (
    JSON.stringify(headTexts.filter((t) => t !== "")) !==
    JSON.stringify(["Tool", "Details", "Pricing"])
  ) {
    throw new NeedsReview(
      "structure",
      `built-in-tools: headers are ${JSON.stringify(headTexts)}, expected Tool/Details/Pricing`,
    );
  }
  const tbodyAt = html.indexOf("<tbody>", theadEnd);
  const tbodyEnd = html.indexOf("</tbody>", tbodyAt);
  if (tbodyAt < 0 || tbodyEnd < 0) throw new NeedsReview("structure", "built-in-tools: no <tbody>");

  interface Td {
    inner: string;
    span: number;
  }
  const rows: ToolRow[] = [];
  let carry = "";
  for (const m of html.slice(tbodyAt, tbodyEnd).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1] ?? "";
    const tds: Td[] = [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((c) => {
      const span = /\browSpan="(\d+)"/.exec(c[1] ?? "");
      return { inner: c[2] ?? "", span: span !== null ? Number(span[1]) : 1 };
    });
    let group = carry;
    let rest = tds;
    if (tds.length === 3) {
      group = innerText(tds[0]?.inner ?? "");
      carry = group;
      rest = tds.slice(1);
    }
    if (rest.length !== 2 || group === "") {
      throw new NeedsReview("structure", `built-in-tools: a row has ${tds.length} cells`);
    }
    const costHtml = rest[1]?.inner ?? "";
    const small = /<small>([\s\S]*?)<\/small>/.exec(costHtml)?.[1];
    const cost = innerText(costHtml.replace(/<small>[\s\S]*?<\/small>/g, ""));
    rows.push({
      group,
      details: innerText((rest[0]?.inner ?? "").replace(/<br\s*\/?>/g, " ")),
      cost,
      small: small !== undefined ? innerText(small) : null,
      offset: ev.byteOffset(start + tbodyAt + (m.index ?? 0)),
      tr: m[0],
      detailsInner: rest[0]?.inner ?? "",
    });
  }
  if (rows.length === 0) throw new NeedsReview("structure", "built-in-tools: no rows");

  // (group, details) → the fact the row states for every model it covers.
  const TOOL_MAP = new Map<
    string,
    | { component: string; disposition: "priced"; price: RegExp }
    | { component: string; disposition: "unsupported"; cost: RegExp; reason: string }
  >([
    [
      "Web search|Web search (all models)",
      {
        component: "web_search",
        disposition: "priced",
        price: /^\$([0-9]+(?:\.[0-9]+)?) \/ 1k calls$/,
      },
    ],
    // The same row since 2026-11-23, when the page dropped "(all models)" from its name and
    // gave the two preview rows their own model qualifiers.
    [
      "Web search|Web search (incl. images)",
      {
        component: "web_search",
        disposition: "priced",
        price: /^\$([0-9]+(?:\.[0-9]+)?) \/ 1k calls$/,
      },
    ],
    [
      "File search|Tool call",
      {
        component: "file_search",
        disposition: "priced",
        price: /^\$([0-9]+(?:\.[0-9]+)?) \/ 1k calls$/,
      },
    ],
    [
      "File search|Storage",
      {
        component: "file_search_storage",
        disposition: "unsupported",
        cost: /^\$[0-9]+(?:\.[0-9]+)? \/ GB per day(?: \(1 GB free\)| 1 GB free)$/,
        reason:
          "Storage billed per GB per day with 1 GB free, outside any single call; free allowances are not modelled.",
      },
    ],
    [
      "Containers|Hosted Shell and Code Interpreter",
      {
        component: "containers",
        disposition: "unsupported",
        cost: /^[0-9]+ GB \$[0-9.]+(, [0-9]+ GB \$[0-9.]+)* per 20-minute session per container\.?$/,
        reason:
          "Billed per 20-minute session per container, at a price that depends on the container's memory (1 GB $0.03 to 64 GB $1.92); not expressible as one rate.",
      },
    ],
  ]);

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.group}|${row.details}`;
    const mapped = TOOL_MAP.get(key);
    const detAt = row.tr.indexOf(row.detailsInner);
    // The whole row, or — when its inline styles make it longer than a citation may be (600
    // characters) — the price text inside it.
    const priceAt = row.tr.indexOf(row.cost);
    const wholeRow = row.tr.length <= 600 || priceAt < 0;
    const loc = ev.cite(
      `Pricing › Tools › row '${row.details}' › Pricing`,
      wholeRow ? row.offset : row.offset + Buffer.byteLength(row.tr.slice(0, priceAt), "utf8"),
      wholeRow ? row.tr : row.cost,
      [
        {
          offset: row.offset + Buffer.byteLength(row.tr.slice(0, Math.max(detAt, 0)), "utf8"),
          excerpt: row.detailsInner.slice(0, 80),
        },
      ],
    );
    const noteOk =
      row.small === null || row.small === "+ Search content tokens billed at model rates.";
    if (mapped === undefined) {
      ctx.readings.rate({
        modelId: row.details,
        tier: TIER_STANDARD,
        component: `tool:${row.group} › ${row.details}`,
        fact: {
          disposition: "unsupported",
          reason: `a Tools row '${row.details}' priced ${JSON.stringify(row.cost)} is not a tracked component`,
        },
        outcome: "needs-review",
        reasons: [
          {
            code: "structure",
            message: `a Tools row '${row.details}' (${row.group}) is not a mapped component`,
          },
        ],
        provenance: prov("openai-pricing", ev, { location: loc }),
      });
      continue;
    }
    seen.add(key);
    if (mapped.disposition === "priced") {
      const pm = mapped.price.exec(row.cost);
      if (pm === null || !noteOk) {
        ctx.readings.rate({
          modelId: row.details,
          tier: TIER_STANDARD,
          component: mapped.component,
          fact: {
            disposition: "unsupported",
            reason: `the ${row.details} cell reads ${JSON.stringify(row.cost)}${row.small !== null ? ` with note ${JSON.stringify(row.small)}` : ""}`,
          },
          outcome: "needs-review",
          reasons: [{ code: "structure", message: `the ${row.details} cost cell changed` }],
          provenance: prov("openai-pricing", ev, { location: loc }),
        });
        continue;
      }
      for (const id of ctx.scope.models.keys()) {
        for (const condition of [
          { inputTokens: { lte: boundary } },
          { inputTokens: { gt: boundary } },
        ]) {
          ctx.readings.rate({
            modelId: id,
            tier: TIER_STANDARD,
            component: mapped.component,
            fact: {
              disposition: "priced",
              unit: "request",
              per: 1000,
              amount: pm[1] ?? "",
              currency: "USD",
            },
            condition,
            provenance: prov("openai-pricing", ev, { location: loc, dateRule: "undated" }),
          });
        }
      }
    } else {
      // The text after the price may sit in the cell's `<small>` (2026-11-23) or in the cell.
      const full = [row.cost, row.small].filter((x) => x !== null && x !== "").join(" ");
      if (!mapped.cost.test(full)) {
        ctx.readings.rate({
          modelId: row.details,
          tier: TIER_STANDARD,
          component: mapped.component,
          fact: {
            disposition: "unsupported",
            reason: `the ${row.details} cell reads ${JSON.stringify(full)}`,
          },
          outcome: "needs-review",
          reasons: [{ code: "structure", message: `the ${row.details} cost cell changed` }],
          provenance: prov("openai-pricing", ev, { location: loc }),
        });
        continue;
      }
      for (const id of ctx.scope.models.keys()) {
        for (const condition of [
          { inputTokens: { lte: boundary } },
          { inputTokens: { gt: boundary } },
        ]) {
          ctx.readings.rate({
            modelId: id,
            tier: TIER_STANDARD,
            component: mapped.component,
            fact: { disposition: "unsupported", reason: mapped.reason },
            condition,
            provenance: prov("openai-pricing", ev, { location: loc, dateRule: "undated" }),
          });
        }
      }
    }
  }
  // Every component needs one row, under any of the names the page has given it.
  const listed = new Set([...seen].map((key) => TOOL_MAP.get(key)?.component));
  const reported = new Set<string>();
  for (const [key, mapped] of TOOL_MAP) {
    if (!listed.has(mapped.component) && !reported.has(mapped.component)) {
      reported.add(mapped.component);
      ctx.readings.review({}, [
        { code: "structure", message: `the Tools table no longer lists '${key.split("|")[1]}'` },
      ]);
    }
  }
}

// ---------- page-level checks ----------

const EXPECTED_H2 = new Set([
  "text-tokens",
  "cyber-models",
  "life-sciences-models",
  "legal-model-configurations",
  "image-tokens",
  "built-in-tools",
  "specialized-models",
  "fine-tuning",
  "cloud-platforms",
]);
const EXPECTED_H3 = new Set([
  "audio",
  "live-session-duration",
  "audio-tokens",
  "image-generation",
  "transcription-and-speech",
]);
const KNOWN_EXPORTS = new Set([
  "default",
  "GroupedPricingTable",
  "TextTokenPricingTables",
  "PricingTable",
]);

/** Every heading id and pricing component on the page is one the reader knows. */
function checkPageStructure(ev: Evidence, ctx: Ctx): void {
  for (const m of ev.text.matchAll(/<h([23])[^>]*id="([^"]+)"/g)) {
    const id = m[2] ?? "";
    const known = (m[1] === "2" ? EXPECTED_H2 : EXPECTED_H3).has(id);
    if (!known && !id.startsWith("header-") && !id.startsWith("docs-")) {
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `a new pricing-page section '${id}' (h${m[1]}) this reader does not cover`,
        },
      ]);
    }
  }
  for (const id of EXPECTED_H2) {
    if (!ev.text.includes(`id="${id}"`)) {
      ctx.readings.review({}, [
        { code: "structure", message: `the pricing-page section '${id}' is missing` },
      ]);
    }
  }
  for (const m of ev.text.matchAll(/component-export="([^"]+)"/g)) {
    if (!KNOWN_EXPORTS.has(m[1] ?? "")) {
      ctx.readings.review({}, [
        { code: "structure", message: `an unknown pricing component '${m[1]}' on the page` },
      ]);
    }
  }
  // A tracked model priced outside the Flagship section needs review.
  const start = ev.text.indexOf('id="text-tokens"');
  const end = ev.text.indexOf('id="cyber-models"', start);
  for (const id of ctx.scope.models.keys()) {
    const re = new RegExp(`(?<![-\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-\\w])`, "g");
    for (const m of ev.text.matchAll(re)) {
      const pos = m.index ?? 0;
      const inFlagship = start >= 0 && end >= 0 && pos >= start && pos < end;
      if (!inFlagship) {
        // Nav links and model names like gpt-6-astra-law are not prices; a price-table
        // mention is. Only flag the mention when it sits in a pricing table cell.
        const around = ev.text.slice(Math.max(0, pos - 400), pos + 400);
        if (/<t[dh][ >]/.test(around) || /\$\d/.test(around)) {
          ctx.readings.review({ modelId: id }, [
            {
              code: "structure",
              message: `${id} appears in a pricing context outside the Flagship section`,
            },
          ]);
          break;
        }
      }
    }
  }
}

// ---------- GET /v1/models ----------

interface OpenaiApiModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
}

/** `GET /v1/models` — model readings from exact JSON item citations. */
export function readOpenaiApi(pages: ApiPage<unknown>[], ctx: Ctx): void {
  for (const { evidence: ev, json } of pages) {
    src(ctx, "openai-models-api", ev);
    const items = asArray(asObject(json, "GET /v1/models").data, "GET /v1/models › data");
    const text = ev.text;
    // jsonArraySpans returns char spans of ev.text; citations are byte spans.
    const spans = jsonArraySpans(text, "data").map((s) => ({
      start: ev.byteOffset(s.start),
      end: ev.byteOffset(s.end),
      charStart: s.start,
      charEnd: s.end,
    }));
    items.forEach((item, i) => {
      const span = spans[i];
      // The cited bytes must decode to exactly the item being read — never a lookalike.
      if (
        span !== undefined &&
        !isDeepStrictEqual(JSON.parse(text.slice(span.charStart, span.charEnd)), item)
      ) {
        throw new ReaderBug(`data[${i}]'s cited span does not decode to the item`);
      }
      const model = asObject(item, `data[${i}]`) as OpenaiApiModel;
      if (model.object !== "model") {
        ctx.readings.review({}, [
          {
            code: "structure",
            message: `data[${i}].object is ${JSON.stringify(model.object)}, expected "model"`,
          },
        ]);
        return;
      }
      if (typeof model.id !== "string") {
        ctx.readings.review({}, [{ code: "structure", message: `data[${i}].id is not a string` }]);
        return;
      }
      const id = model.id;
      const location =
        span !== undefined
          ? ev.cite(
              `GET /v1/models › data[${i}]`,
              span.start,
              ev.bytes.subarray(span.start, span.end).toString("utf8"),
            )
          : undefined;
      ctx.readings.model({
        modelId: id,
        status: "available",
        provenance: prov("openai-models-api", ev, {
          ...(location !== undefined ? { location } : {}),
        }),
      });
    });
  }
}

// ---------- the read ----------

export function readOpenai(
  sources: OpenaiSources,
  scope: TrackedScope,
  apiPages: ApiPage<unknown>[] = [],
): OpenaiResult {
  const readings = new Readings(PROVIDER);
  const ctx: Ctx = { scope, readings, sources: [] };
  const facts = new Map<string, ModelPageFacts>();

  if (sources.modelPage !== undefined) {
    for (const id of scope.models.keys()) {
      const ev = sources.modelPage(id);
      if (ev === undefined) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: "fetch-failed", message: `no saved model page for ${id}` }],
          modelId: id,
          source: "openai-model-page",
        });
        continue;
      }
      src(ctx, "openai-model-page", ev);
      try {
        facts.set(id, readOpenaiModelPage(ev, id, ctx));
      } catch (error) {
        if (error instanceof NeedsReview) {
          readings.review({ modelId: id }, [{ code: error.code, message: error.message }]);
        } else if (error instanceof Unreadable) {
          readings.observe({
            outcome: "unreadable",
            reasons: [{ code: error.code, message: error.message }],
            modelId: id,
            source: "openai-model-page",
          });
        } else {
          throw error;
        }
      }
    }
  }

  if (sources.pricing !== undefined) {
    const ev = sources.pricing;
    src(ctx, "openai-pricing", ev);
    try {
      checkPageStructure(ev, ctx);
      const flagship = readFlagship(ev, ctx);
      const seen = new Set<string>();
      for (const row of flagship.standard.rows) {
        const id = bareName(row.name);
        if (!scope.models.has(id)) continue;
        seen.add(id);
        if (row.deprecated === true) {
          // A deprecation is a lifecycle fact the page states in a form this reader does not read.
          readings.review({ modelId: id }, [
            {
              code: "structure",
              message: `the pricing page marks the row '${id}' deprecated; its rates and lifecycle are left for a person`,
            },
          ]);
          continue;
        }
        const f = facts.get(id);
        const checksOk =
          f !== undefined ? verifyChecks(ev, flagship.standard, row, id, f, ctx) : true;
        emitStandardRow(ev, flagship.standard, row, id, f, flagship.boundary, ctx, !checksOk);
        if (f !== undefined && f.longContext === undefined) {
          readings.review({ modelId: id }, [
            {
              code: "structure",
              message: `the model page does not state the >${flagship.boundary / 1000}K surcharge; long-context rates cannot be derived`,
            },
          ]);
        }
      }
      for (const id of scope.models.keys()) {
        if (!seen.has(id)) {
          readings.review({ modelId: id }, [
            {
              code: "missing-model",
              message: `${id} is not in the Flagship models Standard table`,
            },
          ]);
        }
      }
      readTools(ev, flagship.boundary, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `openai-pricing: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "openai-pricing",
        });
      } else {
        throw error;
      }
    }
  }

  if (apiPages.length > 0) {
    try {
      readOpenaiApi(apiPages, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `openai-models-api: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "openai-models-api",
        });
      } else {
        throw error;
      }
    }
  }

  return { readings: readings.all, sources: ctx.sources };
}
