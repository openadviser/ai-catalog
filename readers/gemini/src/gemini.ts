// The Google Gemini reader.
//
// Sources of truth (docs/sources.md):
//   gemini-pricing   ai.google.dev/gemini-api/docs/pricing.md.txt — one `##` section per
//                    model with `{% id="<model-id>" %}`, a `*[`id`]` line, and `{% tab %}`
//                    tier tables. Dated rates are prose: "through <date>" / "starting
//                    <date>", recorded with the date-only-utc rule (sources.md: the page
//                    states no zone, so UTC is the conservative reading).
//   gemini-thinking  ai.google.dev/gemini-api/docs/thinking.md.txt — the Model / Default
//                    Thinking / Levels Supported table.
//   gemini-models    GET /v1beta/models — the model list; a list never retires a model.
//
// Only the Standard tab is a schema 1.0.0 tier. A Batch, Flex, Priority or Contributor
// tab on a tracked model is recorded `needs-review` — "tier not in schema 1.0.0" —
// never silently skipped. The free tier is not modelled (spec §15).
import { isDeepStrictEqual } from "node:util";
import {
  type Anchor,
  type ApiPage,
  asArray,
  asObject,
  type EffortLevel,
  type Evidence,
  type FactValue,
  type Instant,
  jsonArraySpans,
  NeedsReview,
  type Provenance,
  provenance,
  type RateReading,
  ReaderBug,
  type ReaderId,
  type Reading,
  Readings,
  type Reason,
  startingDate,
  type TrackedScope,
  throughDate,
  Unreadable,
  undated,
} from "@openadviser/ai-catalog-readers-kit";

export const READER: ReaderId = { name: "google-gemini", version: "0.2.0" };

export const GEMINI_URLS = {
  pricing: "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
  thinking: "https://ai.google.dev/gemini-api/docs/thinking.md.txt",
  apiModels: "https://generativelanguage.googleapis.com/v1beta/models",
} as const;

const PROVIDER = "google-gemini";
const TIER_STANDARD = "google-gemini:standard";
const TIER_NOT_IN_SCHEMA = "tier not in schema 1.0.0";

interface Ctx {
  scope: TrackedScope;
  readings: Readings;
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

function src(ctx: Ctx, source: string, ev: Evidence): void {
  ctx.sources.push({ source, url: ev.url, evidence: ev.sha256, retrievedAt: ev.retrievedAt });
}

function prov(source: string, ev: Evidence, extra: Parameters<typeof provenance>[3]): Provenance {
  return provenance(source, ev, `${READER.name}@${READER.version}`, extra);
}

// ---------- the {% tab %}/{% table %} structure ----------

interface GTable {
  /** Byte offset of `{% table %}`. */
  offset: number;
  /** The header items (usually [Feature, Free Tier, Paid Tier…]). */
  header: GItem[];
  rows: GItem[][];
}

interface GItem {
  /** Byte offset of the `* ` marker's `*`. */
  offset: number;
  /** Byte offset of the item's first text byte, after `* `. */
  textStart: number;
  /** Byte offset one past the item's last byte (before the separator/next item's `*`). */
  end: number;
  text: string;
}

interface Tab {
  title: string;
  offset: number;
  table: GTable | undefined;
  /** Footnote definitions `{% sup %}X{% /sup %} text` found inside the tab. */
  sups: { glyph: string; text: string; offset: number }[];
}

/** Splits the text between `{% table %}` and `{% /table %}` into item rows. */
function parseGTable(ev: Evidence, tableStart: number): GTable {
  const tail = ev.bytes.subarray(tableStart).toString("utf8");
  const open = /^\s*\{% table %\}\s*$/m;
  const m = open.exec(tail);
  if (m === null) throw new NeedsReview("structure", "no {% table %} block where one was expected");
  const start = tableStart + Buffer.byteLength(tail.slice(0, m.index), "utf8");
  const after = ev.bytes.subarray(start).toString("utf8");
  const endM = /\{% \/table %\}/.exec(after);
  const end =
    endM !== null ? start + Buffer.byteLength(after.slice(0, endM.index), "utf8") : ev.bytes.length;
  const lines: { offset: number; text: string }[] = [];
  let pos = start;
  const body = ev.bytes;
  while (pos < end) {
    const nl = body.indexOf(0x0a, pos);
    const lineEnd = nl === -1 || nl > end ? end : nl;
    lines.push({ offset: pos, text: body.subarray(pos, lineEnd).toString("utf8") });
    pos = lineEnd + 1;
  }
  const rows: GItem[][] = [];
  let current: GItem | null = null;
  let rowItems: GItem[] = [];
  const flushRow = (): void => {
    if (rowItems.length > 0) rows.push(rowItems);
    rowItems = [];
  };
  for (const line of lines) {
    if (/^\s*---\s*$/.test(line.text)) {
      current = null;
      flushRow();
      continue;
    }
    const item = /^(\s*)\*\s+(.*)$/.exec(line.text);
    if (item !== null) {
      const textStart = line.offset + (item[0]?.length ?? 0) - (item[2]?.length ?? 0);
      current = {
        offset: line.offset,
        textStart,
        end: line.offset + Buffer.byteLength(line.text, "utf8"),
        text: item[2] ?? "",
      };
      rowItems.push(current);
      continue;
    }
    if (line.text.trim() === "" || /^\s*\{%/.test(line.text)) {
      continue;
    }
    // a continuation line belongs to the open item
    if (current !== null) {
      current.text += `\n${line.text.trim()}`;
      current.end = line.offset + Buffer.byteLength(line.text, "utf8");
    }
  }
  flushRow();
  if (rows.length === 0) throw new NeedsReview("structure", "{% table %} holds no rows");
  const [header, ...rest] = rows;
  return { offset: start, header: header ?? [], rows: rest };
}

// ---------- price phrases ----------

const LONG_DATE = "[A-Z][a-z]+ [0-9]{1,2}, [0-9]{4}";
const SUP = String.raw`(?:\{%\s*/?sup[^%]*%\})`;

interface Phrase {
  amount: string;
  /** `text` / `audio` / `storage`, when the phrase qualifies. */
  qualifier: string | null;
  /** `10s-audio` when the phrase carries its own denomination. */
  denom: "10s-audio" | null;
  window: "through" | "starting" | null;
  date: string | null;
  equivalent: boolean;
  /** The phrase's byte offset and exact bytes, for citation. */
  offset: number;
  excerpt: string;
}

const PHRASE_RE = new RegExp(
  String.raw`(Equivalent to )?\$([0-9]+(?:\.[0-9]+)?)` +
    String.raw`(\s*\((text|audio)\))?` +
    String.raw`(\s*/\s*1,000,000 tokens per hour \(storage price\))?` +
    String.raw`(\s*per 10s audio)?` +
    `${SUP}*` +
    String.raw`(\s+(through|starting) (` +
    LONG_DATE +
    "))?" +
    `${SUP}*\\.?`,
  "g",
);

/**
 * The `$…` phrases inside a paid-tier cell's raw bytes, each cited at its own offset.
 * Anything between the phrases that is not whitespace, a footnote marker or a link is
 * `needs-review`: an unexplained token in a price cell is never skipped.
 */
export function pricePhrases(cellRaw: string, cellOffset: number, where: string): Phrase[] {
  const out: Phrase[] = [];
  let covered = 0;
  const re = new RegExp(PHRASE_RE.source, "g");
  const filler = new RegExp(`^(?:\\s|${SUP}|\\[[^\\]]*\\]\\([^)]*\\))*$`);
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(cellRaw);
    if (m === null) break;
    const between = cellRaw.slice(covered, m.index);
    if (!filler.test(between)) {
      throw new NeedsReview(
        "bad-amount",
        `${where}: unexplained text ${JSON.stringify(between.trim().slice(0, 80))} in the paid column`,
      );
    }
    covered = m.index + m[0].length;
    const qualifier = m[4] ?? (m[5] !== undefined ? "storage" : null);
    out.push({
      amount: m[2] ?? "",
      qualifier,
      denom: m[6] !== undefined ? "10s-audio" : null,
      window: (m[8] as "through" | "starting" | undefined) ?? null,
      date: m[9] ?? null,
      equivalent: m[1] !== undefined,
      offset: cellOffset + Buffer.byteLength(cellRaw.slice(0, m.index), "utf8"),
      excerpt: m[0],
    });
  }
  if (!filler.test(cellRaw.slice(covered))) {
    throw new NeedsReview(
      "bad-amount",
      `${where}: unexplained text ${JSON.stringify(cellRaw.slice(covered).trim().slice(0, 80))} in the paid column`,
    );
  }
  return out;
}

// ---------- the pricing page ----------

const FEATURE_COMPONENTS = new Map<string, string>([
  ["Input price", "input"],
  ["Output price (including thinking tokens)", "output"],
  ["Context caching price", "context-caching"],
]);

/** The tracked components a feature row is the only stated source for. */
const FEATURE_ROW_COMPONENTS = new Map<string, string[]>([
  ["Input price", ["input"]],
  ["Output price (including thinking tokens)", ["output"]],
  ["Output price", ["output_audio"]],
  ["Context caching price", ["input_cached", "cache_storage"]],
  ["Grounding with Google Search", ["grounding_search"]],
  ["Grounding with Google Maps", ["grounding_maps"]],
]);

const KNOWN_TABS = new Set(["Standard", "Batch", "Flex", "Priority", "Contributor"]);

const FREE_KNOWN = new Set(["Free of charge", "Not available"]);
const FREE_LINK = /^\[(Yes|No)\]\([^)]*\)$/;

