// The release restamp (docs/versioning.md). Pure: the workflow supplies main's bytes, the
// existing `data-v*` tags and the bytes they hold, and the instant.
//
// Main's catalog carries a provisional `version` and `publishedAt` P, stamped by the pull
// request that changed it. A release:
//
// 1. is a resume when `data-v<main's version>` already holds main's exact bytes;
// 2. otherwise takes V = YYYY.MM.DD.N for today's UTC date, N one more than today's
//    highest tag, and R = now in whole seconds;
// 3. rewrites `version`, `publishedAt`, and every rate bound equal to P — the bounds
//    TIME-6 gave the undated changes that release carries — to V and R;
// 4. verifies TIME-6: every entry new since the latest release that is undated and has a
//    `validFrom` starts exactly at R, so no change takes effect before its release.
//
// The caller then runs the full check on the exact bytes, commits, and publishes.
import { serialize } from "./apply.ts";
import type { Catalog, RateEntry } from "./model.ts";

const VERSION = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.([1-9][0-9]*)$/;

export function parseVersion(v: string): [number, number, number, number] | undefined {
  const m = VERSION.exec(v);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** Versions compare as four integers, never as strings. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === undefined || y === undefined) throw new Error(`not a data version: ${a} / ${b}`);
  for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

/** The data versions among a repository's tags (`data-v<version>`). */
export function taggedVersions(tags: string[]): string[] {
  return tags
    .filter((t) => t.startsWith("data-v"))
    .map((t) => t.slice("data-v".length))
    .filter((v) => parseVersion(v) !== undefined)
    .sort(compareVersions);
}

export function nextFreeVersion(tags: string[], at: string): string {
  const day = at.slice(0, 10).replace(/-/g, ".");
  const today = taggedVersions(tags).filter((v) => v.startsWith(`${day}.`));
  const n = today.reduce((max, v) => Math.max(max, (parseVersion(v) as number[])[3] as number), 0);
  return `${day}.${n + 1}`;
}

function rates(c: Catalog): { where: string; entry: RateEntry }[] {
  const out: { where: string; entry: RateEntry }[] = [];
  for (const p of c.providers)
    for (const m of p.models)
      for (const o of m.offerings)
        for (const e of o.rates)
          out.push({ where: `${p.id}/${m.id}/${o.tier}/${e.component}`, entry: e });
  return out;
}

/** The release notes: what this release adds or closes against the previous one. */
export function releaseNotes(
  previous: Catalog | undefined,
  next: Catalog,
  version: string,
): string {
  const lines = [
    `Catalog data \`${version}\`, published ${next.publishedAt}. The assets are \`catalog.json\` and \`catalog.json.sha256\`; a client rejects a known version whose bytes differ.`,
    "",
  ];
  if (previous === undefined || previous.version === version) {
    lines.push("The first release of this data (or a resumed publication): every value is new.");
    return `${lines.join("\n")}\n`;
  }
  const key = (where: string, e: RateEntry) => `${where} ${JSON.stringify(e.condition ?? null)}`;
  const before = new Map(rates(previous).map((r) => [JSON.stringify(r.entry), r]));
  const added = rates(next).filter((r) => !before.has(JSON.stringify(r.entry)));
  lines.push(`Changes since \`${previous.version}\`:`, "");
  for (const r of added) {
    const e = r.entry;
    const value =
      e.disposition === "priced"
        ? `${e.amount} ${e.currency} per ${e.per} ${e.unit}`
        : e.disposition;
    const window =
      e.validFrom !== undefined || e.validUntil !== undefined
        ? ` [${e.validFrom ?? "…"} → ${e.validUntil ?? "…"})`
        : "";
    lines.push(`- ${key(r.where, e)}: ${value}${window}`);
  }
  const models = (c: Catalog) =>
    new Map(
      c.providers.flatMap((p) =>
        p.models.map((m) => [
          `${p.id}/${m.id}`,
          JSON.stringify({
            status: m.status,
            retiresOn: m.retiresOn,
            effort:
              m.effort === undefined
                ? null
                : { levels: m.effort.levels, default: m.effort.default },
          }),
        ]),
      ),
    );
  const was = models(previous);
  for (const [id, now] of models(next)) if (was.get(id) !== now) lines.push(`- ${id}: ${now}`);
  if (lines.length === 4) lines.push("- (no value changed)");
  return `${lines.join("\n")}\n`;
}

