// BASIS-4 step 5: a basis must be one `price` could have written. `price` writes the entry in force at
// one instant for every component, so the windows of its priced entries have an instant in common, and
// it writes a tier of the basis's provider. No vector reaches a basis that breaks either.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiCatalogError, load, price, priceFromBasis } from "../src/index.ts";

const dated = readFileSync(new URL("../../../conformance/fixtures/dated.json", import.meta.url));
const usage = {
  completeness: "complete",
  quantities: { input: 100000, input_cached: 20000, output: 40000, grounding_search: 0 },
} as const;

type Json = null | string | number | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type Document = {
  origin: Json;
  provider: string;
  tier: string;
  schedules: { components: { component: string; [key: string]: Json }[] }[];
};

/** Replays the basis of a priced call after `edit` has changed its document. */
async function replayDocument(edit: (document: Document) => void) {
  const catalog = await load(dated);
  const priced = price(catalog, {
    provider: "google-gemini",
    modelId: "vector-dated",
    tier: "google-gemini:standard",
    at: "2026-11-04T12:00:00Z",
    settlement: "booked",
    usage,
  });
  const document = JSON.parse(priced.basis) as Document;
  edit(document);
  const text = canonical(document as unknown as Json);
  return priceFromBasis(text, createHash("sha256").update(text).digest("hex"), usage);
}

/** Replays the basis after `edit` has changed the entries of its first schedule, by component. */
function replay(edit: (entries: Record<string, { [key: string]: Json }>) => void) {
  return replayDocument((document) =>
    edit(
      Object.fromEntries(
        (document.schedules[0] as Document["schedules"][number]).components.map((c) => [
          c.component,
          c,
        ]),
      ),
    ),
  );
}

describe("the windows of a basis", () => {
  it("replays the basis as written", async () => {
    await expect(replay(() => {})).resolves.toMatchObject({ exact: "453/2000" });
  });

  it("accepts windows that overlap by a second", async () => {
    await expect(
      replay((e) => {
        (e.output as { validFrom: Json; validUntil: Json }).validFrom = "2026-12-31T23:59:59Z";
        (e.output as { validFrom: Json; validUntil: Json }).validUntil = null;
      }),
    ).resolves.toMatchObject({ currency: "USD" });
  });

  it("refuses windows that touch but share no instant", async () => {
    // input is in force until 2027-01-01T00:00:00Z, exclusive; output from that instant.
    const error = await replay((e) => {
      (e.output as { validFrom: Json; validUntil: Json }).validFrom = "2027-01-01T00:00:00Z";
      (e.output as { validFrom: Json; validUntil: Json }).validUntil = null;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiCatalogError);
    expect((error as AiCatalogError).code).toBe("invalid-basis");
  });
});

describe("the identity of a basis", () => {
  it("refuses a tier of another provider, whatever the origin", async () => {
    for (const origin of [undefined, { kind: "override", revision: "r1" }]) {
      const error = await replayDocument((document) => {
        if (origin !== undefined) document.origin = origin;
        document.tier = "openai:standard";
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiCatalogError);
      expect((error as AiCatalogError).code).toBe("invalid-basis");
    }
  });

  it("accepts an override origin with a tier of its provider", async () => {
    await expect(
      replayDocument((document) => {
        document.origin = { kind: "override", revision: "r1" };
      }),
    ).resolves.toMatchObject({ exact: "453/2000" });
  });
});