const SUP_UNDERSTOOD: RegExp[] = [
  /^A customer-submitted request to Gemini may result in one or\s+more queries to Google Search\./s,
  /^Discounts and model availability are subject to change\./s,
  /^Audio tokens correspond to 25 tokens per second of audio\./s,
  /^Can be tested in Google AI Studio\./s,
  /^Estimated pricing is based on/s,
];

function stripSups(text: string): { text: string; glyphs: string[] } {
  const glyphs: string[] = [];
  const out = text.replace(
    /\{% sup %\}(.*?)\{% \/sup %\}|\{% sup \/\}/gs,
    (_m, g: string | undefined) => {
      glyphs.push(g ?? "*");
      return "";
    },
  );
  return { text: out, glyphs };
}

interface Section {
  name: string;
  anchorId: string | null;
  headingOffset: number;
  headingLine: string;
  start: number;
  end: number;
}

function sections(ev: Evidence): Section[] {
  const text = ev.text;
  const out: Section[] = [];
  const re = /^## (.*?)\s*(?:\{% id="([^"]+)" %\})?\s*$/gm;
  let m: RegExpExecArray | null;
  const marks: { name: string; anchorId: string | null; offset: number; headingLine: string }[] =
    [];
  for (;;) {
    m = re.exec(text);
    if (m === null) break;
    const heading = text.slice(m.index, m.index + m[0].length);
    marks.push({
      name: (m[1] ?? "").trim(),
      anchorId: m[2] ?? null,
      offset: ev.byteOffset(m.index),
      headingLine: heading,
    });
  }
  marks.forEach((mark, i) => {
    out.push({
      ...mark,
      headingOffset: mark.offset,
      start: mark.offset,
      end: marks[i + 1]?.offset ?? ev.bytes.length,
    });
  });
  return out;
}

