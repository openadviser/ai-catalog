// The GitHub side, with a fake shell that records every command: a branch a person has
// pushed to is never closed, deleted or force-pushed, on either partition; the force-push is
// leased on the head that was checked; and a remote that cannot be listed is an error, never
// an empty answer.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issues, propose, type Shell } from "../src/github.ts";

const BOT = "41898282+github-actions[bot]@users.noreply.github.com";
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TREE = "t".repeat(40);
const HEAD = "h".repeat(40);

interface Remote {
  /** The remote branch's commit authors and committers, or undefined when it does not exist. */
  branchEmails?: string[];
  openPr?: boolean;
  /** A newer pull request from a fork branch of the same name, listed first. */
  forkPr?: boolean;
  /** ls-remote fails (auth, network). */
  listFails?: boolean;
}

function shell(remote: Remote, calls: string[]): Shell {
  const answer = (cmd: string, args: string[]): string => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "gh" && args[0] === "api" && args[1]?.includes("/pulls?"))
      return JSON.stringify([
        ...(remote.forkPr === true
          ? [
              {
                number: 9,
                html_url: "https://x.test/pull/9",
                head: { repo: { full_name: "someone/ai-catalog" } },
              },
              { number: 10, html_url: "https://x.test/pull/10", head: { repo: null } },
            ]
          : []),
        ...(remote.openPr === true
          ? [
              {
                number: 7,
                html_url: "https://x.test/pull/7",
                head: { repo: { full_name: "openadviser/ai-catalog" } },
              },
            ]
          : []),
      ]);
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return "https://x.test/pull/8";
    if (args[0] === "ls-remote")
      return remote.branchEmails !== undefined ? `${HEAD}\t${args[2]}` : "";
    if (args[0] === "rev-parse") {
      if (args[1] === "FETCH_HEAD") return COMMIT;
      if (args[1] === `${COMMIT}^{tree}`) return TREE;
      if (args[1] === `${COMMIT}^`) return BASE;
      if (args[1] === "origin/main") return BASE;
      if (args[1]?.startsWith("refs/remotes/origin/")) return HEAD;
    }
    if (args[0] === "log") return (remote.branchEmails ?? []).join("\n");
    return "";
  };
  return {
    run: answer,
    tryRun: (cmd, args) => answer(cmd, args),
    gitAuth: (args) => answer("git", args),
    tryGitAuth: (args) =>
      remote.listFails === true && args[0] === "ls-remote" ? undefined : answer("git", args),
  };
}

function runDir(partition: "confirmed" | "review", hasChanges: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-catalog-github-"));
  mkdirSync(join(dir, partition));
  const summary = hasChanges
    ? {
        partition,
        hasChanges,
        applied: ["g"],
        version: "2026.11.05.1",
        base: BASE,
        commit: COMMIT,
        tree: TREE,
        check: { passed: true, tree: TREE },
      }
    : { partition, hasChanges, applied: [], version: "2026.11.05.1" };
  writeFileSync(join(dir, partition, "summary.json"), JSON.stringify(summary));
  writeFileSync(join(dir, partition, "body.md"), "body");
  return dir;
}

const saved = { ...process.env };
beforeEach(() => {
  process.env.GITHUB_REPOSITORY = "openadviser/ai-catalog";
  process.env.GITHUB_RUN_ID = "1";
  process.env.GH_TOKEN = "test";
  delete process.env.GITHUB_OUTPUT;
  delete process.env.DRY_RUN;
});
afterEach(() => {
  process.env = { ...saved };
});

const destructive = (calls: string[]) =>
  calls.filter((c) => / pr close | push |--delete-branch| pr merge /.test(` ${c} `));

describe("a branch a person has pushed to", () => {
  for (const partition of ["confirmed", "review"] as const) {
    for (const hasChanges of [false, true]) {
      it(`${partition}, ${hasChanges ? "with" : "without"} changes: never closed, deleted, force-pushed or merged`, () => {
        const calls: string[] = [];
        propose(
          runDir(partition, hasChanges),
          partition,
          shell(
            { branchEmails: [BOT, BOT, "person@example.com", "person@example.com"], openPr: true },
            calls,
          ),
        );
        expect(destructive(calls)).toEqual([]);
        expect(
          calls.some((c) => c.startsWith("gh pr comment 7") && c.includes("commits from a person")),
        ).toBe(true);
      });
    }
  }
});

