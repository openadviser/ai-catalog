// "Released" means published: a GitHub release, not a draft, whose two assets are the tagged
// bytes. A tag alone is a release still pending: the update freezes its proposals, and the
// next release run resumes that publication before preparing anything newer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashLine } from "../../scripts/check-data.ts";
import { baselineReleased, type PublicationCheck, releasePrepare } from "../src/cli.ts";
import { type Exec, publication } from "../src/github.ts";
import { seed } from "./helpers.ts";

const BYTES = seed().bytes;
const SIDECAR = `${createHash("sha256").update(BYTES).digest("hex")}  catalog.json\n`;

/** A fake `gh`: the release JSON for `api`, and the two assets for `release download`. */
function gh(
  release: unknown | Error,
  assets: { catalog: Buffer; sidecar: string } = { catalog: BYTES, sidecar: SIDECAR },
): Exec {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "api") {
      if (release instanceof Error) throw release;
      return JSON.stringify(release);
    }
    if (cmd === "gh" && args[0] === "release" && args[1] === "download") {
      const dir = args[args.indexOf("--dir") + 1] as string;
      writeFileSync(join(dir, "catalog.json"), assets.catalog);
      writeFileSync(join(dir, "catalog.json.sha256"), assets.sidecar);
      return "";
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
}

const ASSETS = [{ name: "catalog.json" }, { name: "catalog.json.sha256" }];

describe("publication", () => {
  const check = (exec: Exec) => publication("o/r", "2026.11.05.1", BYTES, exec);

  it("is published only when the release exists, is not a draft, and serves the exact bytes", () => {
    expect(check(gh({ draft: false, assets: ASSETS }))).toEqual({ state: "published" });
  });

  it("is pending with no release, a draft, or a missing asset", () => {
    const notFound = Object.assign(new Error("gh: Not Found (HTTP 404)"), {
      stderr: "gh: Not Found (HTTP 404)",
    });
    expect(check(gh(notFound)).state).toBe("pending");
    expect(check(gh({ draft: true, assets: ASSETS }))).toMatchObject({
      state: "pending",
      reason: expect.stringContaining("draft"),
    });
    expect(check(gh({ draft: false, assets: [{ name: "catalog.json" }] }))).toMatchObject({
      state: "pending",
      reason: expect.stringContaining("catalog.json.sha256"),
    });
  });

  it("is a mismatch when the assets hold other bytes, and a failed lookup throws", () => {
    expect(
      check(gh({ draft: false, assets: ASSETS }, { catalog: Buffer.from("{}"), sidecar: SIDECAR }))
        .state,
    ).toBe("mismatch");
    expect(
      check(gh({ draft: false, assets: ASSETS }, { catalog: BYTES, sidecar: "0  catalog.json\n" }))
        .state,
    ).toBe("mismatch");
    expect(() =>
      check(gh(Object.assign(new Error("HTTP 502"), { stderr: "gh: Bad Gateway (HTTP 502)" }))),
    ).toThrow(/could not read/);
  });
});

/** A repository whose main holds `main` and whose tag data-v2026.11.04.1 holds the seed. */
function repo(main: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "ai-catalog-release-repo-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { env, stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "catalog.json"), BYTES);
  writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(BYTES));
  git("add", "data");
  git("commit", "--quiet", "-m", "seed");
  git("tag", "data-v2026.11.04.1");
  if (!main.equals(BYTES)) {
    writeFileSync(join(root, "data", "catalog.json"), main);
    writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(main));
    git("commit", "--quiet", "-am", "a change");
  }
  return root;
}

const published: PublicationCheck = () => ({ state: "published" });
const pending: PublicationCheck = () => ({
  state: "pending",
  reason: "data-v2026.11.04.1 is still a draft",
});

describe("the baseline", () => {
  it("is released only when its tag holds main's bytes and the release is published", () => {
    const root = repo(BYTES);
    expect(baselineReleased(root, published)).toMatchObject({ released: true });
    expect(baselineReleased(root, pending)).toMatchObject({
      released: false,
      reason: expect.stringContaining("draft"),
    });
  });

  it("is not released when main is ahead of every tag", () => {
    const ahead = Buffer.from(
      BYTES.toString("utf8").replace('"name": "Claude Sonnet 5"', '"name": "Claude Sonnet Five"'),
    );
    expect(baselineReleased(repo(ahead), published)).toMatchObject({ released: false });
  });
});

describe("the next release run", () => {
  const ahead = Buffer.from(
    BYTES.toString("utf8")
      .replace('"name": "Claude Sonnet 5"', '"name": "Claude Sonnet Five"')
      .replace('"publishedAt": "2026-11-04T18:00:00Z"', '"publishedAt": "2026-11-05T09:00:00Z"'),
  );

  it("resumes a tagged version whose publication is pending, and prepares nothing newer", () => {
    const root = repo(ahead);
    const r = releasePrepare(root, "2026-11-05T10:00:00Z", pending);
    expect(r).toMatchObject({ action: "resume", version: "2026.11.04.1" });
    expect(readFileSync(join(root, "data", "catalog.json")).equals(ahead)).toBe(true);
  });

  it("prepares main's newer catalog once the tagged version is published", () => {
    const root = repo(ahead);
    const r = releasePrepare(root, "2026-11-05T10:00:00Z", published);
    expect(r).toMatchObject({ action: "publish", version: "2026.11.05.1" });
  });

  it("refuses to go on when a published release serves other bytes", () => {
    const root = repo(ahead);
    expect(() =>
      releasePrepare(root, "2026-11-05T10:00:00Z", () => ({
        state: "mismatch",
        reason: "other bytes",
      })),
    ).toThrow(/other bytes/);
  });
});