function tabsIn(ev: Evidence, start: number, end: number): Tab[] {
  // Scan the byte span as text: every match index below is a char index in `slice`,
  // converted to evidence bytes only where it becomes an offset.
  const slice = ev.bytes.subarray(start, end).toString("utf8");
  const bo = (charIndex: number): number =>
    start + Buffer.byteLength(slice.slice(0, charIndex), "utf8");
  const tabs: Tab[] = [];
  for (const m of slice.matchAll(/\{% tab title="([^"]+)" %\}/g)) {
    tabs.push({ title: m[1] ?? "", offset: bo(m.index), table: undefined, sups: [] });
  }
  tabs.forEach((tab, i) => {
    const tabEnd = tabs[i + 1]?.offset ?? end;
    const tabSlice = ev.bytes.subarray(tab.offset, tabEnd).toString("utf8");
    const tableMatch = /\{% table %\}/.exec(tabSlice);
    if (tableMatch !== null) {
      tab.table = parseGTable(
        ev,
        tab.offset + Buffer.byteLength(tabSlice.slice(0, tableMatch.index), "utf8"),
      );
    }
    const supRe = /\{% sup %\}(\*+)\{% \/sup %\}\s*(.+?)(?=\n\s*\{%|\n\n|$)/gs;
    for (const s of tabSlice.matchAll(supRe)) {
      tab.sups.push({
        glyph: s[1] ?? "",
        text: (s[2] ?? "").trim(),
        offset: tab.offset + Buffer.byteLength(tabSlice.slice(0, s.index), "utf8"),
      });
    }
  });
  return tabs;
}

export function readGeminiPricing(ev: Evidence, ctx: Ctx): void {
  const all = sections(ev);
  const tracked = ctx.scope.models;
  const seen = new Set<string>();

  for (const section of all) {
    if (["Pricing for tools", "Pricing for agents", "Notes"].includes(section.name)) continue;
    const body = ev.bytes.subarray(section.start, section.end).toString("utf8");
    // A per-request section (Lyria: "Paid Tier, per request in USD") has no tabs and may
    // price several models in one table, so it has its own reader.
    if (isPerRequestSection(ev, section, body)) {
      readPerRequestSection(ev, ctx, section, body, seen);
      continue;
    }
    // The model id: the `*[`id`](…)`* line is the statement; the {% id %} anchor agrees.
    const idMatch = /\*\[`([a-z0-9-]+)`\]\([^)]*\)\*/.exec(body);
    const id = idMatch?.[1] ?? section.anchorId;
    if (id === undefined || id === null) {
      if (tracked.size > 0) {
        ctx.readings.review({}, [
          { code: "structure", message: `section "${section.name}" states no model id` },
        ]);
      }
      continue;
    }
    const isTracked = tracked.has(id);
    if (isTracked) seen.add(id);
    const headingAnchor: Anchor = { offset: section.headingOffset, excerpt: section.headingLine };
    // Presence in the current pricing page states availability; "Preview" marks a preview model.
    const preview = /Preview/.test(section.name);
    const idOffset =
      idMatch !== null
        ? section.start + Buffer.byteLength(body.slice(0, idMatch.index), "utf8")
        : section.headingOffset;
    const idExcerpt = idMatch !== null ? idMatch[0] : section.headingLine;
    ctx.readings.model({
      modelId: id,
      name: section.name,
      status: preview ? "preview" : "available",
      ...(preview
        ? {
            statusProvenance: prov("gemini-pricing", ev, {
              location: ev.cite(
                `${section.headingLine} › heading`,
                section.headingOffset,
                section.headingLine,
              ),
            }),
          }
        : {}),
      provenance: prov("gemini-pricing", ev, {
        location: ev.cite(`${section.headingLine} › model id`, idOffset, idExcerpt, [
          headingAnchor,
        ]),
      }),
    });

    const tabs = tabsIn(ev, section.start, section.end);
    if (isTracked && !tabs.some((t) => t.title === "Standard")) {
      ctx.readings.review({ modelId: id }, [
        { code: "structure", message: `tracked model ${id} has no Standard tab` },
      ]);
    }
    for (const tab of tabs) {
      const tabAnchor: Anchor = { offset: tab.offset, excerpt: `{% tab title="${tab.title}" %}` };
      if (!KNOWN_TABS.has(tab.title)) {
        ctx.readings.review(
          { modelId: id, tier: `google-gemini:${tab.title.toLowerCase()}` },
          [{ code: "structure", message: `tab "${tab.title}" is not one this reader knows` }],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(`${section.headingLine} › tab`, tab.offset, tabAnchor.excerpt, [
              headingAnchor,
            ]),
          }),
        );
        continue;
      }
      if (tab.title !== "Standard") {
        if (isTracked) {
          ctx.readings.review(
            { modelId: id, tier: `google-gemini:${tab.title.toLowerCase()}` },
            [{ code: "tier-not-in-schema", message: TIER_NOT_IN_SCHEMA }],
            `the ${tab.title} tab is priced for ${id} but is not a schema 1.0.0 tier`,
            prov("gemini-pricing", ev, {
              location: ev.cite(
                `${section.headingLine} › ${tab.title} tab`,
                tab.offset,
                tabAnchor.excerpt,
                [headingAnchor],
              ),
            }),
          );
        }
        continue;
      }
      // The Standard tab: full fact extraction where the model is tracked, structure
      // assertions everywhere else.
      const table = tab.table;
      if (table === undefined) {
        ctx.readings.review({ modelId: id }, [
          { code: "structure", message: "the Standard tab holds no {% table %}" },
        ]);
        continue;
      }
      const headerParts = table.header.map((it) => stripSups(it.text));
      const header = headerParts.map((p) => p.text.trim());
      const expected = ["Feature", "Free Tier", "Paid Tier, per 1M tokens in USD"];
      if (header.length !== 3 || !header.every((h, i) => h === expected[i])) {
        ctx.readings.review(
          { modelId: id },
          [
            {
              code: "structure",
              message: `the Standard table's columns are ${JSON.stringify(header)}, expected ${JSON.stringify(expected)}`,
            },
          ],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(
              `${section.headingLine} › Standard tab › header`,
              table.header[0]?.offset ?? table.offset,
              ev.bytes
                .subarray(
                  table.header[0]?.offset ?? table.offset,
                  table.header[table.header.length - 1]?.end ?? table.offset,
                )
                .toString("utf8"),
              [headingAnchor, tabAnchor],
            ),
          }),
        );
        continue;
      }
      // Markers on the header qualify the whole paid column; an unresolved one
      // means no rate from this tab can be trusted.
      let headerBad = false;
      for (const glyph of headerParts.flatMap((p) => p.glyphs)) {
        const def = tab.sups.find((s) => s.glyph === glyph);
        if (def === undefined || !SUP_UNDERSTOOD.some((re) => re.test(def.text))) {
          ctx.readings.review(
            { modelId: id },
            [
              {
                code: "unknown-footnote",
                message: `header marker {% sup %}${glyph}{% /sup %} has no understood definition in this tab`,
              },
            ],
            undefined,
            prov("gemini-pricing", ev, {
              location: ev.cite(
                `${section.headingLine} › Standard tab › header`,
                table.header[0]?.offset ?? table.offset,
                ev.bytes
                  .subarray(
                    table.header[0]?.offset ?? table.offset,
                    table.header[table.header.length - 1]?.end ?? table.offset,
                  )
                  .toString("utf8"),
                [headingAnchor, tabAnchor],
              ),
            }),
          );
          headerBad = true;
        }
      }
      if (headerBad) continue;
      if (!isTracked) continue;
      readStandardRows(ev, ctx, section, table, id, [headingAnchor, tabAnchor], tab.sups);
    }
  }

  for (const id of tracked.keys()) {
    if (!seen.has(id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `tracked model ${id} has no ## section on the pricing page`,
        },
      ]);
    }
  }
}

