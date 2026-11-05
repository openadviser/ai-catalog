// VAL-3 and COMP-1 across the minor versions: a 1.1.0 client reads 1.0.x and 1.1.x, and a
// document that declares 1.0.x does not know the components added in 1.1.0.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiCatalogError, load, price } from "../src/index.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../conformance/fixtures/${name}`, import.meta.url), "utf8");

/** The generation fixture, declaring another schema version. */
const withVersion = (name: string, schemaVersion: string): Uint8Array =>
  new TextEncoder().encode(
    fixture(name).replace(/"schemaVersion": "[^"]*"/, `"schemaVersion": "${schemaVersion}"`),
  );

const song = {
  provider: "google-gemini",
  modelId: "vector-song",
  tier: "google-gemini:standard",
  at: "2026-11-04T12:00:00Z",
  settlement: "booked",
  usage: { completeness: "complete", quantities: { generation: 3 } },
} as const;

async function codeOf(bytes: Uint8Array): Promise<string | undefined> {
  try {
    await load(bytes);
    return undefined;
  } catch (error) {
    if (error instanceof AiCatalogError) return error.code;
    throw error;
  }
}

describe("schema versions", () => {
  it("reads 1.0.x and 1.1.x, and nothing else", async () => {
    expect(await codeOf(withVersion("text.json", "1.0.7"))).toBeUndefined();
    expect(await codeOf(withVersion("text.json", "1.1.0"))).toBeUndefined();
    expect(await codeOf(withVersion("text.json", "1.1.12"))).toBeUndefined();
    for (const version of ["1.2.0", "2.0.0", "1.0.01", "1.10.0", "one"]) {
      expect(await codeOf(withVersion("text.json", version)), version).toBe(
        "unsupported-schema-version",
      );
    }
  });

  it("prices generations in a 1.1.0 catalog", async () => {
    const catalog = await load(
      readFileSync(new URL("../../../conformance/fixtures/generation.json", import.meta.url)),
    );
    const priced = price(catalog, song);
    expect(priced.exact).toBe("6/25");
    expect(priced.booked).toBe("0.24");
  });

  it("does not know generation in a catalog that declares 1.0.x", async () => {
    expect(await codeOf(withVersion("generation.json", "1.0.0"))).toBe("unknown-component");
    expect(await codeOf(withVersion("generation.json", "1.0.9"))).toBe("unknown-component");
  });

  it("does not let a refused 1.0.x document change how the next document is read", async () => {
    expect(await codeOf(withVersion("generation.json", "1.0.0"))).toBe("unknown-component");
    expect(await codeOf(withVersion("generation.json", "1.1.0"))).toBeUndefined();
  });

  it("refuses generation priced in a unit of another dimension", async () => {
    const bytes = new TextEncoder().encode(
      fixture("generation.json").replace('"unit": "request"', '"unit": "minute"'),
    );
    expect(await codeOf(bytes)).toBe("unit-mismatch");
  });
});
