import { describe, expect, it } from "vitest";
import { jcs, run } from "./pin.ts";

describe("pin", () => {
  it("finds every pinned basis current and every hand-written figure right", () => {
    expect(run(false)).toEqual([]);
  });
});

describe("jcs", () => {
  it("sorts members, keeps slashes and non-ASCII, and escapes control characters", () => {
    expect(jcs({ b: 1, a: ["x/y", "é", "\u0001\n"] })).toBe('{"a":["x/y","é","\\u0001\\n"],"b":1}');
  });

  it("refuses numbers the basis may not hold", () => {
    expect(() => jcs({ a: 1.5 })).toThrow();
    expect(() => jcs({ a: -1 })).toThrow();
  });
});
