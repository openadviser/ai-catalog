// The structure assertion helpers for provider Markdown pages.
//
// A reader declares the structure it understands — the headings, the table columns, the
// footnotes — and the page is parsed against that declaration. Anything the declaration
// does not cover in tracked scope surfaces as `needs-review`, never a partial reading:
//
//   expectColumns   — the header row is exactly these cells, in this order. An inserted
//                     or moved column makes the table unparseable for its reader.
//   tableUnder      — the first pipe table at or after a heading.
//   sections        — the page's `##`/`###` headings, so a reader can enumerate what it
//                     does and does not cover.
//   footnoteRefs    — the `<sup>N</sup>` markers in a cell, matched against the
//                     footnote definitions the reader declares.
//
// Every location the helpers return is a byte offset into the evidence, so citations
// slice the raw bytes — never normalized text.
import { type Evidence, NeedsReview } from "./evidence.ts";

/** One physical line: its byte offset and its text without the trailing newline. */
export interface PageLine {
  offset: number;
  text: string;
}

/** A `##`/`###`/`####` heading, with the byte offset of the `#`s. */
export interface Heading {
  depth: number;
  text: string;
  offset: number;
  line: number;
}

/** One cell of a pipe-table row: trimmed text plus the cell's byte span in the row. */
export interface TableCell {
  /** The cell text, trimmed. `suprefs` holds any `<sup>N` markers. */
  text: string;
  /** Byte offset of the cell's first non-space byte, in the evidence. */
  start: number;
  /** Byte offset just past the cell's last non-space byte. */
  end: number;
  /** The footnote numbers `<sup>N` markers name, in order. */
  suprefs: number[];
}

export interface TableRow {
  line: number;
  /** Byte offset of the row's line start. */
  offset: number;
  /** The row's full line, for citation. */
  text: string;
  cells: TableCell[];
}

export interface PipeTable {
  /** Line index of the `| Header |` row. */
  headerLine: number;
  offset: number;
  header: TableCell[];
  rows: TableRow[];
}

/**
 * A Markdown page over evidence bytes. Lines and offsets are byte offsets into the
 * evidence so a citation can slice the exact bytes.
 */
export class MarkdownPage {
  readonly ev: Evidence;
  readonly lines: PageLine[];

  constructor(ev: Evidence) {
    this.ev = ev;
    const lines: PageLine[] = [];
    const bytes = ev.bytes;
    let offset = 0;
    while (offset <= bytes.length) {
      const nl = bytes.indexOf(0x0a, offset);
      if (nl === -1) {
        if (offset < bytes.length)
          lines.push({ offset, text: bytes.subarray(offset).toString("utf8") });
        break;
      }
      lines.push({ offset, text: bytes.subarray(offset, nl).toString("utf8") });
      offset = nl + 1;
      if (offset === bytes.length) break;
    }
    this.lines = lines;
  }

  /** Every heading on the page, in order. */
  get headings(): Heading[] {
    const out: Heading[] = [];
    this.lines.forEach((line, index) => {
      const m = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line.text);
      if (m !== null)
        out.push({
          depth: m[1]?.length ?? 0,
          text: (m[2] ?? "").replace(/#+$/, "").trim(),
          offset: line.offset,
          line: index,
        });
    });
    return out;
  }

  /** The heading whose text is exactly `title` at `depth`, after line `after`. */
  heading(depth: number, title: string, after = 0): Heading | undefined {
    return this.headings.find((h) => h.depth === depth && h.text === title && h.line >= after);
  }

