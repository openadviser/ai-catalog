// A run directory: one update run's evidence, reports and plan, uploaded as the run's
// workflow artifact (docs/trust-and-provenance.md).
//
//   <run>/manifest.json        mode, start and end, the saved evidence directories read
//   <run>/evidence/            a live run's bodies and retrieval records (never evidence/)
//   <run>/reports/<id>.json    one ReadReport per source
//   <run>/plan.json            the reconciler's plan
//   <run>/<partition>/…        a built partition: summary, body, bundle
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReadReport } from "@openadviser/ai-catalog-readers-kit";
import {
  CROSS_CHECKS,
  type Fetcher,
  readSource,
  SOURCES_OF_TRUTH,
  type SourceId,
} from "../../readers/run.ts";
import type { BodyLookup } from "./excerpt.ts";
import type { Acknowledgement, Catalog, Plan, Policy } from "./model.ts";
import { reconcile } from "./plan.ts";

export const ROOT = resolve(new URL("../..", import.meta.url).pathname);

/** The saved evidence an evidence-mode run reads: the repository's, and the cross-check fixtures. */
export const SAVED_EVIDENCE_DIRS = [
  "evidence",
  "readers/models-dev/fixtures/evidence",
  "readers/genai-prices/fixtures/evidence",
];

export interface Manifest {
  mode: "evidence" | "live";
  startedAt: string;
  finishedAt: string;
  /** Directories evidence was read from, relative to the repository root. */
  evidenceDirs: string[];
  /** The run's own evidence directory, relative to the run directory, when live. */
  storeDir?: string;
  sources: SourceId[];
}

export function nowInstant(date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export interface ReadAllOptions {
  live: boolean;
  runDir: string;
  root?: string;
  catalog: unknown;
  env?: Record<string, string | undefined>;
  fetch?: Fetcher;
  /** Saved evidence directories for evidence mode, relative to `root`. */
  evidenceDirs?: string[];
  now?: () => Date;
}

/** Reads every source into the run directory. An unreadable source never fails the run. */
export async function readAll(options: ReadAllOptions): Promise<Manifest> {
  const root = options.root ?? ROOT;
  const clock = options.now ?? (() => new Date());
  mkdirSync(join(options.runDir, "reports"), { recursive: true });
  const storeDir = join(options.runDir, "evidence");
  if (options.live) mkdirSync(storeDir, { recursive: true });
  const evidenceDirs = options.live ? [] : (options.evidenceDirs ?? SAVED_EVIDENCE_DIRS);
  const startedAt = nowInstant(clock());
  const sources: SourceId[] = [...SOURCES_OF_TRUTH, ...CROSS_CHECKS];
  for (const id of sources) {
    let report: ReadReport;
    try {
      report = await readSource(id, {
        live: options.live,
        catalog: options.catalog,
        evidenceDirs: evidenceDirs.map((d) => resolve(root, d)),
        storeDir,
        client: "ai-catalog update (reconcile/src/run.ts)",
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
    } catch (error) {
      // A reader bug must not hide the other sources: the source is unreadable.
      report = {
        provider: id,
        mode: options.live ? "live" : "evidence",
        role: (CROSS_CHECKS as readonly string[]).includes(id) ? "cross-check" : "source-of-truth",
        lineage: [id],
        sources: [],
        readings: [
          {
            kind: "observation",
            provider: id,
            outcome: "unreadable",
            reasons: [
              {
                code: "reader-error",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            source: id,
          },
        ],
      };
    }
    writeFileSync(
      join(options.runDir, "reports", `${id}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  const manifest: Manifest = {
    mode: options.live ? "live" : "evidence",
    startedAt,
    finishedAt: nowInstant(clock()),
    evidenceDirs,
    sources,
  };
  if (options.live) manifest.storeDir = "evidence";
  writeFileSync(join(options.runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface LoadedRun {
  runDir: string;
  manifest: Manifest;
  reports: ReadReport[];
  /** Every evidence directory this run can cite: its own, then the saved ones. */
  evidenceDirs: string[];
  lookup: BodyLookup;
}

export function loadRun(runDir: string, root = ROOT): LoadedRun {
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as Manifest;
  const reports = manifest.sources.map(
    (id) => JSON.parse(readFileSync(join(runDir, "reports", `${id}.json`), "utf8")) as ReadReport,
  );
  const evidenceDirs = [
    ...(manifest.storeDir !== undefined ? [join(runDir, manifest.storeDir)] : []),
    ...manifest.evidenceDirs.map((d) => resolve(root, d)),
  ];
  const cache = new Map<string, Buffer | undefined>();
  const lookup: BodyLookup = (sha) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) return undefined;
    if (cache.has(sha)) return cache.get(sha);
    let found: Buffer | undefined;
    for (const dir of evidenceDirs) {
      const path = join(dir, sha);
      if (existsSync(path)) {
        found = readFileSync(path);
        break;
      }
    }
    cache.set(sha, found);
    return found;
  };
  return { runDir, manifest, reports, evidenceDirs, lookup };
}

export function readPolicy(root = ROOT): { policy: Policy; acknowledgements: Acknowledgement[] } {
  const policy = JSON.parse(
    readFileSync(join(root, "reconcile", "policy.json"), "utf8"),
  ) as Policy & {
    $comment?: unknown;
  };
  const acks = JSON.parse(readFileSync(join(root, "reconcile", "acknowledged.json"), "utf8")) as {
    acknowledged: Acknowledgement[];
  };
  if (!/^[1-9][0-9]*(\.[0-9]+)?$/.test(policy.factor))
    throw new Error("policy.factor is not a decimal ≥ 1");
  if (
    !Number.isInteger(policy.crossChecks?.minIndependent) ||
    policy.crossChecks.minIndependent < 1
  )
    throw new Error("policy.crossChecks.minIndependent is not a positive integer");
  return {
    policy: {
      factor: policy.factor,
      crossChecks: { minIndependent: policy.crossChecks.minIndependent },
    },
    acknowledgements: acks.acknowledged,
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reconciles a loaded run against a catalog file and writes `<run>/plan.json`. */
export function planRun(run: LoadedRun, catalogPath: string, now: string, root = ROOT): Plan {
  const bytes = readFileSync(catalogPath);
  const catalog = JSON.parse(bytes.toString("utf8")) as Catalog;
  const { policy, acknowledgements } = readPolicy(root);
  const plan = reconcile({
    catalog,
    catalogSha256: sha256(bytes),
    reports: run.reports,
    policy,
    acknowledgements,
    now,
    lookup: run.lookup,
  });
  writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

/** Every retrieval record file of a body in the given directories. */
export function recordFiles(dirs: string[], sha: string): { dir: string; name: string }[] {
  const out: { dir: string; name: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${sha}.`) && name.endsWith(".json")) out.push({ dir, name });
    }
  }
  return out;
}
