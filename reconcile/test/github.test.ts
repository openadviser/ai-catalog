// The GitHub side, with a fake shell that records every command: a branch a person has
// pushed to is never closed, deleted or force-pushed, on either partition; the force-push is
// leased on the head that was checked; and a remote that cannot be listed is an error, never
// an empty answer.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { propose, type Shell } from "../src/github.ts";

const BOT = "41898282+github-actions[bot]@users.noreply.github.com";
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TREE = "t".repeat(40);
const HEAD = "h".repeat(40);

interface Remote {
  /** The remote branch's commit authors and committers, or undefined when it does not exist. */
  branchEmails?: string[];
  openPr?: boolean;
  /** ls-remote fails (auth, network). */
  listFails?: boolean;
}

function shell(remote: Remote, calls: string[]): Shell {
  const answer = (cmd: string, args: string[]): string => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
      return JSON.stringify(
        remote.openPr === true ? [{ number: 7, url: "https://x.test/pull/7" }] : [],
      );
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
      "gh pr close 7 --repo openadviser/ai-catalog --delete-branch",
    ]);
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

it("a remote that cannot be listed is an error, never an absent branch", () => {
  const calls: string[] = [];
  expect(() =>
    propose(runDir("review", false), "review", shell({ listFails: true, openPr: true }, calls)),
  ).toThrow(/could not list/);
  expect(destructive(calls)).toEqual([]);
});