// ---------- the per-request sections (Lyria) ----------

const PER_REQUEST_HEADER = ["Feature", "Free Tier", "Paid Tier, per request in USD"];
/** "$0.08 per song": the one price form a per-request row states. */
const PER_SONG = /^\$([0-9]+(?:\.[0-9]+)?) per song$/;
/** The descriptor after a row's model name: "(Full Song)" or "(30s)". */
const SONG_DESCRIPTOR = /^\((?:Full Song|[0-9]+s)\)$/;

/** `lyria-3.5` and "Lyria 3.5" are the same name: compare them as lowercase alphanumeric runs. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Where a section's first `{% table %}` starts, as a byte offset into the evidence, or -1. */
function firstTableOffset(section: Section, body: string): number {
  const at = body.search(/^\s*\{% table %\}\s*$/m);
  return at < 0 ? -1 : section.start + Buffer.byteLength(body.slice(0, at), "utf8");
}

/** A section with no tabs whose table prices "per request": the Lyria sections. */
function isPerRequestSection(ev: Evidence, section: Section, body: string): boolean {
  if (/\{% tab /.test(body)) return false;
  const tableAt = firstTableOffset(section, body);
  if (tableAt < 0) return false;
  try {
    const header = parseGTable(ev, tableAt).header;
    return /per request/i.test(header[2]?.text ?? "");
  } catch (error) {
    if (error instanceof NeedsReview) return false;
    throw error;
  }
}

/**
 * One per-request section: `*[`id`](…) and [`id`](…)*`, then a table whose header is
 * exactly Feature / Free Tier / "Paid Tier, per request in USD" and whose rows are one
 * "<Model name> (<descriptor>)" row per model, "Not available", "$X per song".
 *
 * Fails closed: a header, a row label, a descriptor or a price form it does not know is
 * `needs-review` for every tracked model of the section, never a rate. A row is bound to
 * a model id only when its name slugs to that id; it is never guessed.
 */
function readPerRequestSection(
  ev: Evidence,
  ctx: Ctx,
  section: Section,
  body: string,
  seen: Set<string>,
): void {
  const tracked = ctx.scope.models;
  // The heading line without its line break, so a citation is the heading and nothing after it.
  const headingLine = section.headingLine.trimEnd();
  const headingAnchor: Anchor = { offset: section.headingOffset, excerpt: headingLine };
  const where = `${headingLine} › Paid Tier`;
  // The id statement: every `[`id`](/docs/models/id)` between the heading and the rule.
  const hr = body.indexOf("{% hr");
  const idSpan = hr < 0 ? body : body.slice(0, hr);
  const ids: { id: string; offset: number; excerpt: string }[] = [];
  for (const m of idSpan.matchAll(
    /\[`([A-Za-z0-9][A-Za-z0-9._-]*)`\]\(\/docs\/models\/([^)]+)\)/g,
  )) {
    if (m[1] !== m[2]) continue;
    ids.push({
      id: m[1] ?? "",
      offset: section.start + Buffer.byteLength(body.slice(0, m.index), "utf8"),
      excerpt: m[0],
    });
  }
  const trackedIds = ids.filter((i) => tracked.has(i.id)).map((i) => i.id);
  for (const id of trackedIds) seen.add(id);
  const reviewAll = (code: string, message: string, offset?: number, excerpt?: string): void => {
    const at = offset ?? section.headingOffset;
    const text = excerpt ?? headingLine;
    const reasons = [{ code, message }];
    const provenance = prov("gemini-pricing", ev, {
      location: ev.cite(`${where} › structure`, at, text, [headingAnchor]),
    });
    if (trackedIds.length === 0) ctx.readings.review({}, reasons, undefined, provenance);
    for (const id of trackedIds)
      ctx.readings.review({ modelId: id }, reasons, undefined, provenance);
  };
  if (ids.length === 0) {
    reviewAll("structure", `the section "${section.name}" states no model id`);
    return;
  }
  const tableAt = firstTableOffset(section, body);
  let table: GTable;
  try {
    table = parseGTable(ev, tableAt);
  } catch (error) {
    if (error instanceof NeedsReview) {
      reviewAll(error.code, error.message);
      return;
    }
    throw error;
  }
  const headerParts = table.header.map((it) => stripSups(it.text));
  const header = headerParts.map((p) => p.text.trim());
  const headerAt = table.header[0]?.offset ?? table.offset;
  const headerEnd = table.header[table.header.length - 1]?.end ?? table.offset;
  const headerExcerpt = ev.bytes.subarray(headerAt, headerEnd).toString("utf8");
  if (
    header.length !== PER_REQUEST_HEADER.length ||
    !header.every((h, i) => h === PER_REQUEST_HEADER[i]) ||
    headerParts.some((p) => p.glyphs.length > 0)
  ) {
    reviewAll(
      "structure",
      `the per-request table's columns are ${JSON.stringify(header)}, expected ${JSON.stringify(PER_REQUEST_HEADER)}`,
      headerAt,
      headerExcerpt,
    );
    return;
  }

  // Rows: bind each "<name> (<descriptor>)" row to the one id it slugs to.
  interface Row {
    id: string;
    label: string;
    name: string;
    feature: GItem;
    paid: GItem;
  }
  const rows: Row[] = [];
  const bound = new Set<string>();
  for (const row of table.rows) {
    const itemText = (item: GItem): string =>
      ev.bytes.subarray(item.offset, item.end).toString("utf8");
    if (row.length !== 3) {
      reviewAll(
        "structure",
        `a per-request row has ${row.length} cells, expected 3`,
        row[0]?.offset ?? table.offset,
        itemText(row[0] ?? (table.header[0] as GItem)),
      );
      continue;
    }
    const [featureItem, freeItem, paidItem] = row as [GItem, GItem, GItem];
    const label = featureItem.text.trim();
    const free = freeItem.text.trim();
    const paid = paidItem.text.trim();
    if (label === "Used to improve our products") {
      const ok = (x: string): boolean => FREE_LINK.test(x) || FREE_KNOWN.has(x);
      if (!ok(free) || !ok(paid)) {
        reviewAll(
          "structure",
          `the 'Used to improve our products' row holds a value this reader does not understand`,
          featureItem.offset,
          itemText(featureItem),
        );
      }
      continue;
    }
    const labelMatch = /^(.*?)\s+(\([^)]*\))$/.exec(label);
    const name = labelMatch?.[1] ?? "";
    const matches = ids.filter((i) => slug(i.id) === slug(name));
    if (
      labelMatch === null ||
      !SONG_DESCRIPTOR.test(labelMatch[2] ?? "") ||
      matches.length !== 1 ||
      bound.has((matches[0] as { id: string }).id)
    ) {
      reviewAll(
        "structure",
        `the row ${JSON.stringify(label)} is not "<model name> (<Full Song or Ns>)" for exactly one model id of this section (${ids.map((i) => i.id).join(", ")})`,
        featureItem.offset,
        itemText(featureItem),
      );
      continue;
    }
    const id = (matches[0] as { id: string }).id;
    bound.add(id);
    if (!FREE_KNOWN.has(free) && !FREE_LINK.test(free)) {
      reviewAll(
        "structure",
        `free-tier cell ${JSON.stringify(free)} for '${label}' is not a form this reader knows`,
        freeItem.offset,
        itemText(freeItem),
      );
    }
    rows.push({ id, label, name, feature: featureItem, paid: paidItem });
  }

  const priced = new Set<string>();
  for (const id of ids) {
    const row = rows.find((r) => r.id === id.id);
    // Presence in the pricing page states availability; "Preview" in the name marks a preview.
    const preview = row !== undefined && /Preview/.test(row.name);
    ctx.readings.model({
      modelId: id.id,
      ...(row !== undefined ? { name: row.name } : {}),
      status: preview ? "preview" : "available",
      ...(preview && row !== undefined
        ? {
            statusProvenance: prov("gemini-pricing", ev, {
              location: ev.cite(`${where} › '${row.label}'`, row.feature.textStart, row.label, [
                headingAnchor,
              ]),
            }),
          }
        : {}),
      provenance: prov("gemini-pricing", ev, {
        location: ev.cite(`${headingLine} › model id`, id.offset, id.excerpt, [headingAnchor]),
      }),
    });
    if (row === undefined) continue;
    if (!tracked.has(id.id)) continue;
    const m = PER_SONG.exec(row.paid.text.trim());
    const cellExcerpt = ev.bytes.subarray(row.paid.textStart, row.paid.end).toString("utf8").trim();
    const location = (): ReturnType<Evidence["cite"]> =>
      ev.cite(`${where} › '${row.label}'`, row.paid.textStart, cellExcerpt, [
        headingAnchor,
        ev.anchor(`* ${row.label}`, section.start),
        { offset: headerAt, excerpt: headerExcerpt },
      ]);
    if (m === null || cellExcerpt !== row.paid.text.trim()) {
      ctx.readings.review(
        { modelId: id.id, component: "generation" },
        [
          {
            code: "bad-amount",
            message: `the paid cell ${JSON.stringify(row.paid.text.trim().slice(0, 80))} for '${row.label}' is not "$<amount> per song"`,
          },
        ],
        undefined,
        prov("gemini-pricing", ev, { location: location() }),
      );
      priced.add(id.id);
      continue;
    }
    priced.add(id.id);
    ctx.readings.rate({
      modelId: id.id,
      tier: TIER_STANDARD,
      component: "generation",
      fact: {
        disposition: "priced",
        unit: "request",
        per: 1,
        amount: m[1] ?? "",
        currency: "USD",
      },
      provenance: prov("gemini-pricing", ev, { location: location(), dateRule: "undated" }),
    });
  }
  for (const id of trackedIds) {
    if (!priced.has(id)) {
      ctx.readings.review({ modelId: id, component: "generation" }, [
        {
          code: "missing-component",
          message: `the per-request table states no price row for ${id}; a missing tracked component is not a free one`,
        },
      ]);
    }
  }
}

