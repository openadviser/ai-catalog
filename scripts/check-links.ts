// Offline link check for the Markdown files in this repository.
//
// It checks relative links and in-page anchors. It never touches the network:
// links with a scheme (https:, mailto:, ...) are skipped, so the check is
// deterministic and safe to run in CI and on a plane.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface FoundLink {
  line: number;
  target: string;
}

export interface Problem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "evidence", "fixtures", "vendor"]);

/** Replace fenced code blocks and inline code with blanks, keeping line numbers. */
function stripCode(markdown: string, inline = true): string[] {
  const lines = markdown.split("\n");
  let fence: string | undefined;
  return lines.map((line) => {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === undefined) {
      if (opening?.[1] !== undefined) {
        fence = opening[1];
        return "";
      }
      return inline ? line.replace(/`+[^`]*`+/g, "") : line;
    }
    const marker = fence[0] ?? "`";
    const closing = new RegExp(`^\\s{0,3}${marker}{${fence.length},}\\s*$`);
    if (closing.test(line)) {
      fence = undefined;
    }
    return "";
  });
}

export function extractLinks(markdown: string): FoundLink[] {
  const found: FoundLink[] = [];
  const lines = stripCode(markdown);
  let inComment = false;
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    // Drop HTML comments, which may span lines.
    let cleaned = "";
    while (line.length > 0) {
      if (inComment) {
        const end = line.indexOf("-->");
        if (end === -1) {
          line = "";
        } else {
          inComment = false;
          line = line.slice(end + 3);
        }
      } else {
        const start = line.indexOf("<!--");
        if (start === -1) {
          cleaned += line;
          line = "";
        } else {
          cleaned += line.slice(0, start);
          inComment = true;
          line = line.slice(start + 4);
        }
      }
    }
    const number = index + 1;
    for (const match of cleaned.matchAll(
      /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    )) {
      if (match[1] !== undefined) found.push({ line: number, target: match[1] });
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(cleaned);
    if (definition?.[1] !== undefined) found.push({ line: number, target: definition[1] });
    for (const match of cleaned.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (match[1] !== undefined) found.push({ line: number, target: match[1] });
    }
  });
  return found;
}

/** The anchors GitHub generates for the headings of a Markdown file. */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of stripCode(markdown, false)) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading?.[1] === undefined) continue;
    const text = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*]/g, "")
      .toLowerCase();
    const base = text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

export function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(name)) visit(path);
      } else if (name.endsWith(".md")) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

export function checkRepository(root: string): Problem[] {
  const problems: Problem[] = [];
  const slugCache = new Map<string, Set<string>>();
  const slugsOf = (path: string): Set<string> => {
    let slugs = slugCache.get(path);
    if (slugs === undefined) {
      slugs = headingSlugs(readFileSync(path, "utf8"));
      slugCache.set(path, slugs);
    }
    return slugs;
  };

  for (const file of markdownFiles(root)) {
    const shown = relative(root, file).split(sep).join("/");
    for (const { line, target } of extractLinks(readFileSync(file, "utf8"))) {
      if (isExternal(target)) continue;
      const problem = (reason: string): void => {
        problems.push({ file: shown, line, target, reason });
      };
      const [rawPath = "", rawFragment] = target.split("#", 2);
      let path: string;
      let fragment: string | undefined;
      try {
        path = decodeURI(rawPath.split("?")[0] ?? "");
        fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment);
      } catch {
        problem("malformed escape sequence");
        continue;
      }
      const destination =
        path === ""
          ? file
          : path.startsWith("/")
            ? resolve(root, `.${path}`)
            : resolve(dirname(file), path);
      const inside = relative(root, destination);
      if (inside.startsWith("..")) {
        problem("points outside the repository");
        continue;
      }
      if (!existsSync(destination)) {
        problem("file not found");
        continue;
      }
      if (fragment !== undefined && fragment !== "" && destination.endsWith(".md")) {
        if (!slugsOf(destination).has(fragment.toLowerCase())) {
          problem(`no heading for anchor #${fragment}`);
        }
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const problems = checkRepository(root);
  for (const { file, line, target, reason } of problems) {
    console.error(`${file}:${line}: ${target}: ${reason}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} broken link(s).`);
    process.exit(1);
  }
  console.log(`Checked ${markdownFiles(root).length} Markdown files: all internal links resolve.`);
}
