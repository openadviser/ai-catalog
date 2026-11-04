// The conformance runner (conformance/README.md). It reads every vector file and fixture as bytes,
// runs each vector through the public API only, and compares the result or the error code exactly,
// the basis bytes and the sha256 included. Nothing is skipped and nothing is expected to fail.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AiCatalogError,
  type Catalog,
  CatalogClient,
  convertRate,
  type ErrorCode,
  load,
  price,
  priceFromBasis,
  type UsageReport,
} from "../src/index.ts";

const conformance = new URL("../../../conformance/", import.meta.url);

interface Expected {
  provider?: string;
  modelId?: string;
  tier?: string;
  currency?: string;
  schedule?: number;
  exact?: string;
  estimate?: string;
  booked?: string;
  basis?: string;
  basisSha256?: string;
  loads?: boolean;
  amount?: string;
}

interface Step {
  catalog: { fixture: string };
  expectedSha256?: string;
  expected?: { loads: true };
  expectedError?: { code: ErrorCode };
  lastGood?: { fixture: string };
}

interface Vector {
  id: string;
  rule: string;
  kind: "load" | "load-sequence" | "price" | "priceFromBasis" | "convert";
  steps?: Step[];
  catalog?: { fixture: string };
  expectedSha256?: string;
  request?: Record<string, unknown>;
  expected?: Expected;
  expectedError?: { code: ErrorCode; missing?: string[] };
}

const vectorFiles = readdirSync(new URL("vectors/", conformance))
  .filter((name) => name.endsWith(".json"))
  .sort();
const vectors: Vector[] = vectorFiles.flatMap(
  (file) =>
    JSON.parse(readFileSync(new URL(`vectors/${file}`, conformance), "utf8")).vectors as Vector[],
);

/** A fixture is read as bytes and never re-serialized: its sha256 is part of every basis. */
function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`fixtures/${name}`, conformance));
}

/** Runs `action`, and returns the refusal it threw, or `undefined` when it did not throw. */
async function refusal(action: () => unknown): Promise<AiCatalogError | undefined> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AiCatalogError) return error;
    throw error;
  }
  return undefined;
}

function expectRefusal(error: AiCatalogError | undefined, vector: Vector): void {
  const wanted = vector.expectedError;
  if (wanted === undefined) throw new Error(`${vector.id}: no expectedError`);
  expect(error, `${vector.id} must be refused with ${wanted.code}`).toBeDefined();
  expect(error?.code).toBe(wanted.code);
  // `missing` is carried by usage-incomplete and by no other refusal.
  expect(error?.missing === undefined ? undefined : [...error.missing]).toEqual(wanted.missing);
}

const catalogs = new Map<string, Promise<Catalog>>();
function catalogOf(name: string): Promise<Catalog> {
  let loaded = catalogs.get(name);
  if (loaded === undefined) {
    loaded = load(fixture(name));
    catalogs.set(name, loaded);
  }
  return loaded;
}

const run = new Set<string>();

