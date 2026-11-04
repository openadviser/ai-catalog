// The Anthropic reader.
//
// Sources of truth (docs/sources.md):
//   anthropic-pricing     platform.claude.com/docs/en/about-claude/pricing.md — the model
//                         pricing table, its footnotes, the prompt-cache multipliers, the
//                         Batch table and discount, fast mode, data residency, tool prices.
//   anthropic-models      .../about-claude/models/overview.md — the comparison table
//                         (API ids, default effort, retirement floors) and the legacy list.
//   anthropic-model-page  .../models/<slug>/overview.md — a tracked model absent from the
//                         comparison table (today: Claude Sonnet 5).
//   anthropic-effort      .../build-with-claude/effort.md — the levels table and the
//                         per-model recommended blocks.
//   anthropic-models-api  GET /v1/models — capabilities.effort per level, verified per
//                         model; lifecycle. A list never retires a model.
//
// Every price fact carries the complete identity of plan §11.2.3; anything the reader
// does not understand in tracked scope is needs-review, never a guessed amount.
import { isDeepStrictEqual } from "node:util";
import {
  type Anchor,
  type ApiPage,
  asArray,
  asObject,
  type Condition,
  type DerivationInput,
  derive,
  type Evidence,
  eqDecimal,
  expectColumns,
  type FootnoteDef,
  footnoteDefs,
  type Instant,
  jsonArraySpans,
  jsonFieldSpan,
  type Location,
  MarkdownPage,
  mulDecimal,
  NeedsReview,
  type Provenance,
  provenance,
  ReaderBug,
  type ReaderId,
  type Reading,
  Readings,
  type TableRow,
  type TrackedScope,
  Unreadable,
} from "@openadviser/ai-catalog-readers-kit";

export const READER: ReaderId = { name: "anthropic", version: "0.1.0" };

export const ANTHROPIC_URLS = {
  pricing: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  models: "https://platform.claude.com/docs/en/about-claude/models/overview.md",
  effort: "https://platform.claude.com/docs/en/build-with-claude/effort.md",
  apiModels: "https://api.anthropic.com/v1/models",
} as const;

/** The model-page URL an overview slug maps to (".md" appended for the evidence). */
export function modelPageUrl(slug: string): string {
  return `https://platform.claude.com/docs/en/models/${slug}/overview.md`;
}

/** The model-page URL for every tracked model — what a live read fetches and stores. */
export function anthropicModelPageUrls(scope: TrackedScope): { id: string; url: string }[] {
  return [...scope.models.keys()].map((id) => ({
    id,
    url: modelPageUrl(id.replace(/^claude-/, "")),
  }));
}

const PROVIDER = "anthropic";
const TIER_STANDARD = "anthropic:standard";
const TIER_BATCH = "anthropic:batch";
const TIER_NOT_IN_SCHEMA = "tier not in schema 1.0.0";

export interface AnthropicSources {
  pricing: Evidence;
  models: Evidence;
  effort: Evidence;
  /** Per-model overview pages for tracked models outside the comparison table. */
  modelPage?: (modelId: string) => Evidence | undefined;
}