/** The rows of a tracked model's Standard tab. */
function readStandardRows(
  ev: Evidence,
  ctx: Ctx,
  section: Section,
  table: GTable,
  modelId: string,
  anchors: Anchor[],
  sups: { glyph: string; text: string; offset: number }[],
): void {
  const where = `${section.headingLine} › Standard tab`;
  for (const row of table.rows) {
    if (row.length !== 3) {
      ctx.readings.review(
        { modelId },
        [
          {
            code: "structure",
            message: `a Standard-table row has ${row.length} cells, expected 3`,
          },
        ],
        undefined,
        prov("gemini-pricing", ev, {
          location: ev.citeAt(where, row[0]?.offset ?? table.offset, 40, anchors),
        }),
      );
      continue;
    }
    const [featureItem, freeItem, paidItem] = row as [GItem, GItem, GItem];
    const feature = stripSups(featureItem.text).text.trim();
    const free = stripSups(freeItem.text).text.trim();
    const paidRaw = ev.bytes.subarray(paidItem.textStart, paidItem.end).toString("utf8");
    // Anything this row fails to explain taints every fact it could emit: a price
    // under an unresolved marker or an unknown free cell is never emitted ok.
    const taints: Reason[] = [];
    // The free column: understood values only; the free tier is not modelled (spec §15).
    const freeStripped = free
      .replace(/\{% sup %\}[^%]*\{% \/sup %\}/g, "")
      .replace(/\{% sup \/\}/g, "")
      .trim();
    if (!FREE_KNOWN.has(freeStripped) && !FREE_LINK.test(freeStripped)) {
      taints.push({
        code: "structure",
        message: `free-tier cell ${JSON.stringify(free)} for '${feature}' is not a form this reader knows`,
      });
      ctx.readings.review(
        { modelId, component: feature },
        [
          {
            code: "structure",
            message: `free-tier cell ${JSON.stringify(free)} for '${feature}' is not a form this reader knows`,
          },
        ],
        undefined,
        prov("gemini-pricing", ev, {
          location: ev.cite(
            `${where} › Free Tier › '${feature}'`,
            freeItem.offset,
            ev.bytes.subarray(freeItem.offset, freeItem.end).toString("utf8"),
            anchors,
          ),
        }),
      );
    }

    // Footnote markers on this row must resolve to understood definitions.
    const markerGlyphs = stripSups(
      `${featureItem.text}\n${freeItem.text}\n${paidItem.text}`,
    ).glyphs;
    for (const glyph of markerGlyphs) {
      const def = sups.find((s) => s.glyph === glyph);
      if (def === undefined) {
        taints.push({
          code: "unknown-footnote",
          message: `marker {% sup %}${glyph}{% /sup %} on '${feature}' has no definition in this tab`,
        });
        ctx.readings.review(
          { modelId, component: feature },
          [
            {
              code: "unknown-footnote",
              message: `marker {% sup %}${glyph}{% /sup %} on '${feature}' has no definition in this tab`,
            },
          ],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(
              `${where} › '${feature}'`,
              paidItem.offset,
              ev.bytes.subarray(paidItem.offset, paidItem.end).toString("utf8"),
              anchors,
            ),
          }),
        );
      } else if (!SUP_UNDERSTOOD.some((re) => re.test(def.text))) {
        taints.push({
          code: "unknown-footnote",
          message: `footnote ${glyph} (${def.text.slice(0, 80)}) is not one this reader understands`,
        });
        ctx.readings.review(
          { modelId, component: feature },
          [
            {
              code: "unknown-footnote",
              message: `footnote ${glyph} (${def.text.slice(0, 80)}) is not one this reader understands`,
            },
          ],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(
              `${where} › footnote ${glyph}`,
              def.offset,
              ev.bytes
                .subarray(def.offset, Math.min(def.offset + 200, ev.bytes.length))
                .toString("utf8"),
              anchors,
            ),
          }),
        );
      }
    }

    const emitRate = (
      component: string,
      fact: FactValue,
      phrase: { offset: number; excerpt: string; window: Phrase["window"]; date: Phrase["date"] },
      extra?: { note?: string },
    ): void => {
      const dated =
        phrase.window === "through" && phrase.date !== null
          ? { d: throughDate(phrase.date), bound: "validUntil" as const }
          : phrase.window === "starting" && phrase.date !== null
            ? { d: startingDate(phrase.date), bound: "validFrom" as const }
            : { d: undated(), bound: null };
      const provArgs: Parameters<typeof provenance>[3] = {
        location: ev.cite(`${where} › Paid Tier › '${feature}'`, phrase.offset, phrase.excerpt, [
          ...anchors,
          ev.anchor(`* ${feature}`),
        ]),
        dateRule: dated.d.rule,
      };
      if (extra?.note !== undefined) provArgs.note = extra.note;
      ctx.readings.rate({
        ...(taints.length > 0 ? { outcome: "needs-review" as const, reasons: taints } : {}),
        modelId,
        tier: TIER_STANDARD,
        component,
        fact,
        ...(dated.bound === "validFrom" && dated.d.instant !== undefined
          ? { validFrom: dated.d.instant }
          : {}),
        ...(dated.bound === "validUntil" && dated.d.instant !== undefined
          ? { validUntil: dated.d.instant }
          : {}),
        provenance: prov("gemini-pricing", ev, provArgs),
      });
    };

    if (feature === "Used to improve our products") {
      const ok = (s: string): boolean => FREE_LINK.test(s) || FREE_KNOWN.has(s);
      if (!ok(freeStripped) || !ok(stripSups(paidItem.text).text.trim())) {
        ctx.readings.review({ modelId }, [
          {
            code: "structure",
            message: `the 'Used to improve our products' row holds a value this reader does not understand`,
          },
        ]);
      }
      continue;
    }
    if (feature === "Grounding with Google Search" || feature === "Grounding with Google Maps") {
      const component =
        feature === "Grounding with Google Search" ? "grounding_search" : "grounding_maps";
      const clean = paidItem.text;
      // The two stated forms:
      //   "5,000 free search requests per month (shared across all Gemini 3 and newer
      //    models), then $14 per 1,000 requests (subject to a [daily cap]…)."
      //   "5,000 requests per month (free, shared across all Gemini 3 and newer
      //    models), then $14 / 1,000 search queries."
      const m =
        /^([0-9,]+) free search requests per month \(([^)]*)\),\s*then \$([0-9.]+)\s*(?:per|\/)\s*1,000 requests(.+)$/s.exec(
          clean,
        ) ??
        /^([0-9,]+) requests per month \(([^)]*)\),\s*then \$([0-9.]+)\s*\/\s*1,000\s*search queries\.?$/s.exec(
          clean,
        );
      if (m === null) {
        ctx.readings.review(
          { modelId, component },
          [
            {
              code: "bad-amount",
              message: `grounding cell ${JSON.stringify(clean.slice(0, 120))} is not the free-allowance form`,
            },
          ],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(
              `${where} › '${feature}'`,
              paidItem.offset,
              ev.bytes.subarray(paidItem.offset, paidItem.end).toString("utf8"),
              anchors,
            ),
          }),
        );
        continue;
      }
      const scope = (m[2] ?? "")
        .replace(/^free, /, "")
        .replace(/^shared across /, "")
        .replace(/^all /, "");
      const reason =
        component === "grounding_search"
          ? `${m[1]} free search requests per month shared across ${scope}, then $${m[3]} per 1,000 requests, with a daily cap; free allowances are not modelled.`
          : `${m[1]} requests per month free, shared across ${scope}, then $${m[3]} per 1,000 search queries; free allowances are not modelled.`;
      emitRate(
        component,
        { disposition: "unsupported", reason },
        {
          offset: paidItem.offset,
          excerpt: ev.bytes.subarray(paidItem.offset, paidItem.end).toString("utf8"),
          window: null,
          date: null,
        },
      );
      continue;
    }

    const component =
      FEATURE_COMPONENTS.get(feature) ?? (feature === "Output price" ? "output_price" : null);
    if (component === null || component === undefined) {
      ctx.readings.review(
        { modelId, component: feature },
        [{ code: "structure", message: `feature row '${feature}' is not one this reader prices` }],
        undefined,
        prov("gemini-pricing", ev, {
          location: ev.cite(
            `${where} › '${feature}'`,
            featureItem.offset,
            ev.bytes.subarray(featureItem.offset, featureItem.end).toString("utf8"),
            anchors,
          ),
        }),
      );
      continue;
    }

    let phrases: Phrase[];
    try {
      phrases = pricePhrases(paidRaw, paidItem.textStart, `${where} › '${feature}'`);
    } catch (error) {
      if (error instanceof NeedsReview) {
        ctx.readings.review(
          { modelId, component: feature },
          [{ code: error.code, message: error.message }],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(
              `${where} › '${feature}'`,
              paidItem.offset,
              ev.bytes.subarray(paidItem.offset, paidItem.end).toString("utf8"),
              anchors,
            ),
          }),
        );
        continue;
      }
      throw error;
    }
    if (phrases.length === 0 || phrases.every((p) => p.equivalent)) {
      // A recognized row with no primary price is not "free" — the page changed.
      ctx.readings.review(
        { modelId, component: feature },
        [
          {
            code: "bad-amount",
            message: `the '${feature}' paid cell holds no primary price`,
          },
        ],
        undefined,
        prov("gemini-pricing", ev, {
          location: ev.cite(
            `${where} › '${feature}'`,
            paidItem.offset,
            ev.bytes.subarray(paidItem.offset, paidItem.end).toString("utf8"),
            anchors,
          ),
        }),
      );
      continue;
    }
    for (const phrase of phrases) {
      if (phrase.equivalent) continue; // an "Equivalent to" restatement, understood
      if (phrase.denom === "10s-audio") {
        // A duration-denominated phrase is only understood as an "Equivalent to"
        // restatement; as a primary price its unit is not the schema's token unit.
        ctx.readings.review(
          { modelId, component: feature },
          [
            {
              code: "unsupported-unit",
              message: `a primary price ${JSON.stringify(phrase.excerpt)} is denominated per 10s audio, which is not a token unit`,
            },
          ],
          undefined,
          prov("gemini-pricing", ev, {
            location: ev.cite(`${where} › '${feature}'`, phrase.offset, phrase.excerpt, anchors),
          }),
        );
        continue;
      }
      if (component === "output_price") {
        // A bare "Output price" row is only priced when every phrase says (audio).
        if (phrase.qualifier !== "audio") {
          ctx.readings.review(
            { modelId, component: "output" },
            [
              {
                code: "bad-amount",
                message: `an unqualified Output price phrase ${JSON.stringify(phrase.excerpt)}; the reader cannot tell text from audio output`,
              },
            ],
            undefined,
            prov("gemini-pricing", ev, {
              location: ev.cite(`${where} › '${feature}'`, phrase.offset, phrase.excerpt, anchors),
            }),
          );
          continue;
        }
      }
      const target =
        component === "context-caching"
          ? phrase.qualifier === "storage"
            ? "cache_storage"
            : "input_cached"
          : component === "output_price"
            ? "output_audio"
            : component;
      const unit = target === "cache_storage" ? "token-hour" : "token";
      emitRate(
        target,
        { disposition: "priced", unit, per: 1_000_000, amount: phrase.amount, currency: "USD" },
        phrase,
      );
    }
  }
  // Coverage: every component the catalog tracks on this model's Standard
  // offering must yield a reading — a rate or a review. A deleted row is not
  // a free component, and a row that covers none of the tracked components it
  // once covered is a changed page, not a cheaper model.
  const trackedComponents = ctx.scope.models.get(modelId)?.components.get(TIER_STANDARD);
  if (trackedComponents !== undefined) {
    for (const component of trackedComponents) {
      const covered = ctx.readings.all.some((r) => {
        const c = r as { modelId?: string; component?: string; tier?: string };
        if (c.modelId !== modelId || (c.tier !== undefined && c.tier !== TIER_STANDARD))
          return false;
        return (
          c.component === component ||
          (FEATURE_ROW_COMPONENTS.get(c.component ?? "") ?? []).includes(component)
        );
      });
      if (!covered) {
        ctx.readings.review({ modelId, component }, [
          {
            code: "missing-component",
            message: `the Standard tab states no '${component}' fact; a missing tracked component is not a free one`,
          },
        ]);
      }
    }
  }
}

