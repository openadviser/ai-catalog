import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchemas, ROOT } from "./schemas.ts";
import { validateCatalog, validDate, windowInstant } from "./validate-catalog.ts";

const validate = loadSchemas();
const fixture = (name: string): Buffer => readFileSync(join(ROOT, "conformance/fixtures", name));
// biome-ignore lint/suspicious/noExplicitAny: a test edits arbitrary fixture JSON in place.
type Loose = any;
const mutate = (name: string, change: (catalog: Loose) => void): Buffer => {
  const catalog = JSON.parse(fixture(name).toString("utf8"));
  change(catalog);
  return Buffer.from(JSON.stringify(catalog));
};

describe("validateCatalog", () => {
  it("accepts the seed and the valid fixtures", () => {
    expect(
      validateCatalog(readFileSync(join(ROOT, "data/catalog.json")), validate),
    ).toBeUndefined();
    for (const name of ["text.json", "dated.json", "conditional.json", "units.json"]) {
      expect(validateCatalog(fixture(name), validate)).toBeUndefined();
    }
  });

  it("reports the code of the rule a field breaks, not a generic one", () => {
    const bytes = mutate("text.json", (c) => {
      c.providers[0].models[0].offerings[0].rates[0].amount = "1.250000000000001";
    });
    expect(validateCatalog(bytes, validate)?.code).toBe("invalid-amount");
  });

  it("falls back to invalid-structure for an unknown member", () => {
    const bytes = mutate("text.json", (c) => {
      c.providers[0].models[0].colour = "blue";
    });
    expect(validateCatalog(bytes, validate)?.code).toBe("invalid-structure");
  });

  it("rejects bytes that are not UTF-8 JSON", () => {
    expect(validateCatalog(Buffer.from([0xff, 0xfe]), validate)?.code).toBe("invalid-json");
  });

  it("checks the hash before anything else", () => {
    expect(validateCatalog(Buffer.from("{}"), validate, "0".repeat(64))?.code).toBe(
      "hash-mismatch",
    );
  });

  it("rejects effort levels out of ascending order", () => {
    const bytes = mutate("text.json", (c) => {
      c.providers[0].models[1].effort.levels = ["high", "low"];
      c.providers[0].models[1].effort.default = "low";
    });
    expect(validateCatalog(bytes, validate)?.code).toBe("invalid-effort");
  });

  it("accepts windows that touch without overlapping", () => {
    const bytes = mutate("dated.json", (c) => {
      c.providers[0].models[0].offerings[0].rates[0].validUntil = "2027-01-01T00:00:00Z";
    });
    expect(validateCatalog(bytes, validate)).toBeUndefined();
  });
});

describe("instants", () => {
  it("validates calendars, leap years included", () => {
    expect(validDate(2028, 2, 29)).toBe(true);
    expect(validDate(2027, 2, 29)).toBe(false);
    expect(validDate(2100, 2, 29)).toBe(false);
    expect(validDate(1969, 12, 31)).toBe(false);
  });

  it("refuses leap seconds, offsets and fractions in window bounds", () => {
    expect(windowInstant("2026-12-31T23:59:60Z")).toBeUndefined();
    expect(windowInstant("2026-12-31T23:59:59+00:00")).toBeUndefined();
    expect(windowInstant("2026-12-31T23:59:59.000Z")).toBeUndefined();
    expect(windowInstant("2027-01-01T00:00:00Z")).toBe(Date.UTC(2027, 0, 1));
  });
});
