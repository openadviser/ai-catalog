// Test helpers: the saved evidence and the tracked scope every reader test shares.
//
// The fixtures are the real pages C1 saved under `evidence/` — the tests read them in
// place rather than duplicating the bytes. The API fixtures live next to each
// reader's tests as documented example responses; no test ever calls a live API.
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

export function store(): EvidenceStore {
  return new EvidenceStore(EVIDENCE);
}

/** The newest saved body for `url` — throws when C1 never fetched it. */
export function page(url: string): Evidence {
  const saved = store().latest(url);
  if (saved === undefined) throw new Error(`no saved evidence for ${url}`);
  return saved;
}

export function scope(provider: string): TrackedScope {
  const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as unknown;
  return trackedScope(catalog, provider);
}

/** `evidence` rebuilt around mutated bytes — the same URL and retrieval time. */
export function mutated(ev: Evidence, mutate: (text: string) => string): Evidence {
  const text = ev.bytes.toString("utf8");
  return new Evidence({
    bytes: Buffer.from(mutate(text), "utf8"),
    url: ev.url,
    retrievedAt: ev.retrievedAt,
  });
}