/**
 * Dated price phrases for one fact must tile a timeline, not overlap. Two
 * phrases whose validity windows intersect cannot both be the price — the pair
 * is `needs-review`, never a guessed winner.
 */
function checkWindowConflicts(readings: Readings): void {
  const OPEN_END = "￿";
  const priced = readings.all.filter(
    (r): r is RateReading => r.kind === "rate" && r.fact.disposition === "priced",
  );
  const groups = new Map<string, RateReading[]>();
  for (const r of priced) {
    const f = r.fact;
    if (f.disposition !== "priced") continue;
    const key = [r.modelId, r.tier, r.component, f.unit, f.per, f.currency, r.condition ?? ""].join(
      "|",
    );
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a === undefined || b === undefined) continue;
        const aF = a.validFrom ?? "";
        const bF = b.validFrom ?? "";
        const aU = a.validUntil ?? OPEN_END;
        const bU = b.validUntil ?? OPEN_END;
        const overlaps = aF < bU && bF < aU;
        const identical =
          aF === bF &&
          aU === bU &&
          a.fact.disposition === "priced" &&
          b.fact.disposition === "priced" &&
          a.fact.amount === b.fact.amount;
        if (overlaps && !identical) {
          for (const r of [a, b]) {
            r.outcome = "needs-review";
            r.reasons.push({
              code: "conflicting-window",
              message: `overlapping validity windows on ${r.modelId} ${r.tier} ${r.component}: the page states two prices for the same period`,
            });
          }
        }
      }
    }
  }
}