  /** The line index where a heading's section ends: the next heading of depth <= it. */
  sectionEnd(heading: Heading): number {
    for (let i = heading.line + 1; i < this.lines.length; i += 1) {
      const m = /^(#{1,6})[ \t]/.exec(this.lines[i]?.text ?? "");
      if (m !== null && (m[1]?.length ?? 0) <= heading.depth) return i;
    }
    return this.lines.length;
  }

  /**
   * The first pipe table beginning at or after `from` (a line index). A pipe table is
   * a `| … |` header line, a `| --- |` separator, then `| … |` rows until a blank or
   * non-table line. Returns undefined when no table starts before `before`.
   */
  tableAt(from: number, before = this.lines.length): PipeTable | undefined {
    for (let i = from; i < before; i += 1) {
      const line = this.lines[i];
      if (line === undefined || !line.text.startsWith("|")) continue;
      const sep = this.lines[i + 1];
      if (sep === undefined || !/^\|[\s:|-]+\|[ \t]*$/.test(sep.text)) return undefined;
      const header = this.parseRow(line);
      const rows: TableRow[] = [];
      for (let j = i + 2; j < this.lines.length; j += 1) {
        const row = this.lines[j];
        if (row === undefined || !row.text.startsWith("|")) break;
        rows.push({ line: j, offset: row.offset, text: row.text, cells: this.parseRow(row) });
      }
      return { headerLine: i, offset: line.offset, header, rows };
    }
    return undefined;
  }

  /** The table under a heading; throws NeedsReview when the section holds none. */
  tableUnder(
    depth: number,
    title: string,
    opts: { required?: boolean } = {},
  ): PipeTable | undefined {
    const heading = this.heading(depth, title);
    if (heading === undefined) {
      if (opts.required === false) return undefined;
      throw new NeedsReview(
        "structure",
        `no \`${"#".repeat(depth)} ${title}\` heading on the page`,
      );
    }
    const table = this.tableAt(heading.line + 1, this.sectionEnd(heading));
    if (table === undefined && opts.required !== false) {
      throw new NeedsReview("structure", `no pipe table under \`${"#".repeat(depth)} ${title}\``);
    }
    return table;
  }

  private parseRow(line: PageLine): TableCell[] {
    const text = line.text;
    const cells: TableCell[] = [];
    let start = text.indexOf("|") + 1;
    while (start >= 0 && start <= text.length) {
      const end = text.indexOf("|", start);
      if (end === -1) break;
      const raw = text.slice(start, end);
      const cellText = raw.trim();
      const trimmed = raw.trimStart();
      // Char indices are not byte offsets where a cell holds non-ASCII text.
      const startByte =
        line.offset + Buffer.byteLength(text.slice(0, end - trimmed.length), "utf8");
      const endByte =
        line.offset +
        Buffer.byteLength(text.slice(0, end - (raw.length - raw.trimEnd().length)), "utf8");
      cells.push({
        text: cellText,
        start: startByte,
        end: endByte,
        suprefs: suprefsOf(cellText),
      });
      start = end + 1;
    }
    return cells;
  }
}

/** The `<sup>N` footnote markers in a text. */
export function suprefsOf(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/<sup>\s*([0-9]+)/g)) out.push(Number(m[1]));
  return out;
}

/**
 * The header row is exactly `expected`, in order. A column inserted, renamed, reordered
 * or dropped throws NeedsReview — the reader never shifts columns by position on a
 * table it half-recognizes.
 */
export function expectColumns(table: PipeTable, expected: string[]): void {
  const actual = table.header.map((c) => c.text);
  if (actual.length !== expected.length || actual.some((cell, i) => cell !== expected[i])) {
    throw new NeedsReview(
      "structure",
      `table columns are ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

/** One footnote definition the reader understands: `<sup>N` plus its text. */
export interface FootnoteSpec {
  n: number;
  /** Matched against the definition's text after the `<sup>N …</sup>` marker. */
  text: RegExp;
}

export interface FootnoteDef {
  n: number;
  text: string;
  offset: number;
  line: string;
}

/**
 * The footnote definitions on the page: lines like `*<sup>1 text</sup>*` or
 * `*<sup>1</sup> text*`. Every definition found is returned; the caller checks each
 * against its declared `FootnoteSpec`s — an undeclared definition a tracked row cites
 * is `needs-review`.
 */
export function footnoteDefs(page: MarkdownPage, from = 0): FootnoteDef[] {
  const defs: FootnoteDef[] = [];
  for (let i = from; i < page.lines.length; i += 1) {
    const line = page.lines[i];
    if (line === undefined) break;
    const m =
      /^\*<sup>([0-9]+)\s*(.*?)<\/sup>\*?[ \t]*$/.exec(line.text) ??
      /^\*<sup>([0-9]+)<\/sup>\s*(.*?)\*?[ \t]*$/.exec(line.text);
    if (m === null) continue;
    defs.push({ n: Number(m[1]), text: (m[2] ?? "").trim(), offset: line.offset, line: line.text });
  }
  return defs;
}

/**
 * Checks that every definition in `defs` matches a spec, and returns the understood
 * ones keyed by number. An undeclared definition throws NeedsReview.
 */
export function expectFootnotes(
  defs: FootnoteDef[],
  specs: FootnoteSpec[],
): Map<number, FootnoteDef> {
  const out = new Map<number, FootnoteDef>();
  const unknown: number[] = [];
  for (const def of defs) {
    if (specs.some((s) => s.n === def.n && s.text.test(def.text))) {
      out.set(def.n, def);
    } else {
      unknown.push(def.n);
    }
  }
  if (unknown.length > 0) {
    throw new NeedsReview(
      "unknown-footnote",
      `footnote definitions not understood: ${unknown.join(", ")}`,
    );
  }
  return out;
}
