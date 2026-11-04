// Checks that every commit in a range carries a Developer Certificate of Origin
// sign-off (`git commit -s`) from its author or committer.
//
// Usage: node scripts/check-dco.ts <base> <head>
//   <base> may be empty or all zeros: then only <head> itself is checked.
import { execFileSync } from "node:child_process";

export interface Commit {
  sha: string;
  authorEmail: string;
  committerEmail: string;
  parents: number;
  message: string;
}

const SIGN_OFF = /^Signed-off-by:[ \t]+\S.*<([^<>\s]+)>[ \t]*$/gim;

function isBot(email: string): boolean {
  return /\[bot\]@users\.noreply\.github\.com$/i.test(email);
}

/** The commits that are missing a valid sign-off. Merge commits and bots are exempt. */
export function missingSignOff(commits: Commit[]): Commit[] {
  return commits.filter((commit) => {
    if (commit.parents > 1 || isBot(commit.authorEmail)) return false;
    const signers = [...commit.message.matchAll(SIGN_OFF)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    );
    return !(
      signers.includes(commit.authorEmail.toLowerCase()) ||
      signers.includes(commit.committerEmail.toLowerCase())
    );
  });
}

export function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha = "", authorEmail = "", committerEmail = "", parents = "", ...rest] =
        record.split("\x1f");
      return {
        sha,
        authorEmail,
        committerEmail,
        parents: parents.split(" ").filter(Boolean).length,
        message: rest.join("\x1f"),
      };
    });
}

function readCommits(base: string, head: string): Commit[] {
  const format = "--format=%H%x1f%ae%x1f%ce%x1f%P%x1f%B%x1e";
  const range = /^0*$/.test(base) ? ["-1", head] : [`${base}..${head}`];
  return parseLog(execFileSync("git", ["log", format, ...range], { encoding: "utf8" }));
}

if (import.meta.main) {
  const [base = "", head = "HEAD"] = process.argv.slice(2);
  const commits = readCommits(base, head);
  const missing = missingSignOff(commits);
  if (missing.length > 0) {
    for (const commit of missing) {
      console.error(`Missing sign-off: ${commit.sha.slice(0, 12)} (${commit.authorEmail})`);
    }
    console.error(
      "\nEvery commit needs a 'Signed-off-by: Name <email>' line. " +
        "Add it with 'git commit -s --amend', or 'git rebase --signoff' for several commits.",
    );
    process.exit(1);
  }
  console.log(`DCO: ${commits.length} commit(s) checked, all signed off.`);
}
