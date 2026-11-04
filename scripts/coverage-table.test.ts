import { describe, expect, it } from "vitest";
import { applyCoverage, EMPTY_TABLE, END, renderCoverage, START } from "./coverage-table.ts";

describe("renderCoverage", () => {
  it("says so when there is no catalog", () => {
    expect(renderCoverage(undefined)).toBe(EMPTY_TABLE);
    expect(renderCoverage({ providers: [] })).toBe(EMPTY_TABLE);
  });

  it("summarises each provider from the data", () => {
    const table = renderCoverage({
      providers: [
        {
          name: "Example",
          models: [
            {
              offerings: [
                { tier: "example:standard", rates: [{ unit: "token" }, { unit: "request" }] },
                { tier: "example:batch", rates: [{ unit: "token" }] },
              ],
            },
            { offerings: [{ tier: "example:standard", rates: [{ unit: "token" }] }] },
            { offerings: [] },
          ],
        },
      ],
    });
    expect(table.split("\n")).toEqual([
      "| Provider | Models | With prices | Units          | Tiers                           |",
      "| -------- | -----: | ----------: | -------------- | ------------------------------- |",
      "| Example  |      3 |           2 | request, token | example:batch, example:standard |",
    ]);
  });

  it("takes units from priced entries only", () => {
    const table = renderCoverage({
      providers: [
        {
          name: "Example",
          models: [
            {
              offerings: [
                {
                  tier: "example:standard",
                  rates: [
                    { disposition: "priced", unit: "minute" },
                    { disposition: "unsupported", reason: "a free allowance" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(table.split("\n")[2]).toBe(
      "| Example  |      1 |           1 | minute | example:standard |",
    );
  });

  it("rejects data of the wrong shape instead of guessing", () => {
    expect(() => renderCoverage({ providers: [{ models: [] }] })).toThrow(/"name"/);
    expect(() => renderCoverage([])).toThrow(/object/);
  });
});

describe("applyCoverage", () => {
  it("replaces only what is between the markers", () => {
    const readme = `before\n${START}\nold\n${END}\nafter\n`;
    expect(applyCoverage(readme, "new")).toBe(`before\n${START}\nnew\n${END}\nafter\n`);
  });

  it("fails when the markers are missing", () => {
    expect(() => applyCoverage("no markers", "x")).toThrow(/must contain/);
  });
});