export interface AnthropicResult {
  readings: Reading[];
  /** The source keys read, with their evidence, in consumption order. */
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

interface Ctx {
  scope: TrackedScope;
  readings: Readings;
  sources: AnthropicResult["sources"];
}

function src(ctx: Ctx, source: string, ev: Evidence): void {
  ctx.sources.push({ source, url: ev.url, evidence: ev.sha256, retrievedAt: ev.retrievedAt });
}

function prov(source: string, ev: Evidence, extra: Parameters<typeof provenance>[3]): Provenance {
  return provenance(source, ev, `${READER.name}@${READER.version}`, extra);
}

// ---------- model names ----------

const NAME_RE = /^Claude (Opus|Sonnet|Haiku|Fable|Mythos) ([0-9]+(?:\.[0-9]+)?|Preview)$/;
const KNOWN_LINES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

/** "Claude Sonnet 5.5" → `claude-sonnet-5-5`; "Claude Mythos Preview" → `claude-mythos-preview`. */
function idFromName(name: string): string | null {
  const m = NAME_RE.exec(name);
  if (m === null) return null;
  const line = (m[1] ?? "").toLowerCase();
  if (!KNOWN_LINES.has(line)) return null;
  const version = (m[2] ?? "") === "Preview" ? "preview" : (m[2] ?? "").replace(".", "-");
  return `claude-${line}-${version}`;
}

interface ParsedName {
  /** The model name without qualifiers or link markup. */
  name: string;
  id: string | null;
  /** Parenthesised qualifier, with link markup reduced to its label. */
  qualifier: string | null;
  /** The link target a qualifier carried, when it was a markdown link. */
  qualifierHref: string | null;
}

function parseNameCell(text: string): ParsedName {
  const t = text.trim();
  const paren = /^(.*?)\s*\((.*)\)\s*$/.exec(t);
  let name = t;
  let qualifier: string | null = null;
  let href: string | null = null;
  if (paren !== null && paren[2] !== undefined) {
    name = (paren[1] ?? "").trim();
    const inner = paren[2];
    const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(inner.trim());
    if (link !== null) {
      qualifier = link[1] ?? null;
      href = link[2] ?? null;
    } else {
      qualifier = inner.trim();
    }
  }
  return { name, id: idFromName(name), qualifier, qualifierHref: href };
}

/** A row's `(for prompts …)` qualifier becomes the rate's condition. */
function conditionFromQualifier(qualifier: string | null, where: string): Condition | undefined {
  if (qualifier === null) return undefined;
  const m = /^for prompts (up to|over) ([0-9,]+) tokens$/.exec(qualifier);
  if (m === null) {
    throw new NeedsReview(
      "structure",
      `${where}: qualifier ${JSON.stringify(qualifier)} is not understood`,
    );
  }
  const tokens = Number(m[2]?.replace(/,/g, ""));
  if (m[1] === "up to") return { inputTokens: { lte: tokens } };
  return { inputTokens: { gt: tokens } };
}

// ---------- price cells ----------

interface PriceCell {
  amount: string;
  suprefs: number[];
}

/** A `$N[.N][ USD] / MTok` cell, after its footnote markers are lifted out. */
function parsePriceCell(text: string, where: string): PriceCell {
  const suprefs: number[] = [];
  const stripped = text.replace(/<sup>\s*([0-9]+)[^<]*<\/sup>/g, (_m, n: string) => {
    suprefs.push(Number(n));
    return "";
  });
  const m = /^\$([0-9]+(?:\.[0-9]+)?)\s*(?:USD\s*)?\/\s*MTok$/.exec(stripped.trim());
  if (m === null)
    throw new NeedsReview("bad-amount", `${where}: ${JSON.stringify(text)} is not a $/MTok price`);
  return { amount: m[1] ?? "", suprefs };
}

// ---------- the pricing page ----------

const MODEL_COLUMNS = [
  "Model",
  "Base input tokens",
  "5m cache writes",
  "1h cache writes",
  "Cache hits and refreshes",
  "Output tokens",
];
const BATCH_COLUMNS = ["Model", "Batch input", "Batch output"];
const FAST_COLUMNS = ["Model", "Input", "Output"];
const CACHE_OP_COLUMNS = ["Cache operation", "Multiplier", "Duration"];

const FOOTNOTE_SPECS = [
  {
    n: 1,
    text: /^Cache hits and refreshes on Claude Fable 5\.1 and Claude Mythos 5\.1 are priced at 0\.025x the base input price\.$/,
  },
  {
    n: 2,
    text: /^Cache hits and refreshes on Claude Opus 5\.5 and Claude Sonnet 5\.5 are priced at 0\.05x the base input price\.$/,
  },
  {
    n: 3,
    text: /^The \$2\/\$10 per million input\/output token pricing for Claude Sonnet 5, announced at launch as introductory pricing through August 31, 2026, is now the standard price\. The previously scheduled increase to \$3\/\$15 per million input\/output tokens on September 1, 2026 will not occur\.$/,
  },
];

const STACKING_SENTENCE =
  "These multipliers stack with other pricing modifiers, including the Batch API discount and data residency.";
const BATCH_DISCOUNT_SENTENCE =
  "The Batch API allows asynchronous processing of large volumes of requests with a 50 percent discount on both input and output tokens.";
const RESIDENCY_SENTENCE =
  "For Claude 4.6 and later models, specifying US-only inference through the `inference_geo` parameter incurs a 1.1x multiplier on all token pricing categories, including input tokens, output tokens, cache writes, and cache reads.";
const LONG_CONTEXT_SENTENCE = "a request whose prompt is over 100,000 tokens pays higher prices";
const LONG_CONTEXT_INPUTS_SENTENCE =
  "counts all of its input tokens, including cache reads and cache writes";
const CONDITION_INPUTS = ["input", "input_cached", "cache_write_5m", "cache_write_1h"];

const EXPECTED_FEATURE_SECTIONS = new Set([
  "Prompt caching",
  "Data residency pricing",
  "Fast mode pricing",
  "Batch processing",
  "Long context pricing",
  "Tool use pricing",
  "Specific tool pricing",
]);
const EXPECTED_TOOL_SECTIONS = new Set([
  "Bash tool",
  "Code execution tool",
  "Text editor tool",
  "Web search tool",
  "Web fetch tool",
  "Computer use tool",
  "Browser use tool",
]);

interface RowFacts {
  name: string;
  id: string | null;
  tracked: boolean;
  condition: Condition | undefined;
  retired: boolean;
  /** The stated standard cells, for derivations and the consistency check. */
  cells: Map<string, { amount: string; suprefs: number[]; excerpt: Location }>;
  row: TableRow;
}

function footnoteReason(sup: number, where: string): { code: string; message: string } {
  return {
    code: "unknown-footnote",
    message: `${where} cites footnote ${sup}, which this reader does not understand`,
  };
}

export function readAnthropicPricing(ev: Evidence, ctx: Ctx): void {
  const page = new MarkdownPage(ev);
  const where = "## Model pricing";

  // ---- the model pricing table ----
  const table = page.tableUnder(2, "Model pricing");
  if (table === undefined)
    throw new Unreadable("wrong-document", "no table under ## Model pricing");
  expectColumns(table, MODEL_COLUMNS);
  const headingAnchor = ev.anchor("## Model pricing");
  const headerAnchor: Anchor = {
    offset: page.lines[table.headerLine]?.offset ?? table.offset,
    excerpt: page.lines[table.headerLine]?.text ?? "",
  };
  const colIndex = new Map(MODEL_COLUMNS.map((c, i) => [c, i]));

  // Footnote definitions live between the table and the `* **MTok:` key bullets.
  const defs = footnoteDefs(page, table.rows.at(-1)?.line ?? table.headerLine);
  const understood = new Map<number, FootnoteDef>();
  const unknownDefs: FootnoteDef[] = [];
  for (const def of defs) {
    if (FOOTNOTE_SPECS.some((s) => s.n === def.n && s.text.test(def.text)))
      understood.set(def.n, def);
    else unknownDefs.push(def);
  }

  // The cache-read multipliers the footnotes state. Default 0.1x; footnotes 1 and 2
  // name the models they change it for.
  const cacheReadMult = new Map<string, string>();
  const def1 = understood.get(1);
  if (def1 !== undefined) {
    for (const id of ["claude-fable-5-1", "claude-mythos-5-1"]) cacheReadMult.set(id, "0.025");
  }
  const def2 = understood.get(2);
  if (def2 !== undefined) {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"]) cacheReadMult.set(id, "0.05");
  }

  const rows: RowFacts[] = [];
  for (const row of table.rows) {
    const parsed = parseNameCell(row.cells[0]?.text ?? "");
    const tracked = parsed.id !== null && ctx.scope.models.has(parsed.id);
    let condition: Condition | undefined;
    let retired = false;
    if (parsed.qualifier !== null) {
      if (/^retired\b/.test(parsed.qualifier)) {
        retired = true;
      } else if (parsed.qualifier === "limited availability") {
        // understood: an access note, not a price condition
      } else {
        condition = conditionFromQualifier(parsed.qualifier, `${where} › row '${parsed.name}'`);
      }
    }
    const cells = new Map<string, { amount: string; suprefs: number[]; excerpt: Location }>();
    for (const col of MODEL_COLUMNS.slice(1)) {
      const cell = row.cells[colIndex.get(col) ?? 0];
      if (cell === undefined)
        throw new NeedsReview(
          "structure",
          `${where} › row '${parsed.name}': missing column ${col}`,
        );
      const price = parsePriceCell(cell.text, `${where} › row '${parsed.name}' › column '${col}'`);
      cells.set(col, {
        ...price,
        excerpt: ev.cite(
          `${where} › row '${parsed.name}' › column '${col}'`,
          row.offset,
          row.text,
          [headingAnchor, headerAnchor],
        ),
      });
    }
    rows.push({ name: parsed.name, id: parsed.id, tracked, condition, retired, cells, row });
  }

  // A tracked model must appear; an unknown footnote definition fails closed, and a
  // footnote marker on any cell must be one the reader understands.
  for (const id of ctx.scope.models.keys()) {
    if (!rows.some((r) => r.id === id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `tracked model ${id} has no row in the model pricing table`,
        },
      ]);
    }
  }
  for (const def of unknownDefs) {
    ctx.readings.review(
      {},
      [footnoteReason(def.n, `${where} footnotes`)],
      `the page defines footnote ${def.n} this reader does not understand`,
      prov("anthropic-pricing", ev, {
        location: ev.cite(`${where} › footnotes`, def.offset, def.line),
      }),
    );
  }

  // ---- prompt-cache multiplier table + the stacking sentence ----
  const multTable = page.tableUnder(3, "Prompt caching");
  if (multTable === undefined)
    throw new Unreadable("wrong-document", "no multiplier table under ### Prompt caching");
  expectColumns(multTable, CACHE_OP_COLUMNS);
  const multipliers = new Map<
    string,
    { mult: string; row: TableRow; overrides: Map<string, string> }
  >();
  for (const row of multTable.rows) {
    const op = row.cells[0]?.text ?? "";
    const cell = row.cells[1]?.text ?? "";
    const m = /^([0-9.]+)x base input price(?: \((.*)\))?$/.exec(cell);
    if (m === null)
      throw new NeedsReview(
        "structure",
        `### Prompt caching › '${op}': multiplier ${JSON.stringify(cell)} not understood`,
      );
    const overrides = new Map<string, string>();
    for (const part of (m[2] ?? "").split(";")) {
      if (part.trim() === "") continue;
      const om = /^([0-9.]+)x on (.+)$/.exec(part.trim());
      if (om === null)
        throw new NeedsReview(
          "structure",
          `### Prompt caching › '${op}': override ${JSON.stringify(part)} not understood`,
        );
      for (const name of splitModelList(om[2] ?? "")) {
        const oid = idFromName(name);
        if (oid === null)
          throw new NeedsReview(
            "structure",
            `### Prompt caching › '${op}': model name ${JSON.stringify(name)} not understood`,
          );
        overrides.set(oid, om[1] ?? "");
      }
    }
    multipliers.set(op, { mult: m[1] ?? "", row, overrides });
  }
  for (const op of ["5-minute cache write", "1-hour cache write", "Cache read (hit)"]) {
    if (!multipliers.has(op))
      throw new NeedsReview("structure", `### Prompt caching: no '${op}' row`);
  }
  // The unnumbered "*<sup>All other models…" note restates the standard cache-read
  // multiplier; it must agree with the multiplier table, else the page contradicts itself.
  const allOthers =
    /\*<sup>All other models use the standard ([0-9.]+)x multiplier\.<\/sup>\*/.exec(ev.text);
  const cacheReadSpec = multipliers.get("Cache read (hit)");
  if (allOthers === null) {
    ctx.readings.review({}, [
      {
        code: "structure",
        message: 'the "all other models" cache multiplier note is missing or changed',
      },
    ]);
  } else if (cacheReadSpec !== undefined && allOthers[1] !== cacheReadSpec.mult) {
    ctx.readings.review({}, [
      {
        code: "structure",
        message: `the "all other models" note says ${allOthers[1]}x but the multiplier table says ${cacheReadSpec.mult}x`,
      },
    ]);
  }

  const stackingOffset = ev.offsetOf(STACKING_SENTENCE);
  if (stackingOffset < 0)
    throw new NeedsReview(
      "structure",
      "the prompt-cache multipliers' stacking statement is missing or changed",
    );
  const batchDiscountOffset = ev.offsetOf(BATCH_DISCOUNT_SENTENCE);
  if (batchDiscountOffset < 0)
    throw new NeedsReview(
      "structure",
      "the 50 percent Batch discount statement is missing or changed",
    );

  // ---- data residency (spec §15): understood, not modelled ----
  const residencyOffset = ev.offsetOf(RESIDENCY_SENTENCE);
  if (residencyOffset < 0) {
    ctx.readings.review({}, [
      { code: "structure", message: "the inference_geo 1.1x statement is missing or changed" },
    ]);
  } else {
    ctx.readings.observe({
      outcome: "ok",
      reasons: [],
      component: "inference_geo",
      note: 'US-only inference (inference_geo "us") is priced at 1.1x on all token categories and stacks with Batch; anthropic:standard and anthropic:batch require global routing (spec §15), so no rate is emitted for it.',
      provenance: prov("anthropic-pricing", ev, {
        location: ev.cite("### Data residency pricing", residencyOffset, RESIDENCY_SENTENCE, [
          ev.anchor("### Data residency pricing"),
        ]),
      }),
    });
  }

  // ---- long context: the haiku condition's scope ----
  if (ev.offsetOf(LONG_CONTEXT_SENTENCE) < 0 || ev.offsetOf(LONG_CONTEXT_INPUTS_SENTENCE) < 0) {
    ctx.readings.review({ modelId: "claude-haiku-5-5" }, [
      {
        code: "structure",
        message:
          "the long-context condition or its input-token scope statement is missing or changed",
      },
    ]);
  }
  const longContextOk =
    ev.offsetOf(LONG_CONTEXT_SENTENCE) >= 0 && ev.offsetOf(LONG_CONTEXT_INPUTS_SENTENCE) >= 0;

  // ---- emit standard-tier facts ----
  for (const row of rows) {
    const id = row.id;
    const nameFor = id ?? row.name;
    // A model name the reader cannot map to an id is never priced silently.
    const noId = id === null;
    const emit = (component: string, col: string): void => {
      const cell = row.cells.get(col);
      if (cell === undefined) return;
      const badSup = cell.suprefs.filter((n) => !understood.has(n));
      const location = cell.excerpt;
      const anchors = location.anchors ?? [];
      location.anchors = anchors;
      for (const n of cell.suprefs) {
        const def = understood.get(n);
        if (def !== undefined) anchors.push({ offset: def.offset, excerpt: def.line });
      }
      if (noId || badSup.length > 0 || (row.condition !== undefined && !longContextOk)) {
        ctx.readings.rate({
          modelId: nameFor,
          tier: TIER_STANDARD,
          component,
          fact: {
            disposition: "priced",
            unit: "token",
            per: 1_000_000,
            amount: cell.amount,
            currency: "USD",
          },
          ...(row.condition !== undefined
            ? { condition: row.condition, conditionInputs: CONDITION_INPUTS }
            : {}),
          outcome: "needs-review",
          reasons: [
            ...(noId
              ? [
                  {
                    code: "structure",
                    message: `model name ${JSON.stringify(row.name)} does not map to an id`,
                  },
                ]
              : []),
            ...badSup.map((n) =>
              footnoteReason(n, `${where} › row '${row.name}' › column '${col}'`),
            ),
            ...(row.condition !== undefined && !longContextOk
              ? [
                  {
                    code: "structure",
                    message:
                      "the long-context scope statement changed; the condition's inputs are unverified",
                  },
                ]
              : []),
          ],
          provenance: prov("anthropic-pricing", ev, { location, dateRule: "undated" }),
        });
        return;
      }
      const notes: string[] = [];
      if (row.name === "Claude Sonnet 5" && cell.suprefs.includes(3)) {
        notes.push(
          "Footnote 3: the introductory $2/$10 is now the standard price and the scheduled increase will not occur, so there is no dated step.",
        );
      }
      const extra: Parameters<typeof provenance>[3] = { location, dateRule: "undated" };
      if (notes.length > 0) extra.note = notes.join(" ");
      ctx.readings.rate({
        modelId: id,
        tier: TIER_STANDARD,
        component,
        fact: {
          disposition: "priced",
          unit: "token",
          per: 1_000_000,
          amount: cell.amount,
          currency: "USD",
        },
        ...(row.condition !== undefined
          ? { condition: row.condition, conditionInputs: CONDITION_INPUTS }
          : {}),
        provenance: prov("anthropic-pricing", ev, extra),
      });
    };
    emit("input", "Base input tokens");
    emit("cache_write_5m", "5m cache writes");
    emit("cache_write_1h", "1h cache writes");
    emit("input_cached", "Cache hits and refreshes");
    emit("output", "Output tokens");

    // The stated cache cells must equal input × the page's own multipliers; a page that
    // contradicts itself on a row's price fails closed.
    if (id !== null) {
      const input = row.cells.get("Base input tokens");
      const cacheMult = multipliers.get("Cache read (hit)");
      if (cacheMult === undefined)
        throw new ReaderBug("no Cache read (hit) multiplier after the table check");
      const read = cacheMult.overrides.get(id) ?? cacheReadMult.get(id) ?? cacheMult.mult;
      for (const [col, op] of [
        ["5m cache writes", "5-minute cache write"],
        ["1h cache writes", "1-hour cache write"],
        ["Cache hits and refreshes", "Cache read (hit)"],
      ] as const) {
        const stated = row.cells.get(col);
        const spec = multipliers.get(op);
        const mult = op === "Cache read (hit)" ? read : spec?.mult;
        if (stated === undefined || input === undefined || spec === undefined || mult === undefined)
          continue;
        const expected = mulDecimal(mult, input.amount);
        if (!eqDecimal(expected, stated.amount)) {
          ctx.readings.review({ modelId: id }, [
            {
              code: "structure",
              message: `${where} › row '${row.name}' › column '${col}': stated ${stated.amount} ≠ ${mult} × ${input.amount}; the page contradicts its multiplier`,
            },
          ]);
        }
      }
    }
  }

  // ---- fast mode: a tier the schema does not model ----
  const fast = page.tableUnder(3, "Fast mode pricing", { required: false });
  if (fast !== undefined) {
    expectColumns(fast, FAST_COLUMNS);
    for (const row of fast.rows) {
      const names = (row.cells[0]?.text ?? "").split(" / ").map((s) => s.trim());
      const ids = names.map((n) => ({ name: n, id: idFromName(n) }));
      for (const { name, id } of ids) {
        if (id === null) {
          ctx.readings.review({ tier: "fast mode" }, [
            {
              code: "structure",
              message: `fast mode row names ${JSON.stringify(name)}, which does not map to an id`,
            },
          ]);
          continue;
        }
        if (ctx.scope.models.has(id)) {
          ctx.readings.review(
            { modelId: id, tier: "anthropic:fast" },
            [{ code: "tier-not-in-schema", message: TIER_NOT_IN_SCHEMA }],
            `fast mode is priced for ${name} but is not a schema 1.0.0 tier`,
            prov("anthropic-pricing", ev, {
              location: ev.cite("### Fast mode pricing › table", row.offset, row.text, [
                ev.anchor("### Fast mode pricing"),
              ]),
            }),
          );
        }
      }
      for (const col of ["Input", "Output"]) {
        const cell = row.cells[FAST_COLUMNS.indexOf(col)]?.text ?? "";
        parsePriceCell(cell, `### Fast mode pricing › '${row.cells[0]?.text}' › ${col}`);
      }
    }
  } else {
    ctx.readings.review({}, [
      { code: "structure", message: "no table under ### Fast mode pricing" },
    ]);
  }

  // ---- the Batch table and the derived cache prices ----
  const batch = page.tableUnder(3, "Batch processing");
  if (batch === undefined)
    throw new Unreadable("wrong-document", "no table under ### Batch processing");
  expectColumns(batch, BATCH_COLUMNS);
  const batchHeading = ev.anchor("### Batch processing");
  const batchHeader: Anchor = {
    offset: page.lines[batch.headerLine]?.offset ?? batch.offset,
    excerpt: page.lines[batch.headerLine]?.text ?? "",
  };
  const stackingAnchor = ev.cite(
    "### Prompt caching › the multipliers stack with the Batch API discount",
    stackingOffset,
    STACKING_SENTENCE,
  );
  const discountAnchor = ev.cite(
    "### Batch processing › the 50 percent discount",
    batchDiscountOffset,
    BATCH_DISCOUNT_SENTENCE,
  );

  const batchSeen = new Set<string>();
  for (const row of batch.rows) {
    const parsed = parseNameCell(row.cells[0]?.text ?? "");
    const id = parsed.id;
    if (id !== null) batchSeen.add(id);
    let condition: Condition | undefined;
    if (
      parsed.qualifier !== null &&
      !/^retired\b/.test(parsed.qualifier) &&
      parsed.qualifier !== "limited availability"
    ) {
      condition = conditionFromQualifier(
        parsed.qualifier,
        `### Batch processing › row '${parsed.name}'`,
      );
    }
    const inputs: { cell: string; component: string }[] = [
      { cell: "Batch input", component: "input" },
      { cell: "Batch output", component: "output" },
    ];
    for (const { cell, component } of inputs) {
      const cellObj = row.cells[BATCH_COLUMNS.indexOf(cell)];
      const price = parsePriceCell(
        cellObj?.text ?? "",
        `### Batch processing › row '${parsed.name}' › ${cell}`,
      );
      const badSup = price.suprefs.filter((n) => !understood.has(n));
      const supAnchors: Anchor[] = [];
      for (const n of price.suprefs) {
        const def = understood.get(n);
        if (def !== undefined) supAnchors.push({ offset: def.offset, excerpt: def.line });
      }
      const reasons = [
        ...(id === null
          ? [
              {
                code: "structure",
                message: `model name ${JSON.stringify(parsed.name)} does not map to an id`,
              },
            ]
          : []),
        ...(condition !== undefined && !longContextOk
          ? [
              {
                code: "structure",
                message:
                  "the long-context scope statement changed; the condition's inputs are unverified",
              },
            ]
          : []),
        ...(badSup.length > 0
          ? [
              {
                code: "unknown-footnote",
                message: `footnote marker(s) ${badSup.join(", ")} on '${cell}' have no understood definition`,
              },
            ]
          : []),
      ];
      ctx.readings.rate({
        modelId: id ?? parsed.name,
        tier: TIER_BATCH,
        component,
        fact: {
          disposition: "priced",
          unit: "token",
          per: 1_000_000,
          amount: price.amount,
          currency: "USD",
        },
        ...(condition !== undefined ? { condition, conditionInputs: CONDITION_INPUTS } : {}),
        ...(reasons.length > 0 ? { outcome: "needs-review" as const, reasons } : {}),
        provenance: prov("anthropic-pricing", ev, {
          location: ev.cite(
            `### Batch processing › table › row '${parsed.name}' › column '${cell}'`,
            row.offset,
            row.text,
            [batchHeading, batchHeader, ...supAnchors],
          ),
          dateRule: "undated",
        }),
      });
    }

    // The derived cache prices: the page's multipliers stacked with the 50% discount.
    const std = rows.find((r) => r.id === id && sameCondition(r.condition, condition));
    const baseInput = std?.cells.get("Base input tokens");
    if (id !== null && std !== undefined && baseInput !== undefined) {
      for (const [component, op, multOf] of [
        ["cache_write_5m", "5-minute cache write", "mult"],
        ["cache_write_1h", "1-hour cache write", "mult"],
        ["input_cached", "Cache read (hit)", "model"],
      ] as const) {
        const spec = multipliers.get(op);
        if (spec === undefined) continue;
        const mult =
          multOf === "model"
            ? (spec.overrides.get(id) ?? cacheReadMult.get(id) ?? spec.mult)
            : spec.mult;
        // The derived amount at its natural scale — exact, never rounded. An
        // unresolved footnote on the base input propagates: a derivation from an
        // unverified premise is needs-review, not ok.
        const baseBad = baseInput.suprefs.filter((n) => !understood.has(n));
        const amount = mulDecimal(mulDecimal(mult, "0.5"), baseInput.amount);
        const formula = `${mult} × $${baseInput.amount} (${parsed.name} base input) × 0.5 (Batch API discount) = $${amount} per MTok`;
        const di: DerivationInput[] = [
          {
            evidence: ev.sha256,
            url: ev.url,
            path: `## Model pricing › row '${parsed.name}' › column 'Base input tokens' ($${baseInput.amount} / MTok)`,
            offset: std.row.offset,
            excerpt: std.row.text,
          },
          {
            evidence: ev.sha256,
            url: ev.url,
            path: "### Prompt caching › multiplier table › row for this operation",
            offset: spec.row.offset,
            excerpt: spec.row.text,
          },
          {
            evidence: ev.sha256,
            url: ev.url,
            path: stackingAnchor.path,
            offset: stackingAnchor.offset,
            excerpt: stackingAnchor.excerpt,
          },
          {
            evidence: ev.sha256,
            url: ev.url,
            path: discountAnchor.path,
            offset: discountAnchor.offset,
            excerpt: discountAnchor.excerpt,
          },
        ];
        ctx.readings.rate({
          modelId: id,
          tier: TIER_BATCH,
          component,
          fact: { disposition: "priced", unit: "token", per: 1_000_000, amount, currency: "USD" },
          ...(baseBad.length > 0
            ? {
                outcome: "needs-review" as const,
                reasons: [
                  {
                    code: "unknown-footnote",
                    message: `the derivation's base input carries unresolved footnote marker(s) ${baseBad.join(", ")}`,
                  },
                ],
              }
            : {}),
          ...(condition !== undefined ? { condition, conditionInputs: CONDITION_INPUTS } : {}),
          provenance: prov("anthropic-pricing", ev, {
            derivation: derive(formula, di, [ev]),
            dateRule: "undated",
            note: `The Batch table states input and output only; this ${component === "input_cached" ? "cache hit" : `${component === "cache_write_5m" ? "5-minute" : "1-hour"} cache write`} price is derived from the page's own multipliers.`,
          }),
        });
      }
    } else if (id !== null) {
      ctx.readings.review({ modelId: id, tier: TIER_BATCH }, [
        {
          code: "structure",
          message: `Batch row '${parsed.name}' has no matching model-pricing row; the cache derivations cannot be made`,
        },
      ]);
    }

    // Tool prices on Batch: none stated → unsupported for each row.
    if (id !== null) emitToolDispositions(ctx, ev, id, TIER_BATCH, condition);
  }
  // Coverage: a model the catalog tracks a Batch offering for must have a Batch row.
  for (const [id, model] of ctx.scope.models) {
    if (model.offerings.has(TIER_BATCH) && !batchSeen.has(id)) {
      ctx.readings.review({ modelId: id, tier: TIER_BATCH }, [
        {
          code: "missing-model",
          message: `tracked model ${id} has a Batch offering but no ### Batch processing row`,
        },
      ]);
    }
  }

  // ---- standard-tier tool rates ----
  emitToolRates(ctx, ev, rows);

  // ---- coverage: new priced sections fail closed ----
  const feature = page.heading(2, "Feature-specific pricing");
  if (feature !== undefined) {
    const end = page.sectionEnd(feature);
    for (const h of page.headings) {
      if (h.line <= feature.line || h.line >= end) continue;
      if (h.depth === 3 && !EXPECTED_FEATURE_SECTIONS.has(h.text)) {
        ctx.readings.review(
          {},
          [
            {
              code: "structure",
              message: `new priced feature section "### ${h.text}" this reader does not cover`,
            },
          ],
          undefined,
          prov("anthropic-pricing", ev, {
            location: ev.citeAt("## Feature-specific pricing", h.offset, h.text.length + 4),
          }),
        );
      }
      if (h.depth === 4) {
        const parent = page.headings.filter((x) => x.depth === 3 && x.line < h.line).at(-1);
        if (parent?.text === "Specific tool pricing" && !EXPECTED_TOOL_SECTIONS.has(h.text)) {
          ctx.readings.review(
            {},
            [
              {
                code: "structure",
                message: `new priced tool section "#### ${h.text}" this reader does not cover`,
              },
            ],
            undefined,
            prov("anthropic-pricing", ev, {
              location: ev.citeAt("### Specific tool pricing", h.offset, h.text.length + 5),
            }),
          );
        }
      }
    }
  }

  // Model rows also yield model readings: a "(retired …)" qualifier is lifecycle
  // evidence; unmarked rows yield identity only.
  for (const row of rows) {
    if (row.id === null) continue;
    ctx.readings.model({
      modelId: row.id,
      name: row.name,
      ...(row.retired
        ? { status: "retired" as const, notice: "marked retired on the pricing table" }
        : {}),
      provenance: prov("anthropic-pricing", ev, {
        location: ev.cite(`${where} › table › row '${row.name}'`, row.row.offset, row.row.text, [
          headingAnchor,
          headerAnchor,
        ]),
      }),
    });
  }
}

