// The GitHub side of the update and the release: branches, pull requests, commit statuses,
// issues and releases, through `git` and `gh`.
//
// This file imports nothing but Node's built-ins (a test enforces it). The jobs that hold
// a write token run only this file, never `npm ci` or any dependency: the trees, the
// checks and the bodies are made in read-only jobs and handed over as files.
//
//   node reconcile/src/github.ts propose  --run <dir> --partition confirmed|review
//   node reconcile/src/github.ts issues   --run <dir>
//   node reconcile/src/github.ts release  --dir <dir>
//
// Environment: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, DRY_RUN.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const STATUS_CONTEXT = "catalog-update/check";
const LABELS = {
  unreadable: {
    name: "source-unreadable",
    color: "b60205",
    description: "A source the update job could not read",
  },
  findings: {
    name: "catalog-review",
    color: "fbca04",
    description: "Catalog findings that wait for a person",
  },
};

type Partition = "confirmed" | "review";

interface PartitionSummary {
  partition: Partition;
  hasChanges: boolean;
  applied: string[];
  version: string;
  base?: string;
  commit?: string;
  tree?: string;
  check?: { passed: boolean; tree: string };
}

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
}

function run(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== "") appendFileSync(file, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

/** `git` with the token as an HTTP header for this one command; it is never persisted. */
function gitAuth(args: string[]): string {
  const basic = Buffer.from(`x-access-token:${env("GH_TOKEN")}`).toString("base64");
  return run("git", [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
    ...args,
  ]);
}

function runUrl(): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
}

function dryRun(): boolean {
  return process.env.DRY_RUN === "true";
}

function arg(args: string[], name: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

/** Fetches the bundle's commit and checks it is exactly the one the read-only job built and checked. */
export function verifyBundle(bundle: string, s: PartitionSummary): void {
  run("git", ["fetch", "--quiet", "--no-tags", bundle, "HEAD"]);
  const commit = run("git", ["rev-parse", "FETCH_HEAD"]);
  if (commit !== s.commit)
    throw new Error(`the bundle holds ${commit}, not the checked commit ${s.commit}`);
  if (run("git", ["rev-parse", `${commit}^{tree}`]) !== s.tree)
    throw new Error("the bundle's tree is not the checked tree");
  if (run("git", ["rev-parse", `${commit}^`]) !== s.base)
    throw new Error("the bundle's parent is not the base it was built on");
}

/** Every commit on `branch` that main lacks was made by the workflow. */
function onlyBotCommits(branch: string): boolean {
  const emails = run("git", ["log", "--format=%ae", `origin/main..origin/${branch}`])
    .split("\n")
    .filter((x) => x !== "");
  return emails.every((e) => e === BOT_EMAIL);
}

function openPr(repo: string, branch: string): { number: number; url: string } | undefined {
  const list = JSON.parse(
    run("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--base",
      "main",
      "--state",
      "open",
      "--json",
      "number,url",
    ]),
  ) as { number: number; url: string }[];
  return list[0];
}