describe("a branch only the workflow has pushed to", () => {
  it("is closed and deleted when the run proposes nothing", () => {
    const calls: string[] = [];
    propose(
      runDir("review", false),
      "review",
      shell({ branchEmails: [BOT, BOT], openPr: true }, calls),
    );
    expect(destructive(calls)).toEqual([
      `git push --force-with-lease=refs/heads/catalog/review:${HEAD} origin :refs/heads/catalog/review`,
      "gh pr close 7 --repo openadviser/ai-catalog",
    ]);
  });

  it("is left open when it moved after the check: the leased deletion fails first", () => {
    const calls: string[] = [];
    const base = shell({ branchEmails: [BOT, BOT], openPr: true }, calls);
    const sh: Shell = {
      ...base,
      tryGitAuth: (args) =>
        args[0] === "push"
          ? (calls.push(`git ${args.join(" ")}`), undefined)
          : base.tryGitAuth(args),
    };
    propose(runDir("review", false), "review", sh);
    expect(calls.some((c) => c.startsWith("gh pr close"))).toBe(false);
  });

  it("is refreshed with a push leased on the head that was checked", () => {
    const calls: string[] = [];
    propose(
      runDir("review", true),
      "review",
      shell({ branchEmails: [BOT, BOT], openPr: true }, calls),
    );
    expect(calls.find((c) => c.startsWith("git push"))).toBe(
      `git push --force-with-lease=refs/heads/catalog/review:${HEAD} origin ${COMMIT}:refs/heads/catalog/review`,
    );
    expect(calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("is created leased on its absence, and the confirmed one is merged on the checked head", () => {
    const calls: string[] = [];
    propose(runDir("confirmed", true), "confirmed", shell({}, calls));
    expect(calls.find((c) => c.startsWith("git push"))).toBe(
      `git push --force-with-lease=refs/heads/catalog/confirmed: origin ${COMMIT}:refs/heads/catalog/confirmed`,
    );
    expect(calls.find((c) => c.startsWith("gh pr merge"))).toContain(
      `--match-head-commit ${COMMIT}`,
    );
  });
});

describe("a pull request from a fork branch of the same name", () => {
  it("is never taken for the workflow's own: the lookup names this repository's head", () => {
    const calls: string[] = [];
    propose(runDir("confirmed", true), "confirmed", shell({ forkPr: true }, calls));
    expect(calls.find((c) => c.startsWith("gh api repos/openadviser/ai-catalog/pulls?"))).toContain(
      `head=${encodeURIComponent("openadviser:catalog/confirmed")}`,
    );
    expect(calls.some((c) => / (9|10)( |$)/.test(c) && c.startsWith("gh pr"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(true);
    expect(calls.find((c) => c.startsWith("gh pr merge"))).toContain("gh pr merge 8 ");
  });

  it("does not hide the workflow's own pull request, which is refreshed, not duplicated", () => {
    const calls: string[] = [];
    propose(
      runDir("review", true),
      "review",
      shell({ branchEmails: [BOT, BOT], openPr: true, forkPr: true }, calls),
    );
    expect(calls.some((c) => c.startsWith("gh pr edit 7 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
    expect(calls.some((c) => / 9( |$)/.test(c) && c.startsWith("gh pr"))).toBe(false);
  });
});

it("a remote that cannot be listed is an error, never an absent branch", () => {
  const calls: string[] = [];
  expect(() =>
    propose(runDir("review", false), "review", shell({ listFails: true, openPr: true }, calls)),
  ).toThrow(/could not list/);
  expect(destructive(calls)).toEqual([]);
});

describe("unreadable source issues", () => {
  interface IssuePlan {
    findings: { title: string; marker: string; open: boolean; body: string };
    unreadable: { source: string; title: string; marker: string; body: string }[];
    notConfigured: { source: string; marker: string; env?: string }[];
  }

  function issuesDir(parts: Partial<IssuePlan>): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-catalog-issues-"));
    writeFileSync(
      join(dir, "issues.json"),
      JSON.stringify({
        findings: {
          title: "Catalog review: findings without a change",
          marker: "<!-- ai-catalog:findings -->",
          open: false,
          body: "body",
        },
        unreadable: [],
        notConfigured: [],
        ...parts,
      }),
    );
    return dir;
  }

  function issueShell(
    open: { number: number; title: string; body: string; author?: string; isPr?: boolean }[],
    calls: string[],
  ): Shell {
    const answer = (cmd: string, args: string[]): string => {
      calls.push(`${cmd} ${args.join(" ")}`);
      const path = args.find((a) => a.includes("/issues?"));
      if (cmd === "gh" && args[0] === "api" && path !== undefined)
        return path.includes("labels=source-unreadable")
          ? JSON.stringify(
              // Two pages, as `--paginate --slurp` returns them: the workflow's issue on the second.
              [open.slice(0, -1), open.slice(-1)].map((page) =>
                page.map((i) => ({
                  number: i.number,
                  title: i.title,
                  body: i.body,
                  user: { login: i.author ?? "github-actions[bot]" },
                  ...(i.isPr === true ? { pull_request: {} } : {}),
                })),
              ),
            )
          : "[[]]";
      return "";
    };
    return {
      run: answer,
      tryRun: answer,
      gitAuth: (args) => answer("git", args),
      tryGitAuth: (args) => answer("git", args),
    };
  }

  it("an issue anyone else opened is never taken for the workflow's own, even labelled and marked", () => {
    const calls: string[] = [];
    const marker = "<!-- ai-catalog:unreadable:anthropic-models-api -->";
    issues(
      issuesDir({
        unreadable: [
          {
            source: "anthropic-models-api",
            title: "Source unreadable: anthropic-models-api",
            marker,
            body: `${marker}\n- status 401 (\`fetch-failed\`)`,
          },
        ],
      }),
      issueShell(
        [
          { number: 30, title: "copy", body: `${marker}\n- something else`, author: "outsider" },
          { number: 31, title: "a pull request", body: marker, isPr: true },
          {
            number: 12,
            title: "Source unreadable: anthropic-models-api",
            body: `${marker}\n- old`,
          },
        ],
        calls,
      ),
    );
    expect(calls.some((c) => / (30|31)( |$)/.test(c) && c.startsWith("gh issue"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh issue edit 12"))).toBe(true);
    expect(calls.some((c) => c.startsWith("gh issue create"))).toBe(false);
  });

  it("an existing issue whose only reason was the missing key is closed with a one-line comment", () => {
    const calls: string[] = [];
    issues(
      issuesDir({
        notConfigured: [
          {
            source: "openai-models-api",
            marker: "<!-- ai-catalog:unreadable:openai-models-api -->",
            env: "OPENAI_API_KEY",
          },
        ],
      }),
      issueShell(
        [
          {
            number: 12,
            title: "Source unreadable: openai-models-api",
            body: "<!-- ai-catalog:unreadable:openai-models-api -->\n- no key: OPENAI_API_KEY is not set (`no-key`)",
          },
        ],
        calls,
      ),
    );
    const close = calls.find((c) => c.startsWith("gh issue close 12"));
    expect(close).toContain("OPENAI_API_KEY is not set");
    expect(calls.some((c) => c.startsWith("gh issue create"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh issue edit 12"))).toBe(false);
  });

  it("a configured failure keeps its issue; a not-configured source with none opens nothing", () => {
    const calls: string[] = [];
    const body =
      "<!-- ai-catalog:unreadable:anthropic-models-api -->\n- status 401 (`fetch-failed`)";
    issues(
      issuesDir({
        unreadable: [
          {
            source: "anthropic-models-api",
            title: "Source unreadable: anthropic-models-api",
            marker: "<!-- ai-catalog:unreadable:anthropic-models-api -->",
            body,
          },
        ],
        notConfigured: [
          {
            source: "gemini-models",
            marker: "<!-- ai-catalog:unreadable:gemini-models -->",
            env: "GEMINI_API_KEY",
          },
        ],
      }),
      issueShell(
        [
          {
            number: 9,
            title: "Source unreadable: anthropic-models-api",
            body,
          },
        ],
        calls,
      ),
    );
    expect(calls.some((c) => c.startsWith("gh issue close"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh issue edit 9"))).toBe(true);
    const created = calls.filter((c) => c.startsWith("gh issue create")).join("\n");
    expect(created).not.toContain("gemini");
  });

  it("a source that reads again is closed with the usual comment", () => {
    const calls: string[] = [];
    issues(
      issuesDir({
        notConfigured: [
          {
            source: "gemini-models",
            marker: "<!-- ai-catalog:unreadable:gemini-models -->",
            env: "GEMINI_API_KEY",
          },
        ],
      }),
      issueShell(
        [
          {
            number: 5,
            title: "Source unreadable: elevenlabs-models",
            body: "<!-- ai-catalog:unreadable:elevenlabs-models -->\n- status 500 (`fetch-failed`)",
          },
        ],
        calls,
      ),
    );
    const close = calls.find((c) => c.startsWith("gh issue close 5"));
    expect(close).toContain("Read again");
    expect(close).not.toContain("not set");
  });
});