function sameCondition(a: Condition | undefined, b: Condition | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "Claude Fable 5.1 and Claude Mythos 5.1" / "A, B, and C" → names. */
export function splitModelList(text: string): string[] {
  return text
    .split(/,\s*|\s+and\s+/)
    .map((s) =>
      s
        .trim()
        .replace(/^and\s+/, "")
        .replace(/\.$/, ""),
    )
    .filter((s) => s.length > 0);
}

// ---------- tool pricing ----------

function emitToolDispositions(
  ctx: Ctx,
  ev: Evidence,
  modelId: string,
  tier: string,
  condition: Condition | undefined,
): void {
  if (!toolSentencesPresent(ctx, ev)) return;
  const wsOffset = ev.offsetOf(
    "Web search is available on the Claude API for **$10 USD per 1,000 searches**",
  );
  if (wsOffset >= 0) {
    ctx.readings.rate({
      modelId,
      tier,
      component: "web_search",
      fact: {
        disposition: "unsupported",
        reason:
          "The page states web search at $10 per 1,000 searches on the Claude API and no Batch price for it.",
      },
      ...(condition !== undefined ? { condition, conditionInputs: CONDITION_INPUTS } : {}),
      provenance: prov("anthropic-pricing", ev, {
        location: ev.cite(
          "### Specific tool pricing › #### Web search tool",
          wsOffset,
          "Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs for search-generated content.",
          [ev.anchor("#### Web search tool")],
        ),
        dateRule: "undated",
      }),
    });
  }
  const ceOffset = ev.offsetOf(
    "* Additional usage beyond 1,550 hours is billed at **$0.05 USD per hour, per container**.",
  );
  if (ceOffset >= 0) {
    ctx.readings.rate({
      modelId,
      tier,
      component: "code_execution",
      fact: {
        disposition: "unsupported",
        reason:
          "Billed by container time at $0.05 per hour after 1,550 free hours per organization per month, with a 5-minute minimum, and free when used with web search or web fetch. Free allowances are not modelled.",
      },
      ...(condition !== undefined ? { condition, conditionInputs: CONDITION_INPUTS } : {}),
      provenance: prov("anthropic-pricing", ev, {
        location: ev.cite(
          "### Specific tool pricing › #### Code execution tool",
          ceOffset,
          "* Additional usage beyond 1,550 hours is billed at **$0.05 USD per hour, per container**.",
          [
            ev.anchor("#### Code execution tool"),
            ev.anchor("* Each organization receives **1,550 free hours** of usage per month."),
          ],
        ),
        dateRule: "undated",
      }),
    });
  }
}

/**
 * Every tool-pricing sentence an emit path cites or anchors. Checked before any
 * `anchor()` call, so a changed sentence is `needs-review`, never a ReaderBug
 * that loses the rest of the report.
 */
const TOOL_SENTENCES = [
  "#### Web search tool",
  "#### Code execution tool",
  "Web search is available on the Claude API for **$10 USD per 1,000 searches**",
  "* Additional usage beyond 1,550 hours is billed at **$0.05 USD per hour, per container**.",
  "* Each organization receives **1,550 free hours** of usage per month.",
];

const toolReviewed = new WeakSet<Readings>();
function toolSentencesPresent(ctx: Ctx, ev: Evidence): boolean {
  const missing = TOOL_SENTENCES.filter((s) => ev.offsetOf(s) < 0);
  if (missing.length === 0) return true;
  if (!toolReviewed.has(ctx.readings)) {
    toolReviewed.add(ctx.readings);
    ctx.readings.review({}, [
      {
        code: "structure",
        message: `tool-pricing statement(s) missing or changed: ${missing.map((s) => JSON.stringify(s.slice(0, 60))).join("; ")}`,
      },
    ]);
  }
  return false;
}

function emitToolRates(ctx: Ctx, ev: Evidence, rows: RowFacts[]): void {
  if (!toolSentencesPresent(ctx, ev)) return;
  const wsOffset = ev.offsetOf(
    "Web search is available on the Claude API for **$10 USD per 1,000 searches**",
  );
  const wsProv = prov("anthropic-pricing", ev, {
    location: ev.cite(
      "### Specific tool pricing › #### Web search tool",
      wsOffset,
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs for search-generated content.",
      [ev.anchor("#### Web search tool")],
    ),
    dateRule: "undated",
  });
  const ceOffset = ev.offsetOf(
    "* Additional usage beyond 1,550 hours is billed at **$0.05 USD per hour, per container**.",
  );
  const ceProv = prov("anthropic-pricing", ev, {
    location: ev.cite(
      "### Specific tool pricing › #### Code execution tool",
      ceOffset,
      "* Additional usage beyond 1,550 hours is billed at **$0.05 USD per hour, per container**.",
      [
        ev.anchor("#### Code execution tool"),
        ev.anchor("* Each organization receives **1,550 free hours** of usage per month."),
      ],
    ),
    dateRule: "undated",
  });
  for (const row of rows) {
    const modelId = row.id ?? row.name;
    if (row.id === null) continue;
    const cond =
      row.condition !== undefined
        ? { condition: row.condition, conditionInputs: CONDITION_INPUTS }
        : {};
    ctx.readings.rate({
      modelId,
      tier: TIER_STANDARD,
      component: "web_search",
      fact: { disposition: "priced", unit: "request", per: 1000, amount: "10", currency: "USD" },
      ...cond,
      provenance: wsProv,
    });
    ctx.readings.rate({
      modelId,
      tier: TIER_STANDARD,
      component: "code_execution",
      fact: {
        disposition: "unsupported",
        reason:
          "Billed by container time at $0.05 per hour after 1,550 free hours per organization per month, with a 5-minute minimum, and free when used with web search or web fetch. Free allowances are not modelled.",
      },
      ...cond,
      provenance: ceProv,
    });
  }
}

// ---------- the models overview page ----------

export function readAnthropicModels(
  ev: Evidence,
  ctx: Ctx,
  sources: AnthropicSources,
): Map<string, string> {
  const page = new MarkdownPage(ev);
  const table = page.tableUnder(2, "Compare models");
  if (table === undefined)
    throw new Unreadable("wrong-document", "no comparison table under ## Compare models");
  const defaults = new Map<string, string>();

  // The first column is the feature label; the rest are one column per current model.
  const nameCells = table.header.slice(1);
  const rowByLabel = new Map<string, TableRow>();
  for (const row of table.rows) {
    const label = (row.cells[0]?.text ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*/g, "")
      .trim();
    rowByLabel.set(label, row);
  }
  for (const label of ["Claude API ID", "Default effort", "Retirement"]) {
    if (!rowByLabel.has(label))
      throw new NeedsReview("structure", `## Compare models: no '${label}' row`);
  }
  const idRow = rowByLabel.get("Claude API ID");
  const effortRow = rowByLabel.get("Default effort");
  const retireRow = rowByLabel.get("Retirement");

  const seen = new Map<string, string>(); // id → name
  nameCells.forEach((cell, i) => {
    const headerText = cell.text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1").trim();
    const idCell = idRow?.cells[i + 1]?.text ?? "";
    const id = /^`([^`]+)`$/.exec(idCell.trim())?.[1] ?? null;
    if (id === null) {
      ctx.readings.review({}, [
        {
          code: "structure",
          message: `## Compare models › column '${headerText}': no \`claude-*\` id`,
        },
      ]);
      return;
    }
    seen.set(id, headerText);
    const effort = /^`([a-z]+)`$/.exec(effortRow?.cells[i + 1]?.text.trim() ?? "")?.[1];
    if (effort !== undefined) defaults.set(id, effort);
    const retireCell = retireRow?.cells[i + 1]?.text.trim() ?? "";
    const notice = /^Not sooner than (.+)$/.exec(retireCell)?.[1];
    ctx.readings.model({
      modelId: id,
      name: headerText,
      status: "available",
      ...(notice !== undefined && notice !== null
        ? { notice: `Retirement: not sooner than ${notice}` }
        : {}),
      provenance: prov("anthropic-models", ev, {
        location: ev.cite(
          `Latest models comparison › row 'Claude API ID' › column '${headerText}'`,
          idRow?.offset ?? 0,
          idRow?.text ?? "",
          [{ offset: table.offset, excerpt: page.lines[table.headerLine]?.text ?? "" }],
        ),
      }),
    });
  });

  // A tracked model outside the comparison table is read from its own model page.
  const legacy = legacyLinks(ev);
  for (const [id] of ctx.scope.models) {
    if (seen.has(id)) continue;
    const slug = legacy.get(id);
    const pageEv = slug !== undefined ? sources.modelPage?.(id) : undefined;
    if (slug === undefined) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `tracked model ${id} is neither in the comparison table nor the legacy list`,
        },
      ]);
      continue;
    }
    if (pageEv === undefined) {
      ctx.readings.observe({
        outcome: "unreadable",
        reasons: [
          { code: "no-evidence", message: `no saved model page for ${id} (${modelPageUrl(slug)})` },
        ],
        modelId: id,
        source: "anthropic-model-page",
      });
      continue;
    }
    readModelPage(pageEv, id, ctx);
  }
  return defaults;
}