export function propose(runDir: string, partition: Partition): void {
  const repo = env("GITHUB_REPOSITORY");
  const branch = partition === "confirmed" ? "catalog/confirmed" : "catalog/review";
  const dir = join(runDir, partition);
  if (!existsSync(join(dir, "summary.json"))) {
    // Nothing was built: main's catalog is not the latest release yet (a release is pending).
    console.log(`no ${partition} proposal in this run; pull requests are left as they are`);
    output("merged", "false");
    return;
  }
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as PartitionSummary;
  const bodyFile = join(dir, "body.md");
  const existing = openPr(repo, branch);
  output("merged", "false");
  if (!s.hasChanges) {
    if (existing !== undefined) {
      run("gh", [
        "pr",
        "comment",
        String(existing.number),
        "--repo",
        repo,
        "--body",
        `Nothing to propose as of ${runUrl()}; closing.`,
      ]);
      run("gh", ["pr", "close", String(existing.number), "--repo", repo, "--delete-branch"]);
      console.log(`closed ${existing.url}`);
    }
    return;
  }
  if (
    s.commit === undefined ||
    s.base === undefined ||
    s.tree === undefined ||
    s.check === undefined
  )
    throw new Error("the partition summary has changes but no sealed commit and check");
  verifyBundle(join(dir, "proposal.bundle"), s);
  run("git", ["fetch", "--quiet", "--no-tags", "origin", "main"]);
  const main = run("git", ["rev-parse", "origin/main"]);
  if (main !== s.base) {
    console.log(
      `main moved from ${s.base} to ${main} since the tree was built; the next run proposes again`,
    );
    return;
  }
  if (
    partition === "review" &&
    tryRun("git", ["ls-remote", "--exit-code", "--heads", "origin", branch]) !== undefined
  ) {
    gitAuth([
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!onlyBotCommits(branch)) {
      if (existing !== undefined)
        run("gh", [
          "pr",
          "comment",
          String(existing.number),
          "--repo",
          repo,
          "--body",
          `This branch has commits from a person, so ${runUrl()} did not refresh it. The run's proposal is in its artifact.`,
        ]);
      console.log(`${branch} has commits from a person; not refreshed`);
      return;
    }
  }
  gitAuth(["push", "--force", "origin", `${s.commit}:refs/heads/${branch}`]);
  const title =
    partition === "confirmed"
      ? `Catalog update: confirmed changes (${s.applied.length} group${s.applied.length === 1 ? "" : "s"})`
      : `Catalog review: changes that wait for a person (${s.applied.length} group${s.applied.length === 1 ? "" : "s"})`;
  let number: number;
  if (existing !== undefined) {
    run("gh", [
      "pr",
      "edit",
      String(existing.number),
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ]);
    number = existing.number;
  } else {
    const url = run("gh", [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ]);
    number = Number(url.split("/").pop());
  }
  run("gh", [
    "api",
    "--method",
    "POST",
    `repos/${repo}/statuses/${s.commit}`,
    "-f",
    `state=${s.check.passed ? "success" : "failure"}`,
    "-f",
    `context=${STATUS_CONTEXT}`,
    "-f",
    `description=npm run check ${s.check.passed ? "passed" : "failed"} on this exact tree`,
    "-f",
    `target_url=${runUrl()}`,
  ]);
  if (partition === "confirmed" && s.check.passed && !dryRun()) {
    // GitHub refuses the merge if the head moved from the checked commit, or main conflicts.
    run("gh", [
      "pr",
      "merge",
      String(number),
      "--repo",
      repo,
      "--squash",
      "--match-head-commit",
      s.commit,
      "--subject",
      `${title} (#${number})`,
      "--body",
      `Merged by the update workflow after npm run check passed on tree ${s.tree}: ${runUrl()}`,
    ]);
    output("merged", "true");
  }
}

interface IssuePlan {
  findings: { title: string; marker: string; open: boolean; body: string };
  unreadable: { source: string; title: string; marker: string; body: string }[];
}

interface Issue {
  number: number;
  title: string;
  body: string;
}

function ensureLabel(
  repo: string,
  label: { name: string; color: string; description: string },
): void {
  run("gh", [
    "label",
    "create",
    label.name,
    "--repo",
    repo,
    "--color",
    label.color,
    "--description",
    label.description,
    "--force",
  ]);
}

function openIssues(repo: string, label: string): Issue[] {
  return JSON.parse(
    run("gh", [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      label,
      "--limit",
      "200",
      "--json",
      "number,title,body",
    ]),
  ) as Issue[];
}

function bodyFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-catalog-issue-"));
  const file = join(dir, "body.md");
  writeFileSync(file, text);
  return file;
}

/** The lines that state a source's reasons, without the run link, to tell a new reason from the same one. */
function reasonLines(body: string): string {
  return body
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .join("\n");
}

export function issues(runDir: string): void {
  const repo = env("GITHUB_REPOSITORY");
  const plan = JSON.parse(readFileSync(join(runDir, "issues.json"), "utf8")) as IssuePlan;
  ensureLabel(repo, LABELS.unreadable);
  ensureLabel(repo, LABELS.findings);

  const unreadable = openIssues(repo, LABELS.unreadable.name);
  const current = new Set(plan.unreadable.map((u) => u.marker));
  for (const u of plan.unreadable) {
    const found = unreadable.find((i) => i.body.includes(u.marker));
    if (found === undefined) {
      run("gh", [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        u.title,
        "--label",
        LABELS.unreadable.name,
        "--body-file",
        bodyFile(u.body),
      ]);
      continue;
    }
    if (reasonLines(found.body) !== reasonLines(u.body))
      run("gh", [
        "issue",
        "comment",
        String(found.number),
        "--repo",
        repo,
        "--body",
        `The reason changed in ${runUrl()}:\n\n${reasonLines(u.body)}`,
      ]);
    run("gh", [
      "issue",
      "edit",
      String(found.number),
      "--repo",
      repo,
      "--body-file",
      bodyFile(u.body),
    ]);
  }
  for (const i of unreadable) {
    const marker = /<!-- ai-catalog:unreadable:[^>]+ -->/.exec(i.body)?.[0];
    if (marker !== undefined && !current.has(marker)) {
      run("gh", [
        "issue",
        "close",
        String(i.number),
        "--repo",
        repo,
        "--comment",
        `Read again in ${runUrl()}.`,
      ]);
    }
  }

  const findings = openIssues(repo, LABELS.findings.name).find((i) =>
    i.body.includes(plan.findings.marker),
  );
  if (plan.findings.open) {
    if (findings === undefined)
      run("gh", [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        plan.findings.title,
        "--label",
        LABELS.findings.name,
        "--body-file",
        bodyFile(plan.findings.body),
      ]);
    else
      run("gh", [
        "issue",
        "edit",
        String(findings.number),
        "--repo",
        repo,
        "--body-file",
        bodyFile(plan.findings.body),
      ]);
  } else if (findings !== undefined) {
    run("gh", [
      "issue",
      "close",
      String(findings.number),
      "--repo",
      repo,
      "--comment",
      `No findings as of ${runUrl()}.`,
    ]);
  }
}