// ---------- the thinking page ----------

const LEVEL_VOCAB = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function readGeminiThinking(ev: Evidence, ctx: Ctx): void {
  // The "Controlling thinking" table: | Model | Default Thinking | Levels Supported |
  const headerOffset = ev.offsetOf("| Model | Default Thinking | Levels Supported |");
  if (headerOffset === -1) {
    throw new Unreadable("wrong-document", "the thinking-levels table is missing");
  }
  const tableStart = ev.offsetOf("| --- |", headerOffset);
  const rows: { offset: number; text: string }[] = [];
  let pos = tableStart;
  for (;;) {
    const nl = ev.bytes.indexOf(0x0a, pos);
    const lineEnd = nl === -1 ? ev.bytes.length : nl;
    const line = ev.bytes.subarray(pos, lineEnd).toString("utf8");
    if (!line.startsWith("|")) break;
    if (!/^\|[ |-]+\|$/.test(line)) rows.push({ offset: pos, text: line });
    pos = lineEnd + 1;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = row.text
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const [model, defaultCell, levelsCell] = [cells[0] ?? "", cells[1] ?? "", cells[2] ?? ""];
    const isTracked = ctx.scope.models.has(model);
    const dm = /^On(?: \(([a-z]+)\))?$|^Off$/.exec(defaultCell);
    const levels = levelsCell
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const badLevel = levels.find((l) => !LEVEL_VOCAB.has(l));
    const defRaw = dm !== null && dm[0] !== "Off" ? (dm[1] ?? null) : null;
    const reasons: { code: string; message: string }[] = [];
    if (dm === null)
      reasons.push({
        code: "structure",
        message: `Default Thinking ${JSON.stringify(defaultCell)} is not understood`,
      });
    if (dm !== null && dm[0] !== "Off" && defRaw === null)
      reasons.push({
        code: "structure",
        message: `Default Thinking ${JSON.stringify(defaultCell)} names no level`,
      });
    if (defRaw !== null && !LEVEL_VOCAB.has(defRaw))
      reasons.push({
        code: "structure",
        message: `default level ${JSON.stringify(defRaw)} is not in the vocabulary`,
      });
    else if (defRaw !== null && !levels.includes(defRaw))
      reasons.push({
        code: "structure",
        message: `default level '${defRaw}' is not in this model's supported levels ${JSON.stringify(levels)}`,
      });
    if (badLevel !== undefined)
      reasons.push({
        code: "structure",
        message: `level ${JSON.stringify(badLevel)} is not in the vocabulary`,
      });
    if (reasons.length > 0 && !isTracked) {
      // A malformed row might be a tracked model renamed; report it regardless.
      ctx.readings.review(
        { component: "effort" },
        reasons,
        undefined,
        prov("gemini-thinking", ev, {
          location: ev.cite(`Thinking levels table › row`, row.offset, row.text),
        }),
      );
    }
    if (!isTracked) continue;
    seen.add(model);
    const def = defRaw as EffortLevel | null;
    ctx.readings.effort({
      modelId: model,
      levels: levels as EffortLevel[],
      default: def,
      ...(reasons.length > 0 ? { outcome: "needs-review" as const, reasons } : {}),
      provenance: prov("gemini-thinking", ev, {
        location: ev.cite(`Thinking levels table › row '${model}'`, row.offset, row.text, [
          { offset: headerOffset, excerpt: "| Model | Default Thinking | Levels Supported |" },
        ]),
      }),
    });
  }
  for (const [id, model] of ctx.scope.models) {
    if (model.hasEffort && !seen.has(id)) {
      ctx.readings.review({ modelId: id }, [
        {
          code: "missing-model",
          message: `tracked model ${id} has no row in the thinking-levels table`,
        },
      ]);
    }
  }
}