async function runVector(vector: Vector): Promise<void> {
  run.add(vector.id);
  const request = vector.request as Record<string, unknown>;
  switch (vector.kind) {
    case "load": {
      const bytes = fixture((vector.catalog as { fixture: string }).fixture);
      const options =
        vector.expectedSha256 === undefined ? {} : { expectedSha256: vector.expectedSha256 };
      if (vector.expectedError !== undefined) {
        expectRefusal(await refusal(() => load(bytes, options)), vector);
      } else {
        expect(vector.expected).toEqual({ loads: true });
        const catalog = await load(bytes, options);
        expect(catalog.version).toMatch(/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/);
      }
      return;
    }
    case "load-sequence": {
      // One new client for the vector; each step loads on it, in order.
      const client = new CatalogClient();
      for (const [i, step] of (vector.steps as Step[]).entries()) {
        const bytes = fixture(step.catalog.fixture);
        const options =
          step.expectedSha256 === undefined ? {} : { expectedSha256: step.expectedSha256 };
        const error = await refusal(() => client.load(bytes, options));
        if (step.expectedError !== undefined) {
          expect(error, `${vector.id} step ${i} must be refused`).toBeDefined();
          expect(error?.code, `${vector.id} step ${i}`).toBe(step.expectedError.code);
        } else {
          expect(error, `${vector.id} step ${i} must load`).toBeUndefined();
        }
        if (step.lastGood !== undefined) {
          expect(client.current?.sha256, `${vector.id} step ${i}: last good`).toBe(
            createHash("sha256").update(fixture(step.lastGood.fixture)).digest("hex"),
          );
        }
      }
      return;
    }
    case "price": {
      // The fixture of an accepting price vector always loads, so a failure here is the runner's.
      const catalog = await catalogOf((vector.catalog as { fixture: string }).fixture);
      const input = request as unknown as Parameters<typeof price>[1];
      if (vector.expectedError !== undefined) {
        expectRefusal(await refusal(() => price(catalog, input)), vector);
        return;
      }
      const expected = vector.expected as Required<Pick<Expected, "basis" | "basisSha256">> &
        Expected;
      const result = price(catalog, input);
      expect({
        provider: result.provider,
        modelId: result.modelId,
        tier: result.tier,
        currency: result.currency,
        schedule: result.schedule,
        exact: result.exact,
        estimate: result.estimate,
        booked: result.booked,
      }).toEqual({
        provider: expected.provider,
        modelId: expected.modelId,
        tier: expected.tier,
        currency: expected.currency,
        schedule: expected.schedule,
        exact: expected.exact,
        estimate: expected.estimate,
        booked: expected.booked,
      });
      // The basis, byte for byte, and its digest.
      expect(Buffer.from(result.basis, "utf8").equals(Buffer.from(expected.basis, "utf8"))).toBe(
        true,
      );
      expect(result.basisSha256).toBe(expected.basisSha256);

      // BASIS-3: replaying the basis with the same usage gives the same figures.
      const replay = priceFromBasis(
        new TextEncoder().encode(result.basis),
        result.basisSha256,
        input.usage as UsageReport,
        input.conditionInputs,
      );
      expect(replay).toEqual({
        currency: result.currency,
        schedule: result.schedule,
        exact: result.exact,
        estimate: result.estimate,
        booked: result.booked,
      });
      return;
    }
    case "priceFromBasis": {
      // The basis is a string, or the bytes of a fixture when they are not UTF-8.
      const bytes =
        request.basisFixture !== undefined
          ? fixture(request.basisFixture as string)
          : new TextEncoder().encode(request.basis as string);
      const call = () =>
        priceFromBasis(
          bytes,
          request.basisSha256 as string,
          request.usage as UsageReport,
          request.conditionInputs as { inputTokens: "unknown" } | undefined,
        );
      if (vector.expectedError !== undefined) {
        expectRefusal(await refusal(call), vector);
        return;
      }
      const expected = vector.expected as Expected;
      expect(call()).toEqual({
        currency: expected.currency,
        schedule: expected.schedule,
        exact: expected.exact,
        estimate: expected.estimate,
        booked: expected.booked,
      });
      return;
    }
    case "convert": {
      const call = () =>
        convertRate(
          request.rate as Parameters<typeof convertRate>[0],
          request.to as Parameters<typeof convertRate>[1],
        );
      if (vector.expectedError !== undefined) {
        expectRefusal(await refusal(call), vector);
        return;
      }
      expect(call()).toEqual({ amount: (vector.expected as Expected).amount });
      return;
    }
    default:
      throw new Error(`${(vector as Vector).id}: unknown kind ${(vector as Vector).kind}`);
  }
}

describe("conformance vectors", () => {
  for (const vector of vectors) {
    it(`${vector.id} (${vector.rule})`, () => runVector(vector));
  }

  // Every vector runs: a vector that is skipped, filtered out or never reached fails here.
  it("runs every vector", () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    expect([...run].sort()).toEqual(vectors.map((v) => v.id).sort());
  });
});
