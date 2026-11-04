// `node reconcile/src/cli.ts <command>` — the update and release steps, one command each.
// .github/workflows/update.yml and release.yml call exactly these; `dry-run` runs the same
// sequence locally (README of reconcile/).
//
//   read      [--live] --run <dir>                 read every source into the run directory
//   plan      --run <dir> [--now <instant>]         reconcile data/catalog.json with the run
//   baseline                                        is main's catalog the released bytes?
//   build     --run <dir> --partition <p> [--commit]  apply one partition to this tree
//   seal      --run <dir> --partition <p>           record the check, render the body, bundle
//   issues    --run <dir>                           render the issue bodies
//   release-prepare --dir <dir> [--now <instant>]   restamp data/ for the next release
//   release-seal    --dir <dir>                     commit the checked restamp, hand it over
//   dry-run   [--live] --out <dir>                  the whole update on saved evidence, locally
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkData, hashLine } from "../../scripts/check-data.ts";
import { loadSchemas } from "../../scripts/schemas.ts";
import { type BuiltPartition, buildPartition } from "./apply.ts";
import type { Catalog, Plan } from "./model.ts";
import { planRelease, releaseNotes } from "./release.ts";
import {
  type CheckResult,
  FINDINGS_MARKER,
  FINDINGS_TITLE,
  findingsBody,
  partitionBody,
  type RenderContext,
  summary,
  unreadableBody,
  unreadableMarker,
  unreadableTitle,
} from "./render.ts";
import { loadRun, nowInstant, planRun, ROOT, readAll, sha256 } from "./run.ts";
import { writeTree } from "./tree.ts";

export const BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

export const BRANCHES = { confirmed: "catalog/confirmed", review: "catalog/review" } as const;

type Partition = "confirmed" | "review";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(args: string[], name: string): string {
  const v = arg(args, name);
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

function partitionArg(args: string[]): Partition {
  const p = need(args, "--partition");
  if (p !== "confirmed" && p !== "review") throw new Error("--partition is confirmed or review");
  return p;
}

function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== "") appendFileSync(file, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function git(root: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
}

export function context(args: string[]): RenderContext {
  const repo = arg(args, "--repo") ?? process.env.GITHUB_REPOSITORY ?? "openadviser/ai-catalog";
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    arg(args, "--run-url") ??
    (runId !== undefined ? `${server}/${repo}/actions/runs/${runId}` : "(local dry run)");
  return {
    repo,
    runUrl,
    ref: arg(args, "--ref") ?? "main",
    baseRef: arg(args, "--base-ref") ?? "main",
    dryRun: args.includes("--dry-run") || process.env.DRY_RUN === "true",
  };
}

export interface PartitionSummary {
  partition: Partition;
  hasChanges: boolean;
  applied: string[];
  skipped: { group: string; error: string }[];
  bodyOnly: string[];
  version: string;
  stamp: string;
  /** The commit the tree was built on, and the proposal commit and its tree. */
  base?: string;
  commit?: string;
  tree?: string;
  check?: { passed: boolean; tree: string };
}

/** Applies one partition of the run's plan to the tree at `root`. */
export function build(
  runDir: string,
  partition: Partition,
  root: string,
  requested: string,
  options: { commit: boolean; ctx: RenderContext },
): { built: BuiltPartition; summary: PartitionSummary } {
  const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
  const baselineBytes = readFileSync(join(root, "data", "catalog.json"));
  if (sha256(baselineBytes) !== plan.baseline.sha256)
    throw new Error("data/catalog.json is not the catalog the plan was made against; plan again");
  const baseline = JSON.parse(baselineBytes.toString("utf8")) as Catalog;
  // The provisional publishedAt must not precede any reading (check-data), nor the baseline's.
  // The review tree is built on another runner, whose clock may lag the read job's.
  const stamp = [requested, plan.now, baseline.publishedAt].sort().at(-1) as string;
  const built = buildPartition(baseline, plan, partition, stamp, loadSchemas(root));
  const dir = join(runDir, partition);
  mkdirSync(dir, { recursive: true });
  const s: PartitionSummary = {
    partition,
    hasChanges: built.applied.length > 0,
    applied: built.applied,
    skipped: built.skipped,
    bodyOnly: built.bodyOnly,
    version: built.version,
    stamp,
  };
  if (s.hasChanges) {
    const run = loadRun(runDir, root);
    writeTree(root, baseline, built, run.evidenceDirs);
    if (options.commit) {
      s.base = git(root, ["rev-parse", "HEAD"]);
      git(root, ["add", "data", "evidence", "README.md"]);
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: BOT.name,
        GIT_AUTHOR_EMAIL: BOT.email,
        GIT_COMMITTER_NAME: BOT.name,
        GIT_COMMITTER_EMAIL: BOT.email,
      };
      const title =
        partition === "confirmed"
          ? "Update the catalog: confirmed changes"
          : "Propose catalog changes for review";
      git(
        root,
        [
          "commit",
          "--quiet",
          "-m",
          `${title}\n\n${built.applied.length} group(s), read at ${plan.now}.\nRun: ${options.ctx.runUrl}`,
        ],
        env,
      );
      s.commit = git(root, ["rev-parse", "HEAD"]);
      s.tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    }
  }
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(s, null, 2)}\n`);
  writeFileSync(
    join(dir, "body.md"),
    partitionBody(plan, built, undefined, { ...options.ctx, ref: BRANCHES[partition] }),
  );
  writeFileSync(
    join(dir, "built.json"),
    `${JSON.stringify({ applied: built.applied, skipped: built.skipped }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "catalog.json"), built.bytes);
  return { built, summary: s };
}