interface ReleaseHandoff {
  action: "resume" | "publish";
  version: string;
  /** The release commit: the bundle's head for "publish", main's head for "resume". */
  commit: string;
  base: string;
  tree: string;
}

function sha256File(path: string): string {
  return run("sha256sum", [path]).split(/\s+/)[0] as string;
}

/**
 * Publishes a prepared release: the commit and the tag land atomically on main (never
 * forced); a draft release gets both files, which are downloaded back and compared; only
 * then is the release published and marked latest. A rerun resumes from what exists, and
 * a version that exists with different bytes fails.
 */
export function release(dir: string): void {
  const repo = env("GITHUB_REPOSITORY");
  const h = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseHandoff;
  const tag = `data-v${h.version}`;
  run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
  if (h.action === "publish") {
    run("git", ["fetch", "--quiet", "--no-tags", join(dir, "release.bundle"), "HEAD"]);
    if (run("git", ["rev-parse", "FETCH_HEAD"]) !== h.commit)
      throw new Error("the bundle is not the prepared release commit");
    if (run("git", ["rev-parse", `${h.commit}^{tree}`]) !== h.tree)
      throw new Error("the bundle's tree is not the checked tree");
  }
  const work = mkdtempSync(join(tmpdir(), "ai-catalog-release-"));
  const catalog = join(work, "catalog.json");
  const sidecar = join(work, "catalog.json.sha256");
  writeFileSync(catalog, execFileSync("git", ["show", `${h.commit}:data/catalog.json`]));
  writeFileSync(sidecar, execFileSync("git", ["show", `${h.commit}:data/catalog.json.sha256`]));
  if (readFileSync(sidecar, "utf8") !== `${sha256File(catalog)}  catalog.json\n`)
    throw new Error("catalog.json.sha256 does not match catalog.json");

  const remoteTag = tryRun("git", [
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  if (remoteTag !== undefined) {
    run("git", ["fetch", "--quiet", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
    const tagged = execFileSync("git", ["show", `refs/tags/${tag}:data/catalog.json`]);
    if (!Buffer.from(tagged).equals(readFileSync(catalog)))
      throw new Error(`${tag} already exists with different bytes; nothing is published`);
    console.log(`${tag} exists with these bytes; resuming`);
  } else if (h.action === "publish") {
    const main = run("git", ["rev-parse", "origin/main"]);
    if (main !== h.base)
      throw new Error(`main moved from ${h.base} to ${main}; the next release run publishes it`);
    if (dryRun()) {
      console.log(`dry run: would push ${h.commit} to main and tag ${tag}`);
      return;
    }
    // Atomic: the release commit and its tag land together or not at all. Never forced.
    gitAuth([
      "push",
      "--atomic",
      "origin",
      `${h.commit}:refs/heads/main`,
      `${h.commit}:refs/tags/${tag}`,
    ]);
  } else {
    throw new Error(`main carries ${h.version} but ${tag} does not exist`);
  }

  const view = tryRun("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"]);
  if (view === undefined) {
    const notes = existsSync(join(dir, "notes.md"))
      ? join(dir, "notes.md")
      : bodyFile(`Catalog data ${h.version}.`);
    run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--verify-tag",
      "--draft",
      "--title",
      `Data ${h.version}`,
      "--notes-file",
      notes,
      catalog,
      sidecar,
    ]);
  } else {
    const assets = (JSON.parse(view) as { assets: { name: string }[] }).assets.map((a) => a.name);
    for (const file of [catalog, sidecar]) {
      const name = file.split("/").pop() as string;
      if (!assets.includes(name)) run("gh", ["release", "upload", tag, "--repo", repo, file]);
    }
  }
  // The assets as served must be the bytes of the tagged commit.
  const back = mkdtempSync(join(tmpdir(), "ai-catalog-assets-"));
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "--dir",
    back,
    "--pattern",
    "catalog.json",
    "--pattern",
    "catalog.json.sha256",
  ]);
  for (const name of ["catalog.json", "catalog.json.sha256"]) {
    if (sha256File(join(back, name)) !== sha256File(join(work, name)))
      throw new Error(`the release asset ${name} differs from the tagged bytes`);
  }
  // Only now does "latest" move.
  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]);
  console.log(`published ${tag}`);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "propose") {
    const p = arg(args, "--partition");
    if (p !== "confirmed" && p !== "review") throw new Error("--partition is confirmed or review");
    propose(arg(args, "--run"), p);
  } else if (command === "issues") {
    issues(arg(args, "--run"));
  } else if (command === "release") {
    release(arg(args, "--dir"));
  } else {
    console.error("usage: node reconcile/src/github.ts <propose|issues|release> …");
    process.exit(2);
  }
}
