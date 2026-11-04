import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRepository, extractLinks, headingSlugs } from "./check-links.ts";

describe("extractLinks", () => {
  it("finds inline links, images, reference definitions and html attributes", () => {
    const links = extractLinks(
      ["[a](one.md) and ![b](two.png 'title')", "[ref]: three.md", '<img src="four.svg">'].join(
        "\n",
      ),
    );
    expect(links.map((link) => link.target)).toEqual(["one.md", "two.png", "three.md", "four.svg"]);
    expect(links.map((link) => link.line)).toEqual([1, 1, 2, 3]);
  });

  it("ignores code and comments", () => {
    const links = extractLinks(
      ["`[x](inline.md)`", "```", "[y](fenced.md)", "```", "<!-- [z](comment.md) -->"].join("\n"),
    );
    expect(links).toEqual([]);
  });
});

describe("headingSlugs", () => {
  it("follows the GitHub rules, including duplicates", () => {
    const slugs = headingSlugs("# Hello, `World`!\n## Same\n## Same\n```\n# not a heading\n```\n");
    expect([...slugs]).toEqual(["hello-world", "same", "same-1"]);
  });
});

describe("checkRepository", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function repository(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "links-"));
    directories.push(root);
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    return root;
  }

  it("accepts good links and skips external ones", () => {
    const root = repository({
      "README.md":
        "[docs](docs/a.md#title) [web](https://example.com/missing) [self](#top)\n# Top\n",
      "docs/a.md": "# Title\n[back](../README.md)\n[dir](../docs/)\n",
    });
    expect(checkRepository(root)).toEqual([]);
  });

  it("reports missing files, anchors and escapes from the repository", () => {
    const root = repository({
      "README.md": "[a](nope.md)\n[b](docs/a.md#missing)\n[c](../outside.md)\n",
      "docs/a.md": "# Title\n",
    });
    expect(checkRepository(root).map((problem) => problem.reason)).toEqual([
      "file not found",
      "no heading for anchor #missing",
      "points outside the repository",
    ]);
  });
});
