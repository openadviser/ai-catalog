import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchemas, ROOT } from "./schemas.ts";
import { textProblem, validateCatalog, validDate, windowInstant } from "./validate-catalog.ts";

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

  it("checks the calendar of every instant and date, provenance included", () => {
    const at = (change: (c: Loose) => void) =>
      validateCatalog(mutate("text.json", change), validate);
    expect(
      at((c) => {
        c.providers[0].models[1].effort.provenance.readAt = "2026-02-30T12:00:00Z";
      }),
    ).toMatchObject({
      code: "invalid-instant",
      path: "/providers/0/models/1/effort/provenance/readAt",
    });
    expect(
      at((c) => {
        c.providers[0].models[0].offerings[0].rates[2].provenance.readAt = "2027-02-29T00:00:00Z";
      }),
    ).toMatchObject({ code: "invalid-instant" });
    expect(
      at((c) => {
        c.publishedAt = "2026-04-31T00:00:00Z";
      }),
    ).toMatchObject({ code: "invalid-instant", path: "/publishedAt" });
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

describe("textProblem", () => {
  it("finds a repeated name in any object, after unescaping", () => {
    expect(textProblem('{"a":1,"b":{"c":1,"c":2}}')).toEqual({ kind: "duplicate", path: "/b/c" });
    expect(textProblem('{"a":[{"x":1},{"x":1,"\\u0078":2}]}')).toEqual({
      kind: "duplicate",
      path: "/a/1/x",
    });
  });

  it("ignores names that repeat across objects, and strings that are values", () => {
    expect(textProblem('{"a":{"x":1},"b":{"x":"a"},"c":["a","a"]}')).toBeUndefined();
    expect(textProblem('{"a":"x\\"y 1.5e3","b":-12}')).toBeUndefined();
  });

  it("refuses a number with a fraction or an exponent, even one a float reads as an integer", () => {
    expect(textProblem('{"per":1000000.00000000001}')).toEqual({ kind: "number", path: "/per" });
    expect(textProblem('{"a":[1,1e6]}')).toEqual({ kind: "number", path: "/a/1" });
    expect(textProblem('{"a":true,"b":false,"c":null}')).toBeUndefined();
  });
});
