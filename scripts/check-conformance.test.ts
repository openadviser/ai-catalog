import { describe, expect, it } from "vitest";
import { appendixB, checkConformance } from "./check-conformance.ts";

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