export interface ReleasePlan {
  action: "resume" | "publish";
  version: string;
  publishedAt: string;
  bytes: Buffer;
  /** How many rate bounds equal to the pending stamp were moved to `publishedAt`. */
  rewritten: number;
  /** The latest release before this one, if any. */
  previous?: string;
}

export function planRelease(
  main: Buffer,
  tags: string[],
  bytesAt: (version: string) => Buffer | undefined,
  now: string,
): ReleasePlan {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(now))
    throw new Error(`${now}: not a whole-second UTC instant`);
  const m = JSON.parse(main.toString("utf8")) as Catalog;
  const versions = taggedVersions(tags);
  const previous = versions[versions.length - 1];
  if (versions.includes(m.version)) {
    const tagged = bytesAt(m.version);
    if (tagged?.equals(main)) {
      const out: ReleasePlan = {
        action: "resume",
        version: m.version,
        publishedAt: m.publishedAt,
        bytes: main,
        rewritten: 0,
      };
      if (previous !== undefined) out.previous = previous;
      return out;
    }
  }
  const latest =
    previous !== undefined
      ? (JSON.parse((bytesAt(previous) as Buffer).toString("utf8")) as Catalog)
      : undefined;
  const pending = m.publishedAt;
  if (latest !== undefined && now <= latest.publishedAt)
    throw new Error(
      `now (${now}) is not after the latest release's publishedAt (${latest.publishedAt})`,
    );
  if (now < pending)
    throw new Error(`now (${now}) is before main's pending publishedAt (${pending})`);
  const released =
    latest === undefined
      ? new Set<string>()
      : new Set(rates(latest).map((r) => JSON.stringify(r.entry)));
  const hasPending = latest === undefined || pending !== latest.publishedAt;
  if (hasPending && latest !== undefined) {
    const collision = rates(latest).find(
      (r) => r.entry.validFrom === pending || r.entry.validUntil === pending,
    );
    if (collision !== undefined)
      throw new Error(
        `main's pending publishedAt ${pending} is also a released bound (${collision.where}); restamp main by hand`,
      );
  }
  const version = nextFreeVersion(tags, now);
  const out = JSON.parse(main.toString("utf8")) as Catalog;
  out.version = version;
  out.publishedAt = now;
  let rewritten = 0;
  for (const { entry } of rates(out)) {
    if (released.has(JSON.stringify(entry)) || !hasPending) continue;
    if (entry.validFrom === pending) {
      entry.validFrom = now;
      rewritten += 1;
    }
    if (entry.validUntil === pending) {
      entry.validUntil = now;
      rewritten += 1;
    }
  }
  // TIME-6: an undated change takes effect at the publishedAt of the release that first carries
  // it. A released entry this release only closes (it gains a validUntil) is not a change.
  const open = (e: RateEntry) => JSON.stringify({ ...e, validUntil: undefined });
  const releasedOpen =
    latest === undefined ? new Set<string>() : new Set(rates(latest).map((r) => open(r.entry)));
  for (const { where, entry } of rates(out)) {
    if (releasedOpen.has(open(entry))) continue;
    if (
      entry.provenance.dateRule === "undated" &&
      entry.validFrom !== undefined &&
      entry.validFrom !== now
    )
      throw new Error(
        `${where}: an undated change starts at ${entry.validFrom}, not at this release's publishedAt ${now} (TIME-6)`,
      );
  }
  const plan: ReleasePlan = {
    action: "publish",
    version,
    publishedAt: now,
    bytes: serialize(out),
    rewritten,
  };
  if (previous !== undefined) plan.previous = previous;
  return plan;
}