// ---------- the Models API ----------

/**
 * Model readings from `GET /v1beta/models` pages. `name` is `models/<id>`; a list never
 * retires a model, so absence is simply the absence of a reading.
 */
export function readGeminiApi(pages: ApiPage<unknown>[], ctx: Ctx): void {
  for (const { evidence: ev, json } of pages) {
    src(ctx, "gemini-models", ev);
    const items = asArray(
      asObject(json, "GET /v1beta/models").models,
      "GET /v1beta/models › models",
    );
    const text = ev.text;
    const spans = jsonArraySpans(text, "models").map((s) => ({
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
        throw new ReaderBug(`models[${i}]'s cited span does not decode to the item`);
      }
      const obj = asObject(item, `models[${i}]`);
      const name = obj.name;
      const id = typeof name === "string" && name.startsWith("models/") ? name.slice(7) : null;
      if (id === null) {
        ctx.readings.review({}, [
          {
            code: "structure",
            message: `models[${i}].name ${JSON.stringify(name)} is not models/<id>`,
          },
        ]);
        return;
      }
      ctx.readings.model({
        modelId: id,
        ...(typeof obj.displayName === "string" ? { name: obj.displayName } : {}),
        provenance: prov("gemini-models", ev, {
          ...(span !== undefined
            ? {
                location: ev.cite(
                  `GET /v1beta/models › models[${i}]`,
                  span.start,
                  ev.bytes.subarray(span.start, span.end).toString("utf8"),
                ),
              }
            : {}),
        }),
      });
    });
  }
}

// ---------- the entry point ----------

export interface GeminiSources {
  /** Absent only when a live fetch failed — each source is read independently. */
  pricing?: Evidence;
  thinking?: Evidence;
}

export interface GeminiResult {
  readings: Reading[];
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

export function readGemini(
  sources: GeminiSources,
  scope: TrackedScope,
  apiPages: ApiPage<unknown>[] = [],
): GeminiResult {
  const readings = new Readings(PROVIDER);
  const ctx: Ctx = { scope, readings, sources: [] };
  if (sources.pricing !== undefined) {
    src(ctx, "gemini-pricing", sources.pricing);
    try {
      readGeminiPricing(sources.pricing, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `gemini-pricing: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "gemini-pricing",
        });
      } else {
        throw error;
      }
    }
  }
  checkWindowConflicts(readings);
  if (sources.thinking !== undefined) {
    src(ctx, "gemini-thinking", sources.thinking);
    try {
      readGeminiThinking(sources.thinking, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `gemini-thinking: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "gemini-thinking",
        });
      } else {
        throw error;
      }
    }
  }
  if (apiPages.length > 0) {
    try {
      readGeminiApi(apiPages, ctx);
    } catch (error) {
      if (error instanceof NeedsReview) {
        readings.review(
          {},
          [{ code: error.code, message: error.message }],
          `gemini-models: ${error.message}`,
        );
      } else if (error instanceof Unreadable) {
        readings.observe({
          outcome: "unreadable",
          reasons: [{ code: error.code, message: error.message }],
          source: "gemini-models",
        });
      } else {
        throw error;
      }
    }
  }
  return { readings: readings.all, sources: ctx.sources };
}
