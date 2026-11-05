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
import { createHash } from "node:crypto";
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

/** The token as an HTTP header for one `git` command; it is never persisted. */
function authArgs(): string[] {
  const basic = Buffer.from(`x-access-token:${env("GH_TOKEN")}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/**
 * The commands this file runs. Every `git` command that reaches the remote goes through
 * `gitAuth`: the checkout keeps no credentials and the repository may be private, so an
 * unauthenticated fetch or ls-remote would fail, and a failed ls-remote must never read as
 * "absent". Tests replace the shell to check what would run.
 */
export interface Shell {
  run(cmd: string, args: string[]): string;
  /** Undefined when the command exits non-zero. */
  tryRun(cmd: string, args: string[]): string | undefined;
  gitAuth(args: string[]): string;
  /** Undefined when git exits non-zero. */
  tryGitAuth(args: string[]): string | undefined;
}

export const SHELL: Shell = {
  run,
  tryRun,
  gitAuth: (args) => run("git", [...authArgs(), ...args]),
  tryGitAuth: (args) => tryRun("git", [...authArgs(), ...args]),
};

function gitAuth(args: string[]): string {
  return SHELL.gitAuth(args);
}

/**
 * Whether `ref` exists on the remote. `git ls-remote` succeeds with no output when nothing
 * matches; a failure (auth, network) is not an answer and throws.
 */
function remoteHas(sh: Shell, ref: string): boolean {
  const listed = sh.tryGitAuth(["ls-remote", "origin", ref]);
  if (listed === undefined) throw new Error(`could not list ${ref} on the remote`);
  return listed.split("\n").some((l) => l.trim().endsWith(ref));
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
export function verifyBundle(bundle: string, s: PartitionSummary, sh: Shell = SHELL): void {
  sh.run("git", ["fetch", "--quiet", "--no-tags", bundle, "HEAD"]);
  const commit = sh.run("git", ["rev-parse", "FETCH_HEAD"]);
  if (commit !== s.commit)
    throw new Error(`the bundle holds ${commit}, not the checked commit ${s.commit}`);
  if (sh.run("git", ["rev-parse", `${commit}^{tree}`]) !== s.tree)
    throw new Error("the bundle's tree is not the checked tree");
  if (sh.run("git", ["rev-parse", `${commit}^`]) !== s.base)
    throw new Error("the bundle's parent is not the base it was built on");
}

/**
 * The remote `branch` as the workflow found it: its head, and whether it holds a commit the
 * workflow did not make — a person's work. Checked before anything closes, deletes or
 * force-pushes the branch; the push then leases that head, so a later push wins.
 */
export function branchState(branch: string, sh: Shell = SHELL): { head?: string; human: boolean } {
  if (!remoteHas(sh, `refs/heads/${branch}`)) return { human: false };
  sh.gitAuth([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const head = sh.run("git", ["rev-parse", `refs/remotes/origin/${branch}`]);
  const emails = sh
    .run("git", ["log", "--format=%ae%n%ce", `origin/main..origin/${branch}`])
    .split("\n")
    .filter((x) => x !== "");
  return { head, human: emails.some((e) => e !== BOT_EMAIL) };
}

/**
 * The open pull request from this repository's own `branch` into main. On a public repository anyone
 * can open a pull request from a fork branch of the same name, so the lookup asks the API for
 * `<owner>:<branch>` exactly and keeps only a head in this repository: a fork's pull request is never
 * edited, commented on, closed or merged as the workflow's own.
 */
function openPr(
  sh: Shell,
  repo: string,
  branch: string,
): { number: number; url: string } | undefined {
  const owner = repo.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const list = JSON.parse(
    sh.run("gh", ["api", `repos/${repo}/pulls?state=open&base=main&head=${head}&per_page=100`]),
  ) as { number: number; html_url: string; head: { repo: { full_name: string } | null } }[];
  const own = list.find((p) => p.head.repo?.full_name === repo);
  return own === undefined ? undefined : { number: own.number, url: own.html_url };
}

export function propose(runDir: string, partition: Partition, sh: Shell = SHELL): void {
  const run = sh.run;
  const gitAuth = sh.gitAuth;
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
  const existing = openPr(sh, repo, branch);
  output("merged", "false");
  // A branch a person has pushed to is never closed, deleted or force-pushed by the workflow,
  // on either partition, whatever this run proposes.
  const state = branchState(branch, sh);
  if (state.human) {
    if (existing !== undefined)
      run("gh", [
        "pr",
        "comment",
        String(existing.number),
        "--repo",
        repo,
        "--body",
        `This branch has commits from a person, so ${runUrl()} neither refreshed nor closed it. The run's proposal is in its artifact.`,
      ]);
    console.log(`${branch} has commits from a person; left as it is`);
    return;
  }
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
      // The branch is deleted leased on the head just checked, so a push made since then is kept:
      // the deletion fails, and the pull request stays open for the person who pushed.
      if (
        state.head !== undefined &&
        sh.tryGitAuth([
          "push",
          `--force-with-lease=refs/heads/${branch}:${state.head}`,
          "origin",
          `:refs/heads/${branch}`,
        ]) === undefined
      ) {
        console.log(`${branch} moved since it was checked; left open`);
        return;
      }
      // Deleting the head branch may already have closed it.
      sh.tryRun("gh", ["pr", "close", String(existing.number), "--repo", repo]);
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
  verifyBundle(join(dir, "proposal.bundle"), s, sh);
  gitAuth(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = run("git", ["rev-parse", "origin/main"]);
  if (main !== s.base) {
    console.log(
      `main moved from ${s.base} to ${main} since the tree was built; the next run proposes again`,
    );
    return;
  }
  // Leased on the head just checked (or on its absence): a push made since then makes this
  // push fail rather than overwrite it.
  gitAuth([
    "push",
    `--force-with-lease=refs/heads/${branch}:${state.head ?? ""}`,
    "origin",
    `${s.commit}:refs/heads/${branch}`,
  ]);
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
  /** Sources now not configured: their stale unreadable issues are closed, not opened. */
  notConfigured: { source: string; marker: string; env?: string }[];
}