/** The "Legacy models (still available): [Name](url)…" paragraph → id → slug. */
function legacyLinks(ev: Evidence): Map<string, string> {
  const map = new Map<string, string>();
  const m = /Legacy models \(still available\): ([^\n]+)/.exec(ev.text);
  if (m === null) return map;
  for (const link of (m[1] ?? "").matchAll(
    /\[([^\]]+)\]\(https:\/\/platform\.claude\.com\/docs\/en\/models\/([^/)]+)\/overview\)/g,
  )) {
    const id = idFromName(link[1] ?? "");
    if (id !== null) map.set(id, link[2] ?? "");
  }
  return map;
}

/** A per-model overview page: `Model ID`, the Availability table's Status row. */
function readModelPage(ev: Evidence, modelId: string, ctx: Ctx): void {
  src(ctx, "anthropic-model-page", ev);
  const idLine = `Model ID: \`${modelId}\``;
  const idOffset = ev.offsetOf(idLine);
  if (idOffset < 0) {
    ctx.readings.observe({
      outcome: "unreadable",
      reasons: [
        {
          code: "wrong-document",
          message: `the page at ${ev.url} does not state \`Model ID: ${modelId}\``,
        },
      ],
      modelId,
      source: "anthropic-model-page",
    });
    return;
  }
  const titleMatch = /^title: (.+)$/m.exec(ev.text);
  const statusLine = /^\| \[Status\]\([^)]*\) \| ([^|]+)\|$/m.exec(ev.text);
  const statusText = statusLine?.[1]?.trim() ?? "";
  const retiredLine = /^\| Retirement\s*\| ([^|]+)\|$/m.exec(ev.text);
  const noticeParts: string[] = [];
  if (/legacy/i.test(statusText)) noticeParts.push(`Status: ${statusText}`);
  if (retiredLine !== null) noticeParts.push(`Retirement: ${(retiredLine[1] ?? "").trim()}`);
  let status: "available" | "deprecated" | "retired" | "preview" | undefined;
  if (/^Active/.test(statusText)) status = "available";
  else if (/^Retired/.test(statusText)) status = "retired";
  else if (/^Deprecated/.test(statusText)) status = "deprecated";
  else if (statusText !== "") {
    ctx.readings.review({ modelId }, [
      {
        code: "structure",
        message: `model page Status ${JSON.stringify(statusText)} is not understood`,
      },
    ]);
  }
  const name = titleMatch?.[1]?.trim();
  ctx.readings.model({
    modelId,
    ...(name !== undefined ? { name } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(noticeParts.length > 0 ? { notice: noticeParts.join("; ") } : {}),
    provenance: prov("anthropic-model-page", ev, {
      location: ev.cite(`${titleMatch?.[1] ?? modelId} › Model ID`, idOffset, idLine),
    }),
    ...(status !== undefined && statusLine !== null
      ? {
          statusProvenance: prov("anthropic-model-page", ev, {
            location: ev.cite(
              `${titleMatch?.[1] ?? modelId} › Availability › Status`,
              ev.byteOffset(statusLine.index),
              statusLine[0],
            ),
          }),
        }
      : {}),
  });
}

