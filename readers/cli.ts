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
  anthropicModelPageUrls,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import { ELEVENLABS_URLS, readElevenlabs } from "@openadviser/ai-catalog-reader-elevenlabs";
import { GEMINI_URLS, readGemini } from "@openadviser/ai-catalog-reader-gemini";
import {
  OPENAI_URLS,
  modelPageUrl as openaiModelPageUrl,
  openaiModelPageUrls,
  readOpenai,
} from "@openadviser/ai-catalog-reader-openai";
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
import {
  anthropicListSpec,
  apiRead,
  elevenlabsListSpec,
  fetchModelPages,
  geminiListSpec,
  openaiListSpec,
  unreadableObservation,
} from "./api-read.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EVIDENCE_DIR = join(ROOT, "evidence");
const CATALOG = join(ROOT, "data", "catalog.json");
const CLIENT = "npm run read (readers/cli.ts)";

const provider = process.argv[2];
const live = process.argv.includes("--live");

const PROVIDERS = ["anthropic", "google-gemini", "openai", "elevenlabs"] as const;
if (provider === undefined || !PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
  console.error(`usage: npm run read -- <${PROVIDERS.join("|")}> [--live]`);
  process.exit(2);
}
const providerName: string = provider;

const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as unknown;
const scope = trackedScope(catalog, providerName);
const store = new EvidenceStore(EVIDENCE_DIR);

async function page(url: string, source: string): Promise<Evidence | undefined> {
  if (!live) {
    const saved = store.latest(url);
    if (saved !== undefined) return saved;
    unreadableObservation(report, source, "fetch-failed", `${url}: no saved evidence`);
    return undefined;
  }
  try {
    const fetched = await fetchPage(url);
    if (fetched.status === 200) return storeEvidence(EVIDENCE_DIR, fetched, CLIENT);
    unreadableObservation(report, source, "fetch-failed", `${url}: status ${fetched.status}`);
  } catch (error) {
    unreadableObservation(
      report,
      source,
      "fetch-failed",
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return undefined;
}

/** The documented model-page URL for a tracked model outside the comparison table. */
const modelPages = new Map<string, Evidence>();
function anthropicModelPage(modelId: string): Evidence | undefined {
  const url = modelPageUrl(modelId.replace(/^claude-/, ""));
  if (!live) return store.latest(url);
  return modelPages.get(modelId);
}
function openaiModelPage(modelId: string): Evidence | undefined {
  if (!live) return store.latest(openaiModelPageUrl(modelId));
  return modelPages.get(modelId);
}

const report: ReadReport = {
  provider: providerName,
  mode: live ? "live" : "evidence",
  sources: [],
  readings: [],
};

if (providerName === "anthropic") {
  if (live) {
    // Every tracked model's page is fetched and stored; a failed fetch is an
    // unreadable observation and the run continues.
    const fetched = await fetchModelPages(
      report,
      "anthropic-model-page",
      anthropicModelPageUrls(scope),
      (url) => fetchPage(url),
      (p) => storeEvidence(EVIDENCE_DIR, p, CLIENT),
    );
    for (const [id, ev] of fetched) modelPages.set(id, ev);
  }
  const pricing = await page(ANTHROPIC_URLS.pricing, "anthropic-pricing");
  const models = await page(ANTHROPIC_URLS.models, "anthropic-models");
  const effort = await page(ANTHROPIC_URLS.effort, "anthropic-effort");
  const apiPages = await apiRead(
    report,
    live,
    "anthropic-models-api",
    "ANTHROPIC_API_KEY",
    anthropicApi,
  );
  const sources = {
    ...(pricing !== undefined ? { pricing } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(effort !== undefined ? { effort } : {}),
    modelPage: anthropicModelPage,
  };
  const result = readAnthropic(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = [...report.readings, ...result.readings];
} else if (providerName === "google-gemini") {
  const pricing = await page(GEMINI_URLS.pricing, "gemini-pricing");
  const thinking = await page(GEMINI_URLS.thinking, "gemini-thinking");
  const apiPages = await apiRead(report, live, "gemini-models", "GEMINI_API_KEY", geminiApi);
  const sources = {
    ...(pricing !== undefined ? { pricing } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  const result = readGemini(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = [...report.readings, ...result.readings];
} else if (providerName === "openai") {
  if (live) {
    const fetched = await fetchModelPages(
      report,
      "openai-model-page",
      openaiModelPageUrls(scope),
      (url) => fetchPage(url),
      (p) => storeEvidence(EVIDENCE_DIR, p, CLIENT),
    );
    for (const [id, ev] of fetched) modelPages.set(id, ev);
  }
  const pricing = await page(OPENAI_URLS.pricing, "openai-pricing");
  const apiPages = await apiRead(report, live, "openai-models-api", "OPENAI_API_KEY", openaiApi);
  const sources = {
    ...(pricing !== undefined ? { pricing } : {}),
    modelPage: openaiModelPage,
  };
  const result = readOpenai(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = [...report.readings, ...result.readings];
} else {
  const pricing = await page(ELEVENLABS_URLS.pricing, "elevenlabs-pricing");
  const models = await page(ELEVENLABS_URLS.models, "elevenlabs-models");
  const apiPages = await apiRead(
    report,
    live,
    "elevenlabs-models-api",
    "ELEVENLABS_API_KEY",
    elevenlabsApi,
  );
  const sources = {
    ...(pricing !== undefined ? { pricing } : {}),
    ...(models !== undefined ? { models } : {}),
  };
  const result = readElevenlabs(sources, scope, apiPages);
  report.sources = result.sources;
  report.readings = [...report.readings, ...result.readings];
}

async function anthropicApi() {
  const key = apiKey("ANTHROPIC_API_KEY");
  const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
  return readPaged<{ id?: string }>(
    anthropicListSpec(`${ANTHROPIC_URLS.apiModels}?limit=1000`),
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
    geminiListSpec(`${GEMINI_URLS.apiModels}?pageSize=1000`),
    (url) => fetchPage(url, { headers: { "x-goog-api-key": key } }),
    (page: FetchedPage) => storeEvidence(EVIDENCE_DIR, page, CLIENT),
  );
}

async function openaiApi() {
  const key = apiKey("OPENAI_API_KEY");
  const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
  return readPaged<{ id?: string }>(
    openaiListSpec(`${OPENAI_URLS.apiModels}`),
    (url) => fetchPage(url, { headers: { authorization: `Bearer ${key}` } }),
    (page: FetchedPage) => storeEvidence(EVIDENCE_DIR, page, CLIENT),
  );
}

async function elevenlabsApi() {
  const key = apiKey("ELEVENLABS_API_KEY");
  const { readPaged } = await import("@openadviser/ai-catalog-readers-kit");
  return readPaged<{ model_id?: string }>(
    elevenlabsListSpec(ELEVENLABS_URLS.apiModels),
    (url) => fetchPage(url, { headers: { "xi-api-key": key } }),
    (page: FetchedPage) => storeEvidence(EVIDENCE_DIR, page, CLIENT),
  );
}

const reviews = (report.readings as Reading[]).filter((r) => r.outcome === "needs-review").length;
const unreadable = (report.readings as Reading[]).filter((r) => r.outcome === "unreadable").length;
console.log(JSON.stringify(report, null, 2));
console.error(
  `${providerName}: ${report.readings.length} readings (${reviews} needs-review, ${unreadable} unreadable)`,
);
