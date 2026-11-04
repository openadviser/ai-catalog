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
  const releasedEntries = latest === undefined ? [] : rates(latest);
  const released = new Set(releasedEntries.map((r) => JSON.stringify(r.entry)));
  // A released open entry with a validUntil added: one this release closes.
  const open = (e: RateEntry) => JSON.stringify({ ...e, validUntil: undefined });
  const releasedOpen = new Set(
    releasedEntries.filter((r) => r.entry.validUntil === undefined).map((r) => open(r.entry)),
  );
  const hasPending = latest === undefined || pending !== latest.publishedAt;
  const version = nextFreeVersion(tags, now);
  const out = JSON.parse(main.toString("utf8")) as Catalog;
  out.version = version;
  out.publishedAt = now;
  // Only the bounds TIME-6 set are restamped: the end of a released entry this release closes,
  // and the start of a new undated entry. A bound the provider stated is never moved, even
  // when it equals the pending stamp.
  // A TIME-6 split is a released entry closed at the pending stamp and a new undated entry in
  // the same slot starting there. A closure with a stated successor, or none, is the
  // provider's, and stays.
  const slotOf = (where: string, e: RateEntry) => `${where} ${JSON.stringify(e.condition ?? null)}`;
  const isNew = (e: RateEntry) => !released.has(JSON.stringify(e)) && !releasedOpen.has(open(e));
  const undatedStarts = new Set(
    rates(out)
      .filter(
        (r) =>
          isNew(r.entry) &&
          r.entry.provenance.dateRule === "undated" &&
          r.entry.validFrom === pending,
      )
      .map((r) => slotOf(r.where, r.entry)),
  );
  let rewritten = 0;
  for (const { where, entry } of rates(out)) {
    if (!hasPending || released.has(JSON.stringify(entry))) continue;
    if (releasedOpen.has(open(entry))) {
      if (entry.validUntil === pending && undatedStarts.has(slotOf(where, entry))) {
        entry.validUntil = now;
        rewritten += 1;
      }
      continue;
    }
    if (entry.provenance.dateRule === "undated" && entry.validFrom === pending) {
      entry.validFrom = now;
      rewritten += 1;
    }
  }
  // TIME-6: an undated change takes effect at the publishedAt of the release that first carries
  // it. A released entry this release only closes (it gains a validUntil) is not a change.
  for (const { where, entry } of rates(out)) {
    if (releasedOpen.has(open(entry)) || released.has(JSON.stringify(entry))) continue;
    if (
      entry.provenance.dateRule === "undated" &&
      entry.validFrom !== undefined &&
      entry.validFrom !== now
    )
      throw new Error(
        `${where}: an undated change starts at ${entry.validFrom}, not at this release's publishedAt ${now} (TIME-6)`,
      );
  }
  // Released prices never change for an instant already published. Every released entry is:
  // kept as it is; closed at or after this release; a window that has not begun yet (it may be
  // replaced); or in a slot (offering, component, condition) the catalog no longer has.
  const kept = rates(out);
  const keptExact = new Set(kept.map((r) => JSON.stringify(r.entry)));
  const slot = (where: string, e: RateEntry) => `${where} ${JSON.stringify(e.condition ?? null)}`;
  const slots = new Set(kept.map((r) => slot(r.where, r.entry)));
  for (const r of releasedEntries) {
    if (keptExact.has(JSON.stringify(r.entry))) continue;
    if (r.entry.validUntil === undefined) {
      const closed = kept.find(
        (k) => k.entry.validUntil !== undefined && open(k.entry) === open(r.entry),
      );
      if (closed !== undefined && (closed.entry.validUntil as string) >= now) continue;
    }
    if (r.entry.validFrom !== undefined && r.entry.validFrom > now) continue;
    if (!slots.has(slot(r.where, r.entry))) continue;
    throw new Error(
      `${r.where}: the released entry ${JSON.stringify({ amount: r.entry.amount, validFrom: r.entry.validFrom, validUntil: r.entry.validUntil })} would change for instants already published; keep it and close it at the release (TIME-6), or restamp main by hand`,
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