// ---------- the effort page ----------

const EFFORT_LEVELS = ["max", "xhigh", "high", "medium", "low"] as const;
const EFFORT_LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function readAnthropicEffort(
  ev: Evidence,
  ctx: Ctx,
  overviewDefaults: Map<string, string>,
): void {
  const page = new MarkdownPage(ev);
  const table = page.tableUnder(3, "Effort levels");
  if (table === undefined)
    throw new Unreadable("wrong-document", "no table under ### Effort levels");
  const rows = table.rows;
  const levelRows = rows.map(
    (r) => /^`([a-z]+)`\s*$/.exec(r.cells[0]?.text.trim() ?? "")?.[1] ?? null,
  );
  if (JSON.stringify(levelRows) !== JSON.stringify([...EFFORT_LEVELS])) {
    throw new NeedsReview(
      "structure",
      `### Effort levels rows are ${JSON.stringify(levelRows)}, expected ${JSON.stringify(EFFORT_LEVELS)}`,
    );
  }
  const rowAnchor = (level: string): Anchor => {
    const row = rows[EFFORT_LEVELS.indexOf(level as (typeof EFFORT_LEVELS)[number])];
    return { offset: row?.offset ?? 0, excerpt: (row?.text ?? "").slice(0, 120) };
  };

  // The max and xhigh rows name their models; low/medium/high are the baseline set.
  const availability = new Map<string, Set<string>>();
  for (const level of ["max", "xhigh"] as const) {
    const row = rows[EFFORT_LEVELS.indexOf(level)];
    const desc = row?.cells[1]?.text ?? "";
    const m = /Available on (.+)\.$/.exec(desc);
    const set = new Set<string>();
    if (m !== null) {
      for (const name of splitModelList(m[1] ?? "")) {
        const id = idFromName(name);
        if (id === null)
          throw new NeedsReview(
            "structure",
            `### Effort levels › ${level}: model name ${JSON.stringify(name)} not understood`,
          );
        set.add(id);
      }
    } else if (!/Available on/.test(desc)) {
      // some levels simply do not restrict availability
    }
    availability.set(level, set);
  }
  const baseline = new Set(["low", "medium", "high"]);

  // The per-model blocks under ## Recommended effort levels.
  const blocks = effortBlocks(page);
  for (const id of ctx.scope.models.keys()) {
    const block = blocks.get(id);
    if (block === undefined) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `tracked model ${id} has no ## Recommended effort levels block`,
        },
      ]);
      continue;
    }
    const { levels, level, excerpt, offset } = parseEffortBlock(block, ev);
    const tableLevels = new Set(baseline);
    if (availability.get("xhigh")?.has(id)) tableLevels.add("xhigh");
    if (availability.get("max")?.has(id)) tableLevels.add("max");
    const derived = [...tableLevels].sort(
      (a, b) => EFFORT_LEVEL_ORDER.indexOf(a) - EFFORT_LEVEL_ORDER.indexOf(b),
    );
    const stated = [...levels].sort(
      (a, b) => EFFORT_LEVEL_ORDER.indexOf(a) - EFFORT_LEVEL_ORDER.indexOf(b),
    );
    const mismatch = JSON.stringify(derived) !== JSON.stringify(stated);
    const anchors = ["max", "xhigh", "high", "medium", "low"].map(rowAnchor);
    const reasons = [
      ...(mismatch
        ? [
            {
              code: "structure",
              message: `the block states ${stated.join("/")} but the levels table's availability implies ${derived.join("/")}`,
            },
          ]
        : []),
      ...(overviewDefaults.has(id) && overviewDefaults.get(id) !== (level ?? "")
        ? [
            {
              code: "structure",
              message: `the overview's default effort '${overviewDefaults.get(id)}' disagrees with the effort page's '${level ?? "none"}'`,
            },
          ]
        : []),
    ];
    ctx.readings.effort({
      modelId: id,
      levels: stated as import("@openadviser/ai-catalog-readers-kit").EffortLevel[],
      default: level as import("@openadviser/ai-catalog-readers-kit").EffortLevel | null,
      ...(reasons.length > 0 ? { outcome: "needs-review" as const, reasons } : {}),
      provenance: prov("anthropic-effort", ev, {
        location: ev.cite(`Effort levels for this model: ${block.title}`, offset, excerpt, anchors),
      }),
    });
  }
}

