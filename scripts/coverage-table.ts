// Generates the coverage table in README.md from data/catalog.json.
//
//   node scripts/coverage-table.ts          rewrite the table in README.md
//   node scripts/coverage-table.ts --check  fail if README.md is out of date
//
// The table is never typed by hand. Until the first catalog lands (slice C1),
// data/catalog.json does not exist and the table says so. A model listed
// only for its effort levels (offerings: []) counts as a model without prices.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const START = "<!-- coverage:start -->";
export const END = "<!-- coverage:end -->";

export const EMPTY_TABLE =
  "_No catalog data yet. This table is generated from `data/catalog.json` and fills in with the first data release._";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function list(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`data/catalog.json: expected ${what} to be an array of objects`);
  }
  return value;
}

function text(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`data/catalog.json: expected ${what} to have a "${key}" string`);
  }
  return value;
}

const cell = (value: string): string => value.replace(/\|/g, "\\|");

export function renderCoverage(catalog: unknown): string {
  if (catalog === undefined) return EMPTY_TABLE;
  if (!isRecord(catalog)) throw new Error("data/catalog.json: expected an object");
  const rows = list(catalog.providers, "providers").map((provider) => {
    const name = text(provider, "name", "a provider");
    const models = list(provider.models, `the models of ${name}`);
    const tiers = new Set<string>();
    const units = new Set<string>();
    let priced = 0;
    for (const model of models) {
      const offerings = list(model.offerings, "offerings");
      if (offerings.length > 0) priced++;
      for (const offering of offerings) {
        tiers.add(text(offering, "tier", "an offering"));
        for (const rate of list(offering.rates, "rates")) {
          // Only priced entries carry a unit; unsupported and inapplicable ones carry a reason.
          if (rate.disposition === undefined || rate.disposition === "priced") {
            units.add(text(rate, "unit", "a priced rate"));
          }
        }
      }
    }
    const sorted = (set: Set<string>): string => [...set].sort().join(", ") || "none";
    return [
      cell(name),
      String(models.length),
      String(priced),
      cell(sorted(units)),
      cell(sorted(tiers)),
    ];
  });
  if (rows.length === 0) return EMPTY_TABLE;
  return alignedTable(
    ["Provider", "Models", "With prices", "Units", "Tiers"],
    [false, true, true, false, false],
    rows,
  );
}

/** A Markdown table padded the way the formatter (Biome) lays tables out, so the two never disagree. */
export function alignedTable(header: string[], right: boolean[], rows: string[][]): string {
  const widths = header.map((h, c) =>
    Math.max(3, h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((v, c) => (right[c] ? v.padStart(widths[c] ?? 0) : v.padEnd(widths[c] ?? 0))).join(" | ")} |`;
  const rule = `| ${widths.map((w, c) => (right[c] ? `${"-".repeat(w - 1)}:` : "-".repeat(w))).join(" | ")} |`;
  return [line(header), rule, ...rows.map(line)].join("\n");
}

export function applyCoverage(readme: string, table: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain ${START} and ${END}, in that order`);
  }
  return `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const readmePath = resolve(root, "README.md");
  const catalogPath = resolve(root, "data/catalog.json");
  const catalog: unknown = existsSync(catalogPath)
    ? JSON.parse(readFileSync(catalogPath, "utf8"))
    : undefined;
  const current = readFileSync(readmePath, "utf8");
  const updated = applyCoverage(current, renderCoverage(catalog));
  if (process.argv.includes("--check")) {
    if (updated !== current) {
      console.error("README.md coverage table is out of date. Run: npm run coverage:table");
      process.exit(1);
    }
    console.log("README.md coverage table is up to date.");
  } else if (updated !== current) {
    writeFileSync(readmePath, updated);
    console.log("README.md coverage table updated.");
  } else {
    console.log("README.md coverage table already up to date.");
  }
}
