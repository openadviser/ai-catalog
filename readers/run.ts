// Runs one source's reader and returns its ReadReport: the four sources of truth and the
// two cross-checks. `readers/cli.ts` and the update job (reconcile/) both call this.
//
// Evidence mode reads the newest saved body of each URL from `evidenceDirs`. Live mode
// fetches every page and stores the bytes and retrieval records under `storeDir` first;
// the update job points `storeDir` at the run's own directory, never at `evidence/`
// (docs/trust-and-provenance.md). An API list read runs only live, and a missing key
// makes that API source `not-configured`: the read is skipped, silent apart from the
// run summary.
import {
  ANTHROPIC_URLS,
  anthropicModelPageUrls,
  modelPageUrl,
  readAnthropic,
} from "@openadviser/ai-catalog-reader-anthropic";
import { ELEVENLABS_URLS, readElevenlabs } from "@openadviser/ai-catalog-reader-elevenlabs";
import { GEMINI_URLS, readGemini } from "@openadviser/ai-catalog-reader-gemini";
import {
  GENAI_PRICES_LINEAGE,
  GENAI_PRICES_URLS,
  genaiPricesDataUrl,
  genaiPricesProviderUrl,
  readGenaiPrices,
} from "@openadviser/ai-catalog-reader-genai-prices";
import {
  MODELS_DEV_LINEAGE,
  MODELS_DEV_URLS,
  readModelsDev,
} from "@openadviser/ai-catalog-reader-models-dev";
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
  type FetchOptions,
  fetchPage,
  type ReadReport,
  readPaged,
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

export const SOURCES_OF_TRUTH = ["anthropic", "google-gemini", "openai", "elevenlabs"] as const;
export const CROSS_CHECKS = ["models-dev", "genai-prices"] as const;
export type SourceOfTruth = (typeof SOURCES_OF_TRUTH)[number];
export type CrossCheck = (typeof CROSS_CHECKS)[number];
export type SourceId = SourceOfTruth | CrossCheck;

export function isSourceId(value: string): value is SourceId {
  return (SOURCES_OF_TRUTH as readonly string[])
    .concat(CROSS_CHECKS as readonly string[])
    .includes(value);
}

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchedPage>;

export interface RunOptions {
  live: boolean;
  /** The parsed `data/catalog.json` whose tracked scope the readers read. */
  catalog: unknown;
  /** Saved evidence directories, read in evidence mode; the newest retrieval of a URL wins. */
  evidenceDirs: string[];
  /** Where a live read stores bytes and retrieval records. Required when `live`. */
  storeDir?: string;
  env?: Record<string, string | undefined>;
  fetch?: Fetcher;
  /** The client named in retrieval records. */
  client?: string;
  /**
   * Report an API source whose key is absent as `not-configured` even without `live`.
   * The update run sets it so a dry run on saved evidence shows what a live run would skip.
   */
  reportNotConfigured?: boolean;
}

/** The newest saved body of a URL across several evidence directories. */
export class SavedEvidence {
  private readonly stores: EvidenceStore[];

  constructor(dirs: string[]) {
    this.stores = dirs.map((dir) => new EvidenceStore(dir));
  }

  latest(url: string): Evidence | undefined {
    let best: Evidence | undefined;
    for (const store of this.stores) {
      const ev = store.latest(url);
      if (ev !== undefined && (best === undefined || ev.retrievedAt > best.retrievedAt)) best = ev;
    }
    return best;
  }

  body(sha256: string): Evidence | undefined {
    for (const store of this.stores) {
      const ev = store.body(sha256);
      if (ev !== undefined) return ev;
    }
    return undefined;
  }
}