interface EffortBlock {
  title: string;
  start: number;
  end: number;
  text: string;
}

/** The `**[Claude X](url)**` blocks under ## Recommended effort levels, by model id. */
function effortBlocks(page: MarkdownPage): Map<string, EffortBlock> {
  const heading = page.heading(2, "Recommended effort levels");
  const out = new Map<string, EffortBlock>();
  if (heading === undefined) return out;
  const end = page.sectionEnd(heading);
  const startByte = page.lines[heading.line]?.offset ?? 0;
  const endByte =
    end < page.lines.length
      ? (page.lines[end]?.offset ?? page.ev.bytes.length)
      : page.ev.bytes.length;
  const section = page.ev.bytes.subarray(startByte, endByte).toString("utf8");
  const marks: { id: string | null; title: string; offset: number }[] = [];
  const blockOffsets: number[] = [];
  for (const m of section.matchAll(
    /\*\*((?:\[[^\]]+\]\([^)]*\))(?:\s*&\s*\[[^\]]+\]\([^)]*\))*)\*\*/g,
  )) {
    // A block can recommend several models: `**[Fable 5.1](…) & [Mythos 5.1](…)**`.
    const offset = startByte + Buffer.byteLength(section.slice(0, m.index), "utf8");
    blockOffsets.push(offset);
    for (const link of (m[1] ?? "").matchAll(/\[([^\]]+)\]\(([^)]*)\)/g)) {
      marks.push({ id: idFromName(link[1] ?? ""), title: link[1] ?? "", offset });
    }
  }
  for (const mark of marks) {
    const stop = blockOffsets.find((o) => o > mark.offset) ?? endByte;
    if (mark.id !== null) {
      out.set(mark.id, {
        title: mark.title,
        start: mark.offset,
        end: stop,
        text: page.ev.bytes.subarray(mark.offset, stop).toString("utf8"),
      });
    }
  }
  return out;
}

