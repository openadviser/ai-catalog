// BASIS-4 step 5: a basis must be one `price` could have written. `price` writes the entry in force at
// one instant for every component, so the windows of its priced entries have an instant in common. No
// vector reaches a basis whose windows do not.

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

/** Replays the basis of a priced call after `edit` has changed its document. */
async function replay(edit: (entries: Record<string, { [key: string]: Json }>) => void) {
  const catalog = await load(dated);
  const priced = price(catalog, {
    provider: "google-gemini",
    modelId: "vector-dated",
    tier: "google-gemini:standard",
    at: "2026-11-04T12:00:00Z",
    settlement: "booked",
    usage,
  });
  const document = JSON.parse(priced.basis) as {
    schedules: { components: { component: string; [key: string]: Json }[] }[];
  };
  edit(
    Object.fromEntries(
      (document.schedules[0] as (typeof document.schedules)[number]).components.map((c) => [
        c.component,
        c,
      ]),
    ),
  );
  const text = canonical(document as unknown as Json);
  return priceFromBasis(text, createHash("sha256").update(text).digest("hex"), usage);
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
