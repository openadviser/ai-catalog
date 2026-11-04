// Test scenarios: a live run whose fetcher serves the saved bytes, some of them mutated —
// no network, no keys. Every reader runs for real on the (mutated) bytes, so the
// readings carry exact citations and the excerpt check sees what a real run sees.
//
// Everything is pinned to the seed: the frozen seed catalog, and each URL's earliest
// saved body. The update job later changes data/catalog.json and commits newer pages;
// these tests run inside the update's own check, so they must not move with the data.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, type FetchedPage } from "@openadviser/ai-catalog-readers-kit";
import { SEED_CATALOG } from "../../readers/testing.ts";
import { hashLine } from "../../scripts/check-data.ts";
import { evidenceNeeded } from "../src/apply.ts";
import type { Catalog, Plan, Policy } from "../src/model.ts";
import { reconcile } from "../src/plan.ts";
import {
  type LoadedRun,
  loadRun,
  ROOT,
  readAll,
  readPolicy,
  SAVED_EVIDENCE_DIRS,
  sha256,
} from "../src/run.ts";
import { copyEvidence } from "../src/tree.ts";

/** The seed catalog's bytes and parsed form. */
export function seed(): { bytes: Buffer; catalog: Catalog } {
  const bytes = readFileSync(SEED_CATALOG);
  return { bytes, catalog: JSON.parse(bytes.toString("utf8")) as Catalog };
}

/** Each URL's earliest saved body: the seed's retrieval (cross-check fixtures have one). */
function seedBody(url: string): Buffer | undefined {
  for (const dir of SAVED_EVIDENCE_DIRS) {
    const store = new EvidenceStore(join(ROOT, dir));
    const record = store.recordsFor(url)[0];
    if (record !== undefined) return store.body(record.sha256)?.bytes;
  }
  return undefined;
}

/**
 * A scratch repository root holding the seed: the seed catalog and its hash, exactly the
 * evidence it cites, the schemas, the README, the policy and the cross-check fixtures.
 */
export function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-catalog-seed-"));
  for (const p of [
    "schema",
    "README.md",
    "reconcile/policy.json",
    "reconcile/acknowledged.json",
    "readers/models-dev/fixtures",
    "readers/genai-prices/fixtures",
  ])
    cpSync(join(ROOT, p), join(root, p), { recursive: true });
  const { bytes, catalog } = seed();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "catalog.json"), bytes);
  writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(bytes));
  const empty = { ...catalog, providers: [] } as Catalog;
  copyEvidence(root, evidenceNeeded(empty, catalog), [join(ROOT, "evidence")]);
  return root;
}

export const READ_AT = "2026-11-05T09:00:00Z";
export const NOW = "2026-11-05T10:00:00Z";

export const URLS = {
  anthropicPricing: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  geminiPricing: "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
  geminiThinking: "https://ai.google.dev/gemini-api/docs/thinking.md.txt",
  openaiPricing: "https://developers.openai.com/api/docs/pricing",
  elevenlabsPricing: "https://elevenlabs.io/pricing/api",
  elevenlabsModels: "https://elevenlabs.io/docs/overview/models",
  modelsDev: "https://models.dev/api.json",
  genaiData:
    "https://raw.githubusercontent.com/pydantic/genai-prices/46103ff230160ed751d68b5c2b19334b6c8f5132/prices/new_data/v2/data.json",
  genaiGoogle:
    "https://raw.githubusercontent.com/pydantic/genai-prices/46103ff230160ed751d68b5c2b19334b6c8f5132/prices/providers/google.yml",
  genaiAnthropic:
    "https://raw.githubusercontent.com/pydantic/genai-prices/46103ff230160ed751d68b5c2b19334b6c8f5132/prices/providers/anthropic.yml",
};

/** Replaces exactly one occurrence, or throws: a mutation that misses tests nothing. */
export function once(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`mutation target not found: ${from.slice(0, 80)}`);
  if (text.indexOf(from, first + 1) >= 0)
    throw new Error(`mutation target not unique: ${from.slice(0, 80)}`);
  return text.replace(from, to);
}

