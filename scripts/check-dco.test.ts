import { describe, expect, it } from "vitest";
import { type Commit, missingSignOff, parseLog } from "./check-dco.ts";

const commit = (overrides: Partial<Commit>): Commit => ({
  sha: "a".repeat(40),
  authorEmail: "dev@example.com",
  committerEmail: "dev@example.com",
  parents: 1,
  message: "Add a thing\n",
  ...overrides,
});

describe("missingSignOff", () => {
  it("accepts a sign-off by the author or the committer", () => {
    expect(
      missingSignOff([
        commit({ message: "Add\n\nSigned-off-by: Dev <dev@example.com>\n" }),
        commit({
          authorEmail: "other@example.com",
          message: "Add\n\nSigned-off-by: Dev <DEV@example.com>\n",
        }),
      ]),
    ).toEqual([]);
  });

  it("rejects a missing or foreign sign-off", () => {
    const bare = commit({});
    const foreign = commit({ message: "Add\n\nSigned-off-by: Eve <eve@example.com>\n" });
    expect(missingSignOff([bare, foreign])).toEqual([bare, foreign]);
  });

  it("exempts merge commits and bots", () => {
    expect(
      missingSignOff([
        commit({ parents: 2 }),
        commit({ authorEmail: "49699333+dependabot[bot]@users.noreply.github.com" }),
      ]),
    ).toEqual([]);
  });
});

describe("parseLog", () => {
  it("reads the log format used by the CLI", () => {
    const raw = `${["abc", "a@x.org", "c@x.org", "p1 p2", "Subject\n\nBody"].join("\x1f")}\x1e\n`;
    expect(parseLog(raw)).toEqual([
      {
        sha: "abc",
        authorEmail: "a@x.org",
        committerEmail: "c@x.org",
        parents: 2,
        message: "Subject\n\nBody",
      },
    ]);
  });
});
