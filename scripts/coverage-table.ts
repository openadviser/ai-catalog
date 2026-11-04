// Generates the coverage table in README.md from data/catalog.json.
//
//   node scripts/coverage-table.ts          rewrite the table in README.md
//   node scripts/coverage-table.ts --check  fail if README.md is out of date
//
// The table is never typed by hand. Until the first catalog lands (slice C1),
// data/catalog.json does not exist and the table says so.
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
    for (const model of models) {
      for (const offering of list(model.offerings, "offerings")) {
        tiers.add(text(offering, "tier", "an offering"));
        for (const rate of list(offering.rates, "rates")) units.add(text(rate, "unit", "a rate"));
      }
    }
    const sorted = (set: Set<string>): string => [...set].sort().join(", ") || "none";
    return `| ${cell(name)} | ${models.length} | ${cell(sorted(units))} | ${cell(sorted(tiers))} |`;
  });
  if (rows.length === 0) return EMPTY_TABLE;
  return ["| Provider | Models | Units | Tiers |", "| --- | ---: | --- | --- |", ...rows].join(
    "\n",
  );
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