/** Replaces the first occurrence after `anchor`. */
export function afterAnchor(text: string, anchor: string, from: string, to: string): string {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor.slice(0, 80)}`);
  const i = text.indexOf(from, at);
  if (i < 0) throw new Error(`mutation target not found after the anchor: ${from.slice(0, 80)}`);
  return `${text.slice(0, i)}${to}${text.slice(i + from.length)}`;
}

export type Mutations = Record<string, (text: string) => string>;

export interface Scenario {
  run: LoadedRun;
  catalog: Catalog;
  catalogBytes: Buffer;
  plan: Plan;
  replan(policy?: Partial<Policy>, catalog?: Catalog): Plan;
}

export async function scenario(
  mutations: Mutations = {},
  options: { missing?: string[]; env?: Record<string, string>; catalog?: Catalog } = {},
): Promise<Scenario> {
  const fetch = async (url: string): Promise<FetchedPage> => {
    const saved = options.missing?.includes(url) ? undefined : seedBody(url);
    const mutate = mutations[url];
    let bytes = saved ?? Buffer.from("not found");
    if (saved !== undefined && mutate !== undefined) {
      const before = saved.toString("utf8");
      const text = mutate(before);
      if (text === before) throw new Error(`the mutation of ${url} changed nothing`);
      bytes = Buffer.from(text, "utf8");
    }
    return {
      requestedUrl: url,
      finalUrl: url,
      retrievedAt: READ_AT,
      status: saved === undefined ? 404 : 200,
      bytes,
      hops: [],
    };
  };
  const catalogBytes =
    options.catalog !== undefined
      ? Buffer.from(`${JSON.stringify(options.catalog, null, 2)}\n`)
      : seed().bytes;
  const catalog = JSON.parse(catalogBytes.toString("utf8")) as Catalog;
  const runDir = mkdtempSync(join(tmpdir(), "ai-catalog-scenario-"));
  await readAll({
    live: true,
    runDir,
    root: ROOT,
    catalog,
    fetch,
    env: options.env ?? {},
    now: () => new Date(NOW),
  });
  const run = loadRun(runDir, ROOT);
  const base = readPolicy(ROOT);
  const replan = (policy: Partial<Policy> = {}, c: Catalog = catalog): Plan =>
    reconcile({
      catalog: c,
      catalogSha256: sha256(Buffer.from(`${JSON.stringify(c, null, 2)}\n`)),
      reports: run.reports,
      policy: { ...base.policy, ...policy },
      acknowledgements: base.acknowledgements,
      now: NOW,
      lookup: run.lookup,
    });
  return { run, catalog, catalogBytes, plan: replan(), replan };
}

export const MD_SONNET_COST = '"cost":{"input":2,"output":10,"cache_read":0.2,"cache_write":2.5}';
export const MD_SONNET_DATES = '"release_date":"2026-06-29","last_updated":"2026-06-30"';
export const MD_SONNET_FRESH = '"release_date":"2026-06-29","last_updated":"2026-11-05"';

/**
 * Claude Sonnet 5's base input from $2 to $2.40, with the cache columns the page states as
 * multipliers of it moved to match (1.25×, 2×, 0.1×), and both trackers revised to agree.
 */
export function consistentSonnetInputChange(): Mutations {
  return {
    [URLS.anthropicPricing]: (t) =>
      once(
        t,
        "| $2 / MTok<sup>3</sup> | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             |",
        "| $2.40 / MTok<sup>3</sup> | $3 / MTok    | $4.80 / MTok       | $0.24 / MTok             |",
      ),
    [URLS.modelsDev]: (t) =>
      once(
        once(
          t,
          MD_SONNET_COST,
          '"cost":{"input":2.4,"output":10,"cache_read":0.24,"cache_write":3}',
        ),
        MD_SONNET_DATES,
        MD_SONNET_FRESH,
      ),
    [URLS.genaiData]: (t) =>
      afterAnchor(
        t,
        '"id":"claude-sonnet-5"',
        '"prices":{"input_mtok":2,"cache_write_mtok":2.5,"cache_read_mtok":0.2,"output_mtok":10,"cache_write_1h_mtok":4,',
        '"prices":{"input_mtok":2.4,"cache_write_mtok":3,"cache_read_mtok":0.24,"output_mtok":10,"cache_write_1h_mtok":4.8,',
      ),
    [URLS.genaiAnthropic]: (t) =>
      afterAnchor(
        t,
        "  - id: claude-sonnet-5\n",
        "prices_checked: 2026-10-19",
        "prices_checked: 2026-11-05",
      ),
  };
}

export function item(plan: Plan, predicate: (id: string) => boolean) {
  return plan.items.filter((i) => predicate(i.id));
}

export function group(plan: Plan, id: string) {
  return plan.groups.find((g) => g.id === id);
}
