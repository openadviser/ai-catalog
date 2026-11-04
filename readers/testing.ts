// Test helpers: the saved evidence and the tracked scope every reader test shares.
//
// The fixtures are the real pages C1 saved under `evidence/` — the tests read them in
// place rather than duplicating the bytes. The API fixtures live next to each
// reader's tests as documented example responses; no test ever calls a live API.
//
// The reader tests are pinned to the seed: a page is the **earliest** saved retrieval of
// its URL, and the tracked scope is the frozen seed catalog in `fixtures/`. The update job
// later commits newer pages under `evidence/` and changes `data/catalog.json`; a reader's
// regression tests must not move with them, or the update's own check could never pass.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Evidence,
  EvidenceStore,
  type TrackedScope,
  trackedScope,
} from "@openadviser/ai-catalog-readers-kit";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EVIDENCE = join(ROOT, "evidence");
/** `data/catalog.json` as the seed entered it, frozen for the reader tests. */
export const SEED_CATALOG = join(ROOT, "readers", "fixtures", "seed-catalog.json");

/** The saved evidence, where `latest(url)` is the URL's earliest (seed) retrieval. */
export function store(): { latest(url: string): Evidence | undefined } {
  const s = new EvidenceStore(EVIDENCE);
  return {
    latest(url: string): Evidence | undefined {
      const record = s.recordsFor(url)[0];
      if (record === undefined) return undefined;
      const body = s.body(record.sha256);
      if (body === undefined) return undefined;
      return new Evidence({
        bytes: body.bytes,
        url: record.requestedUrl,
        retrievedAt: record.retrievedAt,
        sha256: record.sha256,
      });
    },
  };
}

/** The seed's saved body for `url` — throws when C1 never fetched it. */
export function page(url: string): Evidence {
  const saved = store().latest(url);
  if (saved === undefined) throw new Error(`no saved evidence for ${url}`);
  return saved;
}

export function seedCatalog(): unknown {
  return JSON.parse(readFileSync(SEED_CATALOG, "utf8")) as unknown;
}

export function scope(provider: string): TrackedScope {
  return trackedScope(seedCatalog(), provider);
}

/** `evidence` rebuilt around mutated bytes — the same URL and retrieval time. */
export function mutated(ev: Evidence, mutate: (text: string) => string): Evidence {
  const text = ev.bytes.toString("utf8");
  const out = mutate(text);
  if (out === text) {
    throw new Error(
      `the mutation did not change the evidence at ${ev.url} — the test is not testing anything`,
    );
  }
  return new Evidence({
    bytes: Buffer.from(out, "utf8"),
    url: ev.url,
    retrievedAt: ev.retrievedAt,
  });
}