/** Records the check result, renders the final body and bundles the proposal commit. */
export function seal(
  runDir: string,
  partition: Partition,
  root: string,
  ctx: RenderContext,
): PartitionSummary {
  const dir = join(runDir, partition);
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as PartitionSummary;
  const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
  const built = JSON.parse(readFileSync(join(dir, "built.json"), "utf8")) as Pick<
    BuiltPartition,
    "applied" | "skipped"
  >;
  let check: CheckResult | undefined;
  if (s.hasChanges) {
    const exitFile = join(dir, "check.exit");
    const passed = existsSync(exitFile) && readFileSync(exitFile, "utf8").trim() === "0";
    const log = existsSync(join(dir, "check.log"))
      ? readFileSync(join(dir, "check.log"), "utf8")
      : undefined;
    check = { passed, tree: s.tree ?? "(not committed)" };
    if (s.commit !== undefined) check.commit = s.commit;
    if (log !== undefined) check.log = log;
    s.check = { passed, tree: check.tree };
    if (s.commit !== undefined && s.base !== undefined) {
      if (git(root, ["rev-parse", "HEAD"]) !== s.commit)
        throw new Error("HEAD is not the built commit");
      git(root, [
        "bundle",
        "create",
        "--quiet",
        join(dir, "proposal.bundle"),
        "HEAD",
        `^${s.base}`,
      ]);
    }
  }
  const partial: BuiltPartition = {
    partition,
    stamp: s.stamp,
    version: s.version,
    catalog: JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as Catalog,
    bytes: readFileSync(join(dir, "catalog.json")),
    applied: built.applied,
    skipped: built.skipped,
    bodyOnly: s.bodyOnly,
  };
  writeFileSync(
    join(dir, "body.md"),
    partitionBody(plan, partial, check, { ...ctx, ref: BRANCHES[partition] }),
  );
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

export interface IssuePlan {
  findings: { title: string; marker: string; open: boolean; body: string };
  unreadable: { source: string; title: string; marker: string; body: string }[];
}

/** Renders the findings issue and one issue per unreadable source. */
export function issues(runDir: string, ctx: RenderContext): IssuePlan {
  const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
  const notApplied: { group: string; error: string }[] = [];
  for (const p of ["confirmed", "review"] as const) {
    const f = join(runDir, p, "summary.json");
    if (existsSync(f))
      notApplied.push(...(JSON.parse(readFileSync(f, "utf8")) as PartitionSummary).skipped);
  }
  const body = findingsBody(plan, ctx, notApplied);
  const findingsCount = body.match(/^#### /gm)?.length ?? 0;
  const bySource = new Map<string, Plan["unreadable"]>();
  for (const u of plan.unreadable) bySource.set(u.source, [...(bySource.get(u.source) ?? []), u]);
  const out: IssuePlan = {
    findings: {
      title: FINDINGS_TITLE,
      marker: FINDINGS_MARKER,
      open: findingsCount > 0 || notApplied.length > 0,
      body,
    },
    unreadable: [...bySource].map(([source, list]) => ({
      source,
      title: unreadableTitle(source),
      marker: unreadableMarker(source),
      body: unreadableBody(list, ctx),
    })),
  };
  writeFileSync(join(runDir, "issues.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** Whether `data-v<version>` holds main's exact catalog bytes. */
export function baselineReleased(root: string): { version: string; released: boolean } {
  const bytes = readFileSync(join(root, "data", "catalog.json"));
  const version = (JSON.parse(bytes.toString("utf8")) as Catalog).version;
  try {
    const tagged = execFileSync("git", [
      "-C",
      root,
      "show",
      `refs/tags/data-v${version}:data/catalog.json`,
    ]);
    return { version, released: Buffer.from(tagged).equals(bytes) };
  } catch {
    return { version, released: false };
  }
}

/** Restamps data/ for the next release; returns the plan. */
export function releasePrepare(root: string, now: string): ReturnType<typeof planRelease> {
  const main = readFileSync(join(root, "data", "catalog.json"));
  const tags = git(root, ["tag", "--list", "data-v*"])
    .split("\n")
    .filter((t) => t !== "");
  const plan = planRelease(
    main,
    tags,
    (version) => {
      try {
        return Buffer.from(
          execFileSync("git", ["-C", root, "show", `refs/tags/data-v${version}:data/catalog.json`]),
        );
      } catch {
        return undefined;
      }
    },
    now,
  );
  if (plan.action === "publish") {
    writeFileSync(join(root, "data", "catalog.json"), plan.bytes);
    writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(plan.bytes));
  }
  return plan;
}

/** The files a tree check needs, copied into a scratch root for the local dry run. */
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-catalog-dry-run-"));
  for (const p of ["data", "evidence", "schema", "README.md", "reconcile"])
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  for (const p of ["readers/models-dev/fixtures", "readers/genai-prices/fixtures"])
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  return dir;
}

function treeCheck(root: string, dir: string): void {
  const problems = checkData(root, loadSchemas(root));
  writeFileSync(
    join(dir, "check.log"),
    problems.length === 0 ? "data:check passed\n" : `${problems.join("\n")}\n`,
  );
  writeFileSync(join(dir, "check.exit"), problems.length === 0 ? "0\n" : "1\n");
}

/**
 * The update, locally: read (saved evidence unless --live), plan, build and check the
 * confirmed tree, restamp it as the release would, plan again on it, build and check the
 * review tree, render the issues. Nothing is pushed or filed. The local check is the
 * tree's data check; the workflow runs the full `npm run check`.
 */
export async function dryRun(options: {
  out: string;
  live?: boolean;
  now?: string;
  /** A run directory already read (a test scenario); otherwise the sources are read now. */
  runDir?: string;
  /** The scratch tree to build in; by default a copy of this repository's data. */
  root?: string;
}): Promise<{ plan: Plan; reviewPlan: Plan; root: string }> {
  const { out } = options;
  mkdirSync(out, { recursive: true });
  const root = options.root ?? scratchRoot();
  const ctx: RenderContext = {
    repo: "openadviser/ai-catalog",
    runUrl: "(local dry run)",
    ref: "main",
    baseRef: "main",
    dryRun: true,
  };
  const runDir = options.runDir ?? join(out, "run");
  const catalog = JSON.parse(readFileSync(join(root, "data", "catalog.json"), "utf8")) as unknown;
  const manifest =
    options.runDir !== undefined
      ? loadRun(runDir, root).manifest
      : await readAll({ live: options.live ?? false, runDir, root, catalog });
  const at = options.now ?? manifest.finishedAt;
  const plan = planRun(loadRun(runDir, root), join(root, "data", "catalog.json"), at, root);
  const confirmed = build(runDir, "confirmed", root, at, { commit: false, ctx });
  if (confirmed.summary.hasChanges) {
    treeCheck(root, join(runDir, "confirmed"));
    // As if merged and released: the release restamps the confirmed tree.
    const release = planRelease(
      readFileSync(join(root, "data", "catalog.json")),
      [],
      () => undefined,
      at,
    );
    writeFileSync(join(root, "data", "catalog.json"), release.bytes);
    writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(release.bytes));
  }
  seal(runDir, "confirmed", root, ctx);
  const confirmedSummary = JSON.parse(
    readFileSync(join(runDir, "confirmed", "summary.json"), "utf8"),
  );
  writeFileSync(join(out, "confirmed-body.md"), readFileSync(join(runDir, "confirmed", "body.md")));
  // The review plan runs on the new main, with the same readings.
  const reviewPlan = planRun(loadRun(runDir, root), join(root, "data", "catalog.json"), at, root);
  const review = build(runDir, "review", root, at, { commit: false, ctx });
  if (review.summary.hasChanges) treeCheck(root, join(runDir, "review"));
  seal(runDir, "review", root, ctx);
  writeFileSync(join(out, "review-body.md"), readFileSync(join(runDir, "review", "body.md")));
  const issuePlan = issues(runDir, ctx);
  writeFileSync(join(out, "findings-issue.md"), issuePlan.findings.body);
  for (const u of issuePlan.unreadable)
    writeFileSync(join(out, `unreadable-${u.source}.md`), u.body);
  writeFileSync(
    join(out, "summary.txt"),
    `${summary(plan)}\nConfirmed tree: ${confirmedSummary.hasChanges ? `changes, check ${confirmedSummary.check?.passed ? "passed" : "failed"}` : "no change"}.\nReview plan after the confirmed merge: ${summary(reviewPlan)}\n`,
  );
  return { plan, reviewPlan, root };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const root = resolve(arg(args, "--root") ?? ROOT);
  const ctx = context(args);
  switch (command) {
    case "read": {
      const runDir = resolve(need(args, "--run"));
      const catalog = JSON.parse(
        readFileSync(join(root, "data", "catalog.json"), "utf8"),
      ) as unknown;
      const m = await readAll({ live: args.includes("--live"), runDir, root, catalog });
      console.log(`read ${m.sources.length} sources (${m.mode}) ${m.startedAt} → ${m.finishedAt}`);
      return;
    }
    case "plan": {
      const runDir = resolve(need(args, "--run"));
      const run = loadRun(runDir, root);
      const plan = planRun(
        run,
        join(root, "data", "catalog.json"),
        arg(args, "--now") ?? run.manifest.finishedAt,
        root,
      );
      const text = summary(plan);
      console.log(text);
      const step = process.env.GITHUB_STEP_SUMMARY;
      if (step !== undefined && step !== "")
        appendFileSync(step, `${text.replace(/\n/g, "  \n")}\n`);
      output("confirmed", String(plan.groups.some((g) => g.partition === "confirmed")));
      output("review", String(plan.groups.some((g) => g.partition === "review")));
      return;
    }
    case "baseline": {
      const b = baselineReleased(root);
      console.log(
        `data/catalog.json ${b.version}: ${b.released ? "released" : "not released (a release is pending)"}`,
      );
      output("released", String(b.released));
      output("version", b.version);
      return;
    }
    case "build": {
      const runDir = resolve(need(args, "--run"));
      const p = partitionArg(args);
      const { summary: s } = build(runDir, p, root, arg(args, "--now") ?? nowInstant(), {
        commit: args.includes("--commit"),
        ctx,
      });
      console.log(
        `${p}: ${s.applied.length} group(s) applied, ${s.skipped.length} not applied, ${s.bodyOnly.length} without a tree change`,
      );
      output("changes", String(s.hasChanges));
      return;
    }
    case "seal": {
      const runDir = resolve(need(args, "--run"));
      const s = seal(runDir, partitionArg(args), root, ctx);
      output("changes", String(s.hasChanges));
      output("passed", String(s.check?.passed ?? false));
      return;
    }
    case "issues": {
      const plan = issues(resolve(need(args, "--run")), ctx);
      console.log(
        `findings issue: ${plan.findings.open ? "open" : "close"}; unreadable sources: ${plan.unreadable.length}`,
      );
      return;
    }
    case "release-prepare": {
      const dir = resolve(need(args, "--dir"));
      mkdirSync(dir, { recursive: true });
      const previousBytes = (version: string | undefined) =>
        version === undefined
          ? undefined
          : (JSON.parse(
              execFileSync(
                "git",
                ["-C", root, "show", `refs/tags/data-v${version}:data/catalog.json`],
                { encoding: "utf8" },
              ),
            ) as Catalog);
      const r = releasePrepare(root, arg(args, "--now") ?? nowInstant());
      const next = JSON.parse(readFileSync(join(root, "data", "catalog.json"), "utf8")) as Catalog;
      writeFileSync(
        join(dir, "notes.md"),
        releaseNotes(previousBytes(r.previous), next, r.version),
      );
      writeFileSync(
        join(dir, "plan.json"),
        `${JSON.stringify({ action: r.action, version: r.version, publishedAt: r.publishedAt, rewritten: r.rewritten, previous: r.previous ?? null }, null, 2)}\n`,
      );
      console.log(
        `${r.action} ${r.version} (publishedAt ${r.publishedAt}, ${r.rewritten} bound(s) restamped, previous ${r.previous ?? "none"})`,
      );
      output("action", r.action);
      output("version", r.version);
      return;
    }
    case "release-seal": {
      // After the full check passed on the restamped tree: commit it and hand it over.
      const dir = resolve(need(args, "--dir"));
      const p = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as {
        action: "resume" | "publish";
        version: string;
      };
      const base = git(root, ["rev-parse", "HEAD"]);
      let commit = base;
      if (p.action === "publish") {
        const env = {
          ...process.env,
          GIT_AUTHOR_NAME: BOT.name,
          GIT_AUTHOR_EMAIL: BOT.email,
          GIT_COMMITTER_NAME: BOT.name,
          GIT_COMMITTER_EMAIL: BOT.email,
        };
        git(root, ["add", "data/catalog.json", "data/catalog.json.sha256"]);
        git(
          root,
          [
            "commit",
            "--quiet",
            "-m",
            `Release data ${p.version}\n\nRestamped by the release workflow: version, publishedAt and the pending bounds.\nRun: ${ctx.runUrl}`,
          ],
          env,
        );
        commit = git(root, ["rev-parse", "HEAD"]);
        git(root, ["bundle", "create", "--quiet", join(dir, "release.bundle"), "HEAD", `^${base}`]);
      }
      const handoff = {
        action: p.action,
        version: p.version,
        commit,
        base: p.action === "publish" ? base : git(root, ["rev-parse", "HEAD^"]),
        tree: git(root, ["rev-parse", "HEAD^{tree}"]),
      };
      writeFileSync(join(dir, "release.json"), `${JSON.stringify(handoff, null, 2)}\n`);
      output("commit", commit);
      return;
    }
    case "dry-run": {
      const out = resolve(need(args, "--out"));
      const runArg = arg(args, "--run");
      const nowArg = arg(args, "--now");
      const { plan } = await dryRun({
        out,
        live: args.includes("--live"),
        ...(nowArg !== undefined ? { now: nowArg } : {}),
        ...(runArg !== undefined ? { runDir: resolve(runArg) } : {}),
      });
      console.log(summary(plan));
      console.log(`bodies written to ${out}`);
      return;
    }
    default:
      console.error(
        "usage: node reconcile/src/cli.ts <read|plan|baseline|build|seal|issues|release-prepare|dry-run> …",
      );
      process.exit(2);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
