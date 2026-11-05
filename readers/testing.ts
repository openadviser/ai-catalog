// Test helpers: the saved evidence and the tracked scope every reader test shares.
//
// The fixtures are the real pages C1 saved under `evidence/` — the tests read them in
// place rather than duplicating the bytes. The API fixtures live next to each
// reader's tests as documented example responses; no test ever calls a live API.
//
// The reader tests are pinned to the seed: a page is exactly the body the frozen seed
// catalog (`fixtures/seed-catalog.json`) cites for its URL, found by sha256, and the tracked
// scope is that catalog too. The update job later commits newer pages under `evidence/` and
// changes `data/catalog.json`; a reader's regression tests must not move with them, or the
// update's own check could never pass. Evidence is never deleted (a body no value cites any
// more is listed in `evidence/superseded.json`, and check-data fails if a listed body is
// missing), so the seed's bodies stay whatever the catalog cites later.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Evidence,
  EvidenceStore,
  type TrackedScope,
  trackedScope,
} from "@openadviser/ai-catalog-readers-kit";
import { provenances } from "../scripts/check-data.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EVIDENCE = join(ROOT, "evidence");
/** `data/catalog.json` as the seed entered it, frozen for the reader tests. */
export const SEED_CATALOG = join(ROOT, "readers", "fixtures", "seed-catalog.json");

/** URL → the sha256 of the body the frozen seed catalog cites for it. */
export function seedCitations(): Map<string, string> {
  const out = new Map<string, string>();
  const cite = (url: string, sha: string) => {
    const seen = out.get(url);
    if (seen !== undefined && seen !== sha)
      throw new Error(`the seed cites two bodies for ${url}: ${seen} and ${sha}`);
    out.set(url, sha);
  };
  for (const { provenance } of provenances(seedCatalog())) {
    cite(provenance.url as string, provenance.evidence as string);
    const inputs =
      (provenance.derivation as { inputs?: { url: string; evidence: string }[] } | undefined)
        ?.inputs ?? [];
    for (const i of inputs) cite(i.url, i.evidence);
  }
  return out;
}

/**
 * The saved evidence under `dir`, where `latest(url)` is the seed's body for the URL: the
 * one the seed catalog cites, by sha256, never merely the earliest or newest retrieval. A
 * URL the seed does not cite falls back to its earliest retrieval.
 */
export function store(dir: string = EVIDENCE): { latest(url: string): Evidence | undefined } {
  const s = new EvidenceStore(dir);
  const cited = seedCitations();
  return {
    latest(url: string): Evidence | undefined {
      const records = s.recordsFor(url);
      const sha = cited.get(url);
      const record = sha === undefined ? records[0] : records.find((r) => r.sha256 === sha);
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

/**
 * The seed's tracked scope plus the three Lyria models of the 1.1.0 catalog. The frozen seed
 * predates them; the tests that read the Lyria tables track them through this scope instead of
 * moving with `data/catalog.json`.
 */
export function scopeWithLyria(): TrackedScope {
  const catalog = structuredClone(seedCatalog()) as {
    providers: { id: string; models: unknown[] }[];
  };
  const gemini = catalog.providers.find((p) => p.id === "google-gemini");
  if (gemini === undefined) throw new Error("the seed has no google-gemini provider");
  for (const [id, status] of [
    ["lyria-3.5", "available"],
    ["lyria-3-clip-preview", "preview"],
    ["lyria-3-pro-preview", "preview"],
  ] as const) {
    gemini.models.push({
      id,
      status,
      offerings: [{ tier: "google-gemini:standard", rates: [{ component: "generation" }] }],
    });
  }
  return trackedScope(catalog, "google-gemini");
}

/**
 * The seed's tracked scope plus the three ElevenLabs successors of the 1.1.0 catalog:
 * `music_v2_5` and `eleven_text_to_sound_v3` with a pay-as-you-go minute rate, and `music_v2`
 * listed with no offering (its rate is not stated, so none is entered).
 */
export function scopeWithElevenlabsSuccessors(): TrackedScope {
  const catalog = structuredClone(seedCatalog()) as {
    providers: { id: string; models: unknown[] }[];
  };
  const eleven = catalog.providers.find((p) => p.id === "elevenlabs");
  if (eleven === undefined) throw new Error("the seed has no elevenlabs provider");
  const priced = [
    { tier: "elevenlabs:pay-as-you-go", rates: [{ component: "output_audio_duration" }] },
  ];
  eleven.models.push(
    { id: "music_v2_5", status: "available", offerings: priced },
    { id: "music_v2", status: "available", offerings: [] },
    { id: "eleven_text_to_sound_v3", status: "available", offerings: priced },
  );
  return trackedScope(catalog, "elevenlabs");
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
