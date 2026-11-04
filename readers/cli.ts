// `npm run read -- <source> [--live]` — run one source's reader and print its readings
// as JSON. The sources are the four providers and the two cross-checks.
//
// Without `--live` the reader works on the saved bytes under `evidence/` (and, for the
// cross-checks, their fixtures) — the newest retrieval of each URL it reads. With
// `--live` the pages are fetched, the bytes and retrieval records are stored under
// `evidence/` first, and the API list reads run when the provider's key is in the
// environment; without the key the API source is `unreadable` ("no key"). The update
// job stores a run's bytes in its own directory instead (reconcile/).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Reading } from "@openadviser/ai-catalog-readers-kit";
import { CROSS_CHECKS, isSourceId, readSource, SOURCES_OF_TRUTH } from "./run.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EVIDENCE_DIR = join(ROOT, "evidence");
const FIXTURE_DIRS = [
  join(ROOT, "readers", "models-dev", "fixtures", "evidence"),
  join(ROOT, "readers", "genai-prices", "fixtures", "evidence"),
];

const source = process.argv[2];
const live = process.argv.includes("--live");

if (source === undefined || !isSourceId(source)) {
  console.error(
    `usage: npm run read -- <${[...SOURCES_OF_TRUTH, ...CROSS_CHECKS].join("|")}> [--live]`,
  );
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as unknown;
const report = await readSource(source, {
  live,
  catalog,
  evidenceDirs: [EVIDENCE_DIR, ...FIXTURE_DIRS],
  storeDir: EVIDENCE_DIR,
  client: "npm run read (readers/cli.ts)",
});

const reviews = (report.readings as Reading[]).filter((r) => r.outcome === "needs-review").length;
const unreadable = (report.readings as Reading[]).filter((r) => r.outcome === "unreadable").length;
console.log(JSON.stringify(report, null, 2));
console.error(
  `${source}: ${report.readings.length} readings (${reviews} needs-review, ${unreadable} unreadable)`,
);
