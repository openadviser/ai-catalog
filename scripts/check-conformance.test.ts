import { describe, expect, it } from "vitest";
import { appendixB, basisProblem, checkConformance } from "./check-conformance.ts";

describe("checkConformance", () => {
  it("finds the vectors consistent with the schemas, the specification and the validator", () => {
    expect(checkConformance()).toEqual([]);
  });
});

describe("appendixB", () => {
  it("reads the vector ids of each rule's row", () => {
    const spec = [
      "## Appendix B. Rules and their vectors",
      "| Rule | Vectors |",
      "| ---- | ------- |",
      "| NUM-1 | `load-a`, `load-b` |",
      "## Appendix C. Worked examples",
    ].join("\n");
    expect(appendixB(spec).get("NUM-1")).toEqual(["load-a", "load-b"]);
  });
});

describe("basisProblem", () => {
  const basis = (factor: number, exponent = 2) => ({
    currency: "USD",
    rounding: { exponent },
    conditionInputs: {},
    schedules: [
      {
        condition: null,
        components: [
          {
            component: "output_audio_duration",
            disposition: "priced",
            unit: "minute",
            per: 1,
            amount: "0.1",
            meter: "millisecond",
            factor,
            validFrom: null,
            validUntil: null,
          },
        ],
      },
    ],
  });

  it("accepts a basis price could have written", () => {
    expect(basisProblem(basis(60000))).toBeUndefined();
  });

  it("rejects a factor that is not the unit's, and an exponent that is not the currency's", () => {
    expect(basisProblem(basis(1))).toMatch(/factor/);
    expect(basisProblem(basis(60000, 0))).toMatch(/exponent/);
  });
});
