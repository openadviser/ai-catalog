// `npm run read -- <provider> [--live]` — run one provider's reader and print its
// readings as JSON.
//
// Without `--live` the reader works on the saved bytes under `evidence/` — the
// newest retrieval of each URL it reads. With `--live` the pages are fetched, the
// bytes and retrieval records are stored under `evidence/` first, and the API list
// reads run when the provider's key is in the environment. An API read is never
// attempted without `--live`, and never without the key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANTHROPIC_URLS,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import { GEMINI_URLS, readGemini } from "@openadviser/ai-catalog-reader-gemini";
import {
  apiKey,
  type Evidence,
  EvidenceStore,
  type FetchedPage,
  fetchPage,
  type Reading,
  type ReadReport,
  storeEvidence,
  trackedScope,
} from "@openadviser/ai-catalog-readers-kit";

const ROOT = new URL("..", import.meta.url).pathname;
const EVIDENCE_DIR = join(ROOT, "evidence");
const CATALOG = join(ROOT, "data", "catalog.json");
const CLIENT = "npm run read (readers/cli.ts)";

const provider = process.argv[2];
const live = process.argv.includes("--live");

if (provider !== "anthropic" && provider !== "google-gemini") {
  console.error(`usage: npm run read -- <anthropic|google-gemini> [--live]`);
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as unknown;
const scope = trackedScope(catalog, provider);
const store = new EvidenceStore(EVIDENCE_DIR);

async function page(url: string): Promise<Evidence> {
  if (!live) {
    const saved = store.latest(url);
    if (saved === undefined) throw new Error(`no saved evidence for ${url}`);
    return saved;
  }
  return storeEvidence(EVIDENCE_DIR, await fetchPage(url), CLIENT);
}

/** The documented model-page URL for a tracked model outside the comparison table. */
function anthropicModelPage(modelId: string): Evidence | undefined {
  const slug = modelId.replace(/^claude-/, "");
  const url = modelPageUrl(slug);
  if (!live) return store.latest(url);
  return undefined; // a live read fetches only the URLs it knows it needs, below
}

const report: ReadReport = {
  provider,
  mode: live ? "live" : "evidence",
  sources: [],
  readings: [],
};

if (provider === "anthropic") {
  const sources = {
    pricing: await page(ANTHROPIC_URLS.pricing),
    models: await page(ANTHROPIC_URLS.models),
    effort: await page(ANTHROPIC_URLS.effort),
    modelPage: anthropicModelPage,
  };
  const apiPages = live && process.env.ANTHROPIC_API_KEY ? await anthropicApi() : [];
  const result = readAnthropic(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = result.readings;
} else {
  const sources = {
    pricing: await page(GEMINI_URLS.pricing),
    thinking: await page(GEMINI_URLS.thinking),
  };
  const apiPages = live && process.env.GEMINI_API_KEY ? await geminiApi() : [];
  const result = readGemini(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = result.readings;
}

async function anthropicApi() {
  const key = apiKey("ANTHROPIC_API_KEY");
  const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
  return readPaged<{ id?: string }>(
    {
      start: `${ANTHROPIC_URLS.apiModels}?limit=1000`,
      items: (json) => (json as { data?: { id?: string }[] }).data ?? [],
      next: (json) => {
        const page = json as { has_more?: boolean; last_id?: string };
        return page.has_more === true && typeof page.last_id === "string"
          ? `${ANTHROPIC_URLS.apiModels}?limit=1000&after_id=${page.last_id}`
          : null;
      },
    },
    async (url) =>
      fetchPage(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }),
    (page: FetchedPage) => storeEvidence(EVIDENCE_DIR, page, CLIENT),
  );
}

async function geminiApi() {
  // The key travels in the header so no credential lands in evidence URLs or
  // provenance — a `?key=` URL would be stored verbatim under evidence/.
  const key = apiKey("GEMINI_API_KEY");
  const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
  return readPaged<{ name?: string }>(
    {
      start: `${GEMINI_URLS.apiModels}?pageSize=1000`,
      items: (json) => (json as { models?: { name?: string }[] }).models ?? [],
      next: (json) => {
        const page = json as { nextPageToken?: string };
        return typeof page.nextPageToken === "string" && page.nextPageToken !== ""
          ? `${GEMINI_URLS.apiModels}?pageSize=1000&pageToken=${page.nextPageToken}`
          : null;
      },
    },
    (url) => fetchPage(url, { headers: { "x-goog-api-key": key } }),
    (page: FetchedPage) => storeEvidence(EVIDENCE_DIR, page, CLIENT),
  );
}

const envName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
if (live && process.env[envName] !== undefined) {
  // The scope an API list was read with: which key slot, never the key itself.
  report.accountScope = { keyEnv: envName };
}

const reviews = (report.readings as Reading[]).filter((r) => r.outcome === "needs-review").length;
const unreadable = (report.readings as Reading[]).filter((r) => r.outcome === "unreadable").length;
console.log(JSON.stringify(report, null, 2));
console.error(
  `${provider}: ${report.readings.length} readings (${reviews} needs-review, ${unreadable} unreadable)`,
);
