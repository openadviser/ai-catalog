import { describe, expect, it } from "vitest";
import { checkData, hashLine, provenances } from "./check-data.ts";

describe("checkData", () => {
  it("finds no problem in the repository's catalog, hash and evidence", () => {
    expect(checkData()).toEqual([]);
  });
});

describe("provenances", () => {
  it("collects every provenance and statusProvenance, however deep", () => {
    const found = provenances({
      a: [{ provenance: { source: "x" } }, { b: { statusProvenance: { source: "y" } } }],
    });
    expect(found.map((f) => f.path)).toEqual(["/a/0/provenance", "/a/1/b/statusProvenance"]);
  });
});

describe("hashLine", () => {
  it("is the sha256sum format", () => {
    expect(hashLine(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  catalog.json\n",
    );
  });
});
