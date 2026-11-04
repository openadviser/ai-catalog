// The reader kit: evidence write-once semantics, cited-byte verification, date rules,
// amount arithmetic, markdown structure assertions and JSON spans.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Evidence,
  EvidenceStore,
  eqDecimal,
  expectColumns,
  type FetchedPage,
  footnoteDefs,
  jsonArraySpans,
  MarkdownPage,
  mulDecimal,
  mulDecimalToScale,
  NeedsReview,
  ReaderBug,
  startingDate,
  statedInstant,
  storeEvidence,
  throughDate,
  undated,
} from "@openadviser/ai-catalog-readers-kit";
import { describe, expect, it } from "vitest";

const ev = (text: string) =>
  new Evidence({
    bytes: Buffer.from(text),
    url: "https://example.test/page",
    retrievedAt: "2026-11-04T00:00:00Z",
  });

describe("evidence", () => {
  it("cite verifies the excerpt at the offset; a wrong excerpt is a ReaderBug", () => {
    const e = ev("hello world");
    expect(e.cite("greeting", 6, "world").offset).toBe(6);
    expect(() => e.cite("greeting", 0, "world")).toThrow(ReaderBug);
  });

  it("stores a body once and never rewrites it; a conflicting record is a bug", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    try {
      const page: FetchedPage = {
        requestedUrl: "https://x.test/",
        finalUrl: "https://x.test/",
        retrievedAt: "2026-11-04T00:00:00Z",
        status: 200,
        bytes: Buffer.from("body"),
        hops: [{ protocol: "HTTP/1.1", status: 200, headers: [] }],
      };
      const first = storeEvidence(dir, page, "test");
      const second = storeEvidence(dir, { ...page, retrievedAt: "2026-11-04T00:00:01Z" }, "test");
      expect(second.sha256).toBe(first.sha256);
      expect(new EvidenceStore(dir).latest("https://x.test/")?.bytes.toString()).toBe("body");
      expect(() =>
        storeEvidence(dir, { ...page, bytes: Buffer.from("other") }, "test"),
      ).not.toThrow();
      expect(() =>
        storeEvidence(
          dir,
          { ...page, retrievedAt: "2026-11-04T00:00:00Z", finalUrl: "https://x.test/other" },
          "test",
        ),
      ).toThrow(ReaderBug);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("date rules", () => {
  it("through dates bound validUntil exclusively the next day; starting dates bound validFrom", () => {
    const until = throughDate("December 31, 2026");
    expect(until.rule).toBe("date-only-utc");
    expect(until.instant).toBe("2027-01-01T00:00:00Z");
    const from = startingDate("January 1, 2027");
    expect(from.instant).toBe("2027-01-01T00:00:00Z");
    expect(undated().rule).toBe("undated");
  });

  it("a bad date is needs-review, never a guess", () => {
    expect(() => throughDate("the end of the year")).toThrow(NeedsReview);
    expect(() => statedInstant("2026-11-04")).toThrow(NeedsReview);
  });
});

describe("amounts", () => {
  it("multiplies decimals exactly and compares ignoring trailing zeros", () => {
    expect(mulDecimal("1.25", "10")).toBe("12.5");
    expect(mulDecimal("0.025", "0.5")).toBe("0.0125");
    expect(eqDecimal("12.50", "12.5")).toBe(true);
    expect(eqDecimal("12.51", "12.5")).toBe(false);
    expect(() => mulDecimalToScale("0.025", "0.5", 2)).toThrow(NeedsReview);
  });
});

describe("markdown structure", () => {
  const page = new MarkdownPage(
    ev("## Pricing\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n*<sup>1 a note</sup>*\n"),
  );

  it("asserts exact columns and reads footnotes", () => {
    const table = page.tableUnder(2, "Pricing");
    if (table === undefined) throw new Error("expected the pricing table");
    expectColumns(table, ["A", "B"]);
    expect(() => expectColumns(table, ["A", "B", "C"])).toThrow(NeedsReview);
    const defs = footnoteDefs(page);
    expect(defs.map((d) => d.n)).toEqual([1]);
  });
});

describe("json spans", () => {
  it("finds element spans of a top-level array", () => {
    const spans = jsonArraySpans('{"data":[{"a":1},{"b":2}],"has_more":false}', "data");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ start: 9, end: 16 });
  });
});
