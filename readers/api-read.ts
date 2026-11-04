// The --live plumbing shared by the CLI's page and API reads: a fetch or parse
// failure, or a missing API key, becomes an `unreadable` observation in the
// report, never an aborted run, and a paginated list that advertises another
// page without a usable cursor is never a silent end of list.
import {
  type ApiPage,
  asArray,
  asObject,
  type Evidence,
  type FetchedPage,
  type PagedRead,
  type PageLoader,
  type PaginatedSpec,
  type ReadReport,
  Unreadable,
} from "@openadviser/ai-catalog-readers-kit";

/** Pushes one `unreadable` observation onto the report. */
export function unreadableObservation(
  report: ReadReport,
  source: string,
  code: string,
  message: string,
  modelId?: string,
): void {
  report.readings.push({
    kind: "observation",
    provider: report.provider,
    ...(modelId !== undefined ? { modelId } : {}),
    outcome: "unreadable",
    reasons: [{ code, message }],
    source,
  });
}

export async function apiRead(
  report: ReadReport,
  live: boolean,
  source: string,
  envName: string,
  run: () => Promise<PagedRead<unknown>>,
  env: Record<string, string | undefined> = process.env,
): Promise<ApiPage<unknown>[]> {
  if (!live) return [];
  const key = env[envName];
  if (key === undefined || key.trim() === "") {
    // A missing key makes this API source unreadable, never a failed run.
    unreadableObservation(report, source, "no-key", `no key: ${envName} is not set`);
    return [];
  }
  try {
    report.accountScope = { keyEnv: envName };
    const read = await run();
    if (read.failure !== undefined) {
      unreadableObservation(
        report,
        source,
        read.failure.code,
        `the Models API read stopped early: ${read.failure.message}`,
      );
    }
    return read.pages;
  } catch (error) {
    unreadableObservation(
      report,
      source,
      error instanceof Unreadable ? error.code : "fetch-failed",
      `the Models API read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * The per-model pages a live Anthropic read cites: every tracked model's page
 * is fetched and stored; a failed fetch becomes an `unreadable` observation
 * for that model and the run continues.
 */
export async function fetchModelPages(
  report: ReadReport,
  source: string,
  urls: { id: string; url: string }[],
  load: PageLoader,
  keep: (page: FetchedPage) => Evidence,
): Promise<Map<string, Evidence>> {
  const pages = new Map<string, Evidence>();
  for (const { id, url } of urls) {
    try {
      const fetched = await load(url);
      if (fetched.status === 200) {
        pages.set(id, keep(fetched));
      } else {
        unreadableObservation(
          report,
          source,
          "fetch-failed",
          `${url}: status ${fetched.status}`,
          id,
        );
      }
    } catch (error) {
      unreadableObservation(
        report,
        source,
        "fetch-failed",
        `${url}: ${error instanceof Error ? error.message : String(error)}`,
        id,
      );
    }
  }
  return pages;
}

/**
 * The continuation URL: `start` with the cursor parameter set through
 * `URL.searchParams`, so a start URL with no query still gets `?param=value`.
 */
function withCursor(start: string, param: string, value: string): string {
  const url = new URL(start);
  url.searchParams.set(param, value);
  return url.toString();
}

/**
 * The `GET /v1/models` list spec: `has_more` without a usable `last_id`
 * cursor throws Unreadable — never a silent end of list.
 */
export function anthropicListSpec(start: string): PaginatedSpec<{ id?: string }> {
  return {
    start,
    items: (json) =>
      asArray(asObject(json, "GET /v1/models").data, "GET /v1/models › data") as { id?: string }[],
    next: (json, url) => {
      const page = asObject(json, "GET /v1/models");
      if (page.has_more === undefined || page.has_more === false) return null;
      if (page.has_more !== true || typeof page.last_id !== "string" || page.last_id === "") {
        throw new Unreadable(
          "structure",
          `${url}: the list advertises another page but gives no usable last_id cursor`,
        );
      }
      return withCursor(start, "after_id", page.last_id);
    },
  };
}

/**
 * The `GET /v1beta/models` list spec: a `nextPageToken` that is not a
 * non-empty string throws Unreadable — never a silent end of list.
 */
export function geminiListSpec(start: string): PaginatedSpec<{ name?: string }> {
  return {
    start,
    items: (json) =>
      asArray(asObject(json, "GET /v1beta/models").models, "GET /v1beta/models › models") as {
        name?: string;
      }[],
    next: (json, url) => {
      const page = asObject(json, "GET /v1beta/models");
      const token = page.nextPageToken;
      if (token === undefined) return null;
      if (typeof token !== "string" || token === "") {
        throw new Unreadable(
          "structure",
          `${url}: the list advertises another page but gives no usable nextPageToken cursor`,
        );
      }
      return withCursor(start, "pageToken", token);
    },
  };
}

/**
 * The `GET /v1/models` list spec for OpenAI: a `has_more` page without a usable
 * `last_id` cursor throws Unreadable — never a silent end of list.
 */
export function openaiListSpec(start: string): PaginatedSpec<{ id?: string }> {
  return {
    start,
    items: (json) =>
      asArray(asObject(json, "GET /v1/models").data, "GET /v1/models › data") as { id?: string }[],
    next: (json, url) => {
      const page = asObject(json, "GET /v1/models");
      if (page.has_more === undefined || page.has_more === false) return null;
      if (page.has_more !== true || typeof page.last_id !== "string" || page.last_id === "") {
        throw new Unreadable(
          "structure",
          `${url}: the list advertises another page but gives no usable last_id cursor`,
        );
      }
      return withCursor(start, "after", page.last_id);
    },
  };
}

/**
 * The `GET /v1/models` list spec for ElevenLabs: the documented response is a
 * bare JSON array with no pagination cursor.
 */
export function elevenlabsListSpec(start: string): PaginatedSpec<{ model_id?: string }> {
  return {
    start,
    items: (json) => asArray(json, "GET /v1/models") as { model_id?: string }[],
    next: () => null,
  };
}