interface ParsedEffort {
  levels: string[];
  level: string | null;
  excerpt: string;
  offset: number;
}

/** Levels and default from one model's recommended block. */
function parseEffortBlock(block: EffortBlock, ev: Evidence): ParsedEffort {
  const text = block.text;
  const name = block.title;
  let levels: string[];
  if (/supports all five effort levels/.test(text)) {
    levels = ["low", "medium", "high", "xhigh", "max"];
  } else {
    const bullets = [...text.matchAll(/^\s*\*\s+\*\*([A-Za-z]+) effort/gm)].map((m) =>
      (m[1] ?? "").toLowerCase(),
    );
    if (bullets.length === 0) {
      throw new NeedsReview(
        "structure",
        `effort block for ${name}: no level statement this reader understands`,
      );
    }
    levels = [...new Set(bullets)];
  }
  for (const l of levels) {
    if (!EFFORT_LEVEL_ORDER.includes(l)) {
      throw new NeedsReview(
        "structure",
        `effort block for ${name}: level ${JSON.stringify(l)} is not in the vocabulary`,
      );
    }
  }
  const dm =
    /`([a-z]+)` is the default/.exec(text) ??
    /defaults? to `([a-z]+)`/.exec(text) ??
    /Start with `([a-z]+)`, the default/.exec(text) ??
    /`([a-z]+)` is the default on the Claude API/.exec(text);
  const level = dm?.[1] ?? null;

  // Cite the sentence carrying the levels or the default. Sentence bounds are `. `
  // and newlines — never a `.` inside a version number like "5.5".
  const key = /supports all five effort levels|defaults? to `|is the default/.exec(text);
  let offset: number;
  let excerpt: string;
  if (key !== null) {
    // `key.index` is a char index into `text`; byte-convert before touching evidence.
    const at = block.start + Buffer.byteLength(text.slice(0, key.index), "utf8");
    let start = at;
    while (
      start > block.start &&
      ev.bytes[start - 1] !== 0x0a &&
      !(
        ev.bytes[start - 2] === 0x2e &&
        (ev.bytes[start - 1] === 0x20 || ev.bytes[start - 1] === 0x0a)
      )
    ) {
      start -= 1;
    }
    while (start < at && (ev.bytes[start] === 0x20 || ev.bytes[start] === 0x0a)) start += 1;
    const endMatch = /\.(?=\s|\)|$)/.exec(text.slice(key.index));
    const end =
      endMatch !== null
        ? at + Buffer.byteLength(text.slice(key.index, key.index + endMatch.index + 1), "utf8")
        : at + 120;
    offset = start;
    excerpt = ev.bytes.subarray(start, Math.min(end, ev.bytes.length)).toString("utf8").trim();
  } else {
    offset = block.start;
    excerpt =
      ev.bytes
        .subarray(block.start, Math.min(block.start + 200, ev.bytes.length))
        .toString("utf8")
        .split("\n")[0] ?? "";
  }
  return { levels, level, excerpt, offset };
}

// ---------- the Models API ----------

const LIFECYCLE = new Map([
  ["active", "available"],
  ["deprecated", "deprecated"],
  ["retired", "retired"],
] as const);

/**
 * Model and effort readings from `GET /v1/models` pages. `capabilities.effort` is read
 * per level — `xhigh` is a documented field the reader verifies per model rather than
 * assuming it globally. Absence from the list is never retirement.
 */
export function readAnthropicApi(pages: ApiPage<unknown>[], ctx: Ctx): void {
  for (const { evidence: ev, json } of pages) {
    src(ctx, "anthropic-models-api", ev);
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
      const model = asObject(item, `data[${i}]`);
      if (model.type !== "model") {
        ctx.readings.review({}, [
          {
            code: "structure",
            message: `data[${i}].type is ${JSON.stringify(model.type)}, expected "model"`,
          },
        ]);
        return;
      }
      const id = model.id;
      if (typeof id !== "string") {
        ctx.readings.review({}, [{ code: "structure", message: `data[${i}].id is not a string` }]);
        return;
      }
      const location =
        span !== undefined
          ? ev.cite(
              `GET /v1/models › data[${i}]`,
              span.start,
              ev.bytes.subarray(span.start, span.end).toString("utf8"),
            )
          : undefined;
      const lifecycle = typeof model.lifecycle === "string" ? model.lifecycle : "active";
      const status = LIFECYCLE.get(lifecycle as "active" | "deprecated" | "retired");
      ctx.readings.model({
        modelId: id,
        ...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
        ...(status !== undefined
          ? { status }
          : {
              outcome: "needs-review" as const,
              reasons: [
                {
                  code: "structure",
                  message: `lifecycle ${JSON.stringify(model.lifecycle)} not understood`,
                },
              ],
            }),
        ...(typeof model.retires_at === "string"
          ? { retiresOn: model.retires_at.slice(0, 10) }
          : {}),
        provenance: prov("anthropic-models-api", ev, {
          ...(location !== undefined ? { location } : {}),
        }),
      });

      const caps = model.capabilities;
      if (caps === null) return;
      const effort = asObject(caps, `data[${i}].capabilities`).effort;
      if (effort === null || effort === undefined) {
        ctx.readings.review({ modelId: id }, [
          { code: "structure", message: `data[${i}].capabilities.effort is absent` },
        ]);
        return;
      }
      const eff = asObject(effort, `data[${i}].capabilities.effort`);
      const levels: string[] = [];
      for (const lvl of ["low", "medium", "high", "xhigh", "max"]) {
        const flag = eff[lvl];
        if (flag === null) continue; // xhigh is documented null where unsupported
        const supported = asObject(flag, `effort.${lvl}`).supported;
        if (supported === true) levels.push(lvl);
        else if (supported !== false) {
          ctx.readings.review({ modelId: id }, [
            {
              code: "structure",
              message: `effort.${lvl}.supported is ${JSON.stringify(supported)}`,
            },
          ]);
        }
      }
      if (eff.supported !== true) {
        ctx.readings.review({ modelId: id }, [
          { code: "structure", message: `effort.supported is ${JSON.stringify(eff.supported)}` },
        ]);
      }
      let effortLoc = location;
      if (span !== undefined) {
        try {
          const itemText = text.slice(span.charStart, span.charEnd);
          const fs = jsonFieldSpan(itemText, "effort");
          const fsStart = span.start + Buffer.byteLength(itemText.slice(0, fs.start), "utf8");
          effortLoc = ev.cite(
            `GET /v1/models › data[${i}] › capabilities.effort`,
            fsStart,
            ev.bytes
              .subarray(
                fsStart,
                fsStart + Buffer.byteLength(itemText.slice(fs.start, fs.end), "utf8"),
              )
              .toString("utf8"),
          );
        } catch (error) {
          if (!(error instanceof NeedsReview) && !(error instanceof ReaderBug)) throw error;
        }
      }
      ctx.readings.effort({
        modelId: id,
        levels: levels as import("@openadviser/ai-catalog-readers-kit").EffortLevel[],
        default: null,
        provenance: prov("anthropic-models-api", ev, {
          ...(effortLoc !== undefined ? { location: effortLoc } : {}),
          note: "the API does not state a default; the effort page does",
        }),
      });
    });
  }
}

// ---------- the entry point ----------

export function readAnthropic(
  sources: AnthropicSources,
  scope: TrackedScope,
  apiPages: ApiPage<unknown>[] = [],
): AnthropicResult {
  const readings = new Readings(PROVIDER);
  const ctx: Ctx = { scope, readings, sources: [] };
  src(ctx, "anthropic-pricing", sources.pricing);
  src(ctx, "anthropic-models", sources.models);
  src(ctx, "anthropic-effort", sources.effort);
  try {
    readAnthropicPricing(sources.pricing, ctx);
  } catch (error) {
    if (error instanceof NeedsReview) {
      readings.review(
        {},
        [{ code: error.code, message: error.message }],
        `anthropic-pricing: ${error.message}`,
      );
    } else if (error instanceof Unreadable) {
      readings.observe({
        outcome: "unreadable",
        reasons: [{ code: error.code, message: error.message }],
        source: "anthropic-pricing",
      });
    } else {
      throw error;
    }
  }
  let overviewDefaults = new Map<string, string>();
  try {
    overviewDefaults = readAnthropicModels(sources.models, ctx, sources);
  } catch (error) {
    if (error instanceof NeedsReview) {
      readings.review(
        {},
        [{ code: error.code, message: error.message }],
        `anthropic-models: ${error.message}`,
      );
    } else if (error instanceof Unreadable) {
      readings.observe({
        outcome: "unreadable",
        reasons: [{ code: error.code, message: error.message }],
        source: "anthropic-models",
      });
    } else {
      throw error;
    }
  }
  try {
    readAnthropicEffort(sources.effort, ctx, overviewDefaults);
  } catch (error) {
    if (error instanceof NeedsReview) {
      readings.review(
        {},
        [{ code: error.code, message: error.message }],
        `anthropic-effort: ${error.message}`,
      );
    } else if (error instanceof Unreadable) {
      readings.observe({
        outcome: "unreadable",
        reasons: [{ code: error.code, message: error.message }],
        source: "anthropic-effort",
      });
    } else {
      throw error;
    }
  }
  if (apiPages.length > 0) {
    try {
      readAnthropicApi(apiPages, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `anthropic-models-api: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "anthropic-models-api",
        });
      } else {
        throw error;
      }
    }
  }
  return { readings: readings.all, sources: ctx.sources };
}