/** Reads one source and returns its report. Never throws for an unreadable source. */
export async function readSource(id: SourceId, options: RunOptions): Promise<ReadReport> {
  const live = options.live;
  if (live && options.storeDir === undefined) throw new Error("a live read needs storeDir");
  const env = options.env ?? process.env;
  const fetcher: Fetcher = options.fetch ?? fetchPage;
  const client = options.client ?? "ai-catalog readers/run.ts";
  const saved = new SavedEvidence(options.evidenceDirs);
  const keep = (page: FetchedPage): Evidence =>
    storeEvidence(options.storeDir as string, page, client);
  const crossCheck = (CROSS_CHECKS as readonly string[]).includes(id);
  const checkKey = live || options.reportNotConfigured === true;
  const report: ReadReport = {
    provider: id,
    mode: live ? "live" : "evidence",
    role: crossCheck ? "cross-check" : "source-of-truth",
    lineage:
      id === "models-dev"
        ? MODELS_DEV_LINEAGE
        : id === "genai-prices"
          ? GENAI_PRICES_LINEAGE
          : [id],
    sources: [],
    readings: [],
  };

  async function page(url: string, source: string): Promise<Evidence | undefined> {
    if (!live) {
      const ev = saved.latest(url);
      if (ev !== undefined) return ev;
      unreadableObservation(report, source, "fetch-failed", `${url}: no saved evidence`);
      return undefined;
    }
    try {
      const fetched = await fetcher(url);
      if (fetched.status === 200) return keep(fetched);
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

  const modelPages = new Map<string, Evidence>();

  if (id === "anthropic") {
    const scope = trackedScope(options.catalog, id);
    if (live) {
      const fetched = await fetchModelPages(
        report,
        "anthropic-model-page",
        anthropicModelPageUrls(scope),
        (url) => fetcher(url),
        keep,
      );
      for (const [modelId, ev] of fetched) modelPages.set(modelId, ev);
    }
    const pricing = await page(ANTHROPIC_URLS.pricing, "anthropic-pricing");
    const models = await page(ANTHROPIC_URLS.models, "anthropic-models");
    const effort = await page(ANTHROPIC_URLS.effort, "anthropic-effort");
    const apiPages = await apiRead(
      report,
      live,
      "anthropic-models-api",
      "ANTHROPIC_API_KEY",
      () => {
        const key = apiKey("ANTHROPIC_API_KEY", env);
        return readPaged<{ id?: string }>(
          anthropicListSpec(`${ANTHROPIC_URLS.apiModels}?limit=1000`),
          (url) =>
            fetcher(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }),
          keep,
        );
      },
      env,
      checkKey,
    );
    const result = readAnthropic(
      {
        ...(pricing !== undefined ? { pricing } : {}),
        ...(models !== undefined ? { models } : {}),
        ...(effort !== undefined ? { effort } : {}),
        modelPage: (modelId) =>
          live
            ? modelPages.get(modelId)
            : saved.latest(modelPageUrl(modelId.replace(/^claude-/, ""))),
      },
      scope,
      apiPages,
    );
    report.sources = result.sources;
    report.readings = [...report.readings, ...result.readings];
  } else if (id === "google-gemini") {
    const scope = trackedScope(options.catalog, id);
    const pricing = await page(GEMINI_URLS.pricing, "gemini-pricing");
    const thinking = await page(GEMINI_URLS.thinking, "gemini-thinking");
    const apiPages = await apiRead(
      report,
      live,
      "gemini-models",
      "GEMINI_API_KEY",
      () => {
        // The key travels in a header, so no credential lands in an evidence URL.
        const key = apiKey("GEMINI_API_KEY", env);
        return readPaged<{ name?: string }>(
          geminiListSpec(`${GEMINI_URLS.apiModels}?pageSize=1000`),
          (url) => fetcher(url, { headers: { "x-goog-api-key": key } }),
          keep,
        );
      },
      env,
      checkKey,
    );
    const result = readGemini(
      {
        ...(pricing !== undefined ? { pricing } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
      },
      scope,
      apiPages,
    );
    report.sources = result.sources;
    report.readings = [...report.readings, ...result.readings];
  } else if (id === "openai") {
    const scope = trackedScope(options.catalog, id);
    if (live) {
      const fetched = await fetchModelPages(
        report,
        "openai-model-page",
        openaiModelPageUrls(scope),
        (url) => fetcher(url),
        keep,
      );
      for (const [modelId, ev] of fetched) modelPages.set(modelId, ev);
    }
    const pricing = await page(OPENAI_URLS.pricing, "openai-pricing");
    const apiPages = await apiRead(
      report,
      live,
      "openai-models-api",
      "OPENAI_API_KEY",
      () => {
        const key = apiKey("OPENAI_API_KEY", env);
        return readPaged<{ id?: string }>(
          openaiListSpec(OPENAI_URLS.apiModels),
          (url) => fetcher(url, { headers: { authorization: `Bearer ${key}` } }),
          keep,
        );
      },
      env,
      checkKey,
    );
    const result = readOpenai(
      {
        ...(pricing !== undefined ? { pricing } : {}),
        modelPage: (modelId) =>
          live ? modelPages.get(modelId) : saved.latest(openaiModelPageUrl(modelId)),
      },
      scope,
      apiPages,
    );
    report.sources = result.sources;
    report.readings = [...report.readings, ...result.readings];
  } else if (id === "elevenlabs") {
    const scope = trackedScope(options.catalog, id);
    const pricing = await page(ELEVENLABS_URLS.pricing, "elevenlabs-pricing");
    const models = await page(ELEVENLABS_URLS.models, "elevenlabs-models");
    const apiPages = await apiRead(
      report,
      live,
      "elevenlabs-models-api",
      "ELEVENLABS_API_KEY",
      () => {
        const key = apiKey("ELEVENLABS_API_KEY", env);
        return readPaged<{ model_id?: string }>(
          elevenlabsListSpec(ELEVENLABS_URLS.apiModels),
          (url) => fetcher(url, { headers: { "xi-api-key": key } }),
          keep,
        );
      },
      env,
      checkKey,
    );
    const result = readElevenlabs(
      {
        ...(pricing !== undefined ? { pricing } : {}),
        ...(models !== undefined ? { models } : {}),
      },
      scope,
      apiPages,
    );
    report.sources = result.sources;
    report.readings = [...report.readings, ...result.readings];
  } else if (id === "models-dev") {
    const api = await page(MODELS_DEV_URLS.api, "models-dev");
    if (api !== undefined) {
      const result = readModelsDev(api, options.catalog);
      report.sources = result.sources;
      report.readings = [...report.readings, ...result.readings];
    }
  } else {
    // genai-prices: the published file's latest commit first, then the file and the
    // provider files at that commit, so the revision and the bytes are one snapshot.
    const commits = await page(GENAI_PRICES_URLS.commits, "genai-prices-revision");
    if (commits !== undefined) {
      let sha: string | undefined;
      try {
        sha = commitSha(commits);
      } catch (error) {
        unreadableObservation(
          report,
          "genai-prices-revision",
          "wrong-document",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (sha !== undefined) {
        const data = await page(genaiPricesDataUrl(sha), "genai-prices");
        const providerFiles = new Map<string, Evidence>();
        for (const name of ["anthropic", "openai", "google"]) {
          const ev = await page(genaiPricesProviderUrl(sha, name), "genai-prices-checked");
          if (ev !== undefined) providerFiles.set(name, ev);
        }
        if (data !== undefined) {
          const result = readGenaiPrices({ commits, data, providerFiles }, options.catalog);
          report.sources = result.sources;
          report.readings = [...report.readings, ...result.readings];
        }
      }
    }
  }
  return report;
}

/** The sha of the newest commit in a GitHub commits-API response. */
export function commitSha(commits: Evidence): string {
  const parsed = JSON.parse(commits.text) as unknown;
  const first = Array.isArray(parsed) ? (parsed[0] as { sha?: unknown } | undefined) : undefined;
  if (typeof first?.sha !== "string" || !/^[0-9a-f]{40}$/.test(first.sha)) {
    throw new Error(`${commits.url}: not a commits list with a sha`);
  }
  return first.sha;
}