interface Issue {
  number: number;
  title: string;
  body: string;
}

function ensureLabel(
  sh: Shell,
  repo: string,
  label: { name: string; color: string; description: string },
): void {
  sh.run("gh", [
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

/** The account the issues job writes as: GITHUB_TOKEN acts as the GitHub Actions bot. */
const ISSUE_AUTHOR = process.env.CATALOG_ISSUE_AUTHOR ?? "github-actions[bot]";

/**
 * The open issues with `label` that this workflow opened. A marker is only text in a body that an
 * issue's author can edit, so an issue by anyone else is never taken for the workflow's own, even if
 * someone labels it.
 */
function openIssues(sh: Shell, repo: string, label: string): Issue[] {
  // Every page, as one array of pages (`--slurp`), so an issue past the first page is never taken
  // for absent and duplicated, or left open.
  const pages = JSON.parse(
    sh.run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    ]),
  ) as {
    number: number;
    title: string;
    body: string | null;
    user: { login: string } | null;
    pull_request?: unknown;
  }[][];
  return pages
    .flat()
    .filter((i) => i.pull_request === undefined && i.user?.login === ISSUE_AUTHOR)
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "" }));
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

export function issues(runDir: string, sh: Shell = SHELL): void {
  const repo = env("GITHUB_REPOSITORY");
  const plan = JSON.parse(readFileSync(join(runDir, "issues.json"), "utf8")) as IssuePlan;
  ensureLabel(sh, repo, LABELS.unreadable);
  ensureLabel(sh, repo, LABELS.findings);

  const unreadable = openIssues(sh, repo, LABELS.unreadable.name);
  const current = new Set(plan.unreadable.map((u) => u.marker));
  for (const u of plan.unreadable) {
    const found = unreadable.find((i) => i.body.includes(u.marker));
    if (found === undefined) {
      sh.run("gh", [
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
      sh.run("gh", [
        "issue",
        "comment",
        String(found.number),
        "--repo",
        repo,
        "--body",
        `The reason changed in ${runUrl()}:\n\n${reasonLines(u.body)}`,
      ]);
    sh.run("gh", [
      "issue",
      "edit",
      String(found.number),
      "--repo",
      repo,
      "--body-file",
      bodyFile(u.body),
    ]);
  }
  const notConfigured = new Map((plan.notConfigured ?? []).map((n) => [n.marker, n]));
  for (const i of unreadable) {
    const marker = /<!-- ai-catalog:unreadable:[^>]+ -->/.exec(i.body)?.[0];
    if (marker === undefined || current.has(marker)) continue;
    const nc = notConfigured.get(marker);
    sh.run("gh", [
      "issue",
      "close",
      String(i.number),
      "--repo",
      repo,
      "--comment",
      nc !== undefined
        ? `Not configured as of ${runUrl()}: ${nc.env ?? "the API key"} is not set.`
        : `Read again in ${runUrl()}.`,
    ]);
  }

  const findings = openIssues(sh, repo, LABELS.findings.name).find((i) =>
    i.body.includes(plan.findings.marker),
  );
  if (plan.findings.open) {
    if (findings === undefined)
      sh.run("gh", [
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
      sh.run("gh", [
        "issue",
        "edit",
        String(findings.number),
        "--repo",
        repo,
        "--body-file",
        bodyFile(plan.findings.body),
      ]);
  } else if (findings !== undefined) {
    sh.run("gh", [
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
  gitAuth(["fetch", "--quiet", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
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

  // A failed listing throws: "could not tell" never reads as "the tag does not exist".
  if (remoteHas(SHELL, `refs/tags/${tag}`)) {
    gitAuth(["fetch", "--quiet", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
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
  // Only now does "latest" move, and never backwards: a stale retry of an older version is
  // published (or verified) without taking "latest" from a newer one.
  // A failed lookup throws here, before the draft is published, so a rerun resumes.
  const published = publishedDataVersion(repo);
  const promote = shouldPromote(h.version, published);
  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", `--latest=${promote}`]);
  console.log(`published ${tag}${promote ? " as latest" : `; latest stays data-v${published}`}`);
}

export type Exec = (cmd: string, args: string[]) => string;

const execCapture: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The highest published (non-draft) data release's version, or null when there is none.
 * It is read from the full release list: an empty list is a real answer, while any failure
 * to list — network, authentication, a server error — throws, so "latest" is never moved
 * on a guess.
 */
export function publishedDataVersion(repo: string, exec: Exec = execCapture): string | null {
  let listed: string;
  try {
    listed = exec("gh", [
      "api",
      "--paginate",
      `repos/${repo}/releases`,
      "--jq",
      ".[] | select(.draft == false) | .tag_name",
    ]);
  } catch (error) {
    throw new Error(
      `could not list the releases, so "latest" is not moved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const versions = listed
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^data-v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$/.test(t))
    .map((t) => t.slice("data-v".length))
    .sort(compareVersions);
  return versions.at(-1) ?? null;
}

export type Publication =
  | { state: "published" }
  | { state: "pending"; reason: string }
  | { state: "mismatch"; reason: string };

/**
 * Whether `data-v<version>` is published: a GitHub release that exists, is not a draft, and
 * whose `catalog.json` and `catalog.json.sha256` are exactly `bytes` and their sidecar. A tag
 * alone, a missing release, a draft or a missing asset is a publication still pending; assets
 * with other bytes are a mismatch. A failed lookup (other than "no such release") throws.
 */
export function publication(
  repo: string,
  version: string,
  bytes: Buffer,
  exec: Exec = execCapture,
): Publication {
  const tag = `data-v${version}`;
  let release: { draft?: unknown; assets?: { name?: unknown }[] };
  try {
    release = JSON.parse(
      exec("gh", ["api", `repos/${repo}/releases/tags/${tag}`]),
    ) as typeof release;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = `${typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : ""} ${error instanceof Error ? error.message : String(error)}`;
    if (/HTTP 404|Not Found/.test(text))
      return { state: "pending", reason: `${tag} has no GitHub release` };
    throw new Error(`could not read the release ${tag}: ${text.trim()}`);
  }
  if (release.draft !== false) return { state: "pending", reason: `${tag} is still a draft` };
  const names = (release.assets ?? []).map((a) => a.name);
  for (const name of ["catalog.json", "catalog.json.sha256"])
    if (!names.includes(name)) return { state: "pending", reason: `${tag} has no ${name} asset` };
  const dir = mkdtempSync(join(tmpdir(), "ai-catalog-publication-"));
  exec("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "--dir",
    dir,
    "--pattern",
    "catalog.json",
    "--pattern",
    "catalog.json.sha256",
  ]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!readFileSync(join(dir, "catalog.json")).equals(bytes))
    return {
      state: "mismatch",
      reason: `${tag}'s catalog.json asset is not the tagged catalog's bytes`,
    };
  if (readFileSync(join(dir, "catalog.json.sha256"), "utf8") !== `${digest}  catalog.json\n`)
    return {
      state: "mismatch",
      reason: `${tag}'s catalog.json.sha256 asset is not the catalog's hash`,
    };
  return { state: "published" };
}

/** Whether `version` may become latest: no data release is published yet, or it is not older. */
export function shouldPromote(version: string, published: string | null): boolean {
  return published === null || compareVersions(version, published) >= 0;
}

/** Data versions compare as four integers (docs/versioning.md). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.([1-9][0-9]*)$/.exec(v);
    if (m === null) throw new Error(`not a data version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
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
