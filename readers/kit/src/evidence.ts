// The evidence store and the provenance every citation flows through.
//
// Layout (evidence/README.md, enforced by scripts/check-data.ts):
//   evidence/<sha256>                    the response body, named by the sha256 of its bytes
//   evidence/<sha256>.<time>.json        one retrieval record per fetch that returned it
//
// A body is written once and never edited. A later fetch of identical bytes adds a
// record and edits nothing. `Set-Cookie` values are not kept, only the cookie names.
//
// The kit makes a wrong citation impossible: `Evidence.cite` compares the claimed
// excerpt with the bytes at the offset and throws `ReaderBug` on a mismatch, and
// `derive` does the same for every derivation input. check-data.ts re-verifies each
// one at release time.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Anchor,
  Derivation,
  DerivationInput,
  Instant,
  Location,
  Provenance,
} from "./reading.ts";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A bug in the reader itself: a citation that does not match its evidence. */
export class ReaderBug extends Error {
  override name = "ReaderBug";
}

/** A source that could not be read at all; becomes an `unreadable` reading. */
export class Unreadable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Unreadable";
    this.code = code;
  }
}

/** Structure the reader does not understand; becomes a `needs-review` reading. */
export class NeedsReview extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NeedsReview";
    this.code = code;
  }
}

/** A body of bytes a reader may cite: a saved page, a fixture or a fresh fetch. */
export class Evidence {
  readonly sha256: string;
  readonly bytes: Buffer;
  /** The URL provenance cites: the requested URL, before any redirect. */
  readonly url: string;
  readonly retrievedAt: Instant;

  constructor(args: { bytes: Uint8Array; url: string; retrievedAt: Instant; sha256?: string }) {
    this.bytes = Buffer.from(args.bytes);
    this.url = args.url;
    this.retrievedAt = args.retrievedAt;
    this.sha256 = args.sha256 ?? sha256Hex(this.bytes);
    if (this.sha256 !== sha256Hex(this.bytes)) {
      throw new ReaderBug(`evidence ${args.url}: bytes do not hash to ${this.sha256}`);
    }
  }

  get text(): string {
    return this.bytes.toString("utf8");
  }

  /** The byte offset of the first occurrence of `needle` at or after `from`, or -1. */
  offsetOf(needle: string, from = 0): number {
    return this.bytes.indexOf(Buffer.from(needle, "utf8"), from);
  }

  /** The byte offset a UTF-16 index into `this.text` decodes from — citations are bytes. */
  byteOffset(textIndex: number): number {
    return Buffer.byteLength(this.text.slice(0, textIndex), "utf8");
  }

  /** A citation of the bytes `[offset, offset + utf8 length of excerpt)`; verified. */
  cite(path: string, offset: number, excerpt: string, anchors?: Anchor[]): Location {
    this.verify(offset, excerpt, path);
    for (const anchor of anchors ?? [])
      this.verify(anchor.offset, anchor.excerpt, `${path} anchor`);
    const location: Location = { path, offset, excerpt };
    if (anchors !== undefined && anchors.length > 0) location.anchors = anchors;
    return location;
  }

  /** A citation of the `length` bytes at `offset`. */
  citeAt(path: string, offset: number, length: number, anchors?: Anchor[]): Location {
    if (offset < 0 || offset + length > this.bytes.length) {
      throw new ReaderBug(`${path}: ${offset}+${length} is outside the evidence`);
    }
    return this.cite(
      path,
      offset,
      this.bytes.subarray(offset, offset + length).toString("utf8"),
      anchors,
    );
  }

  /** An anchor for the first occurrence of `needle`, which must be present. */
  anchor(needle: string, from = 0): Anchor {
    const offset = this.offsetOf(needle, from);
    if (offset < 0)
      throw new ReaderBug(
        `anchor not found in ${this.sha256.slice(0, 12)}: ${needle.slice(0, 80)}`,
      );
    return { offset, excerpt: needle };
  }

  /** Assert that `excerpt` is the exact byte span at `offset` — ReaderBug on mismatch. */
  verify(offset: number, excerpt: string, path: string): void {
    const want = Buffer.from(excerpt, "utf8");
    if (!this.bytes.subarray(offset, offset + want.length).equals(want)) {
      throw new ReaderBug(
        `${path}: the bytes at offset ${offset} of ${this.sha256.slice(0, 12)} are not the excerpt ${JSON.stringify(excerpt.slice(0, 80))}`,
      );
    }
  }
}

/** A derivation whose every input is cited and verified. */
export function derive(formula: string, inputs: DerivationInput[], pages: Evidence[]): Derivation {
  if (inputs.length < 2) throw new ReaderBug("a derivation needs at least two cited inputs");
  for (const input of inputs) {
    const page = pages.find((p) => p.sha256 === input.evidence);
    if (page === undefined)
      throw new ReaderBug(`derivation cites evidence ${input.evidence.slice(0, 12)}, not held`);
    page.verify(input.offset, input.excerpt, `derivation input (${input.path})`);
  }
  return { formula, inputs };
}

/** The provenance of one reading. `location` and `derivation` are exclusive. */
export function provenance(
  source: string,
  page: Evidence,
  reader: string,
  extra: {
    location?: Location;
    derivation?: Derivation;
    dateRule?: Provenance["dateRule"];
    note?: string;
  },
): Provenance {
  const out: Provenance = {
    source,
    url: page.url,
    readAt: page.retrievedAt,
    reader,
    evidence: page.sha256,
  };
  if (extra.location !== undefined && extra.derivation !== undefined) {
    throw new ReaderBug("a provenance is a location or a derivation, never both");
  }
  if (extra.location !== undefined) out.location = extra.location;
  if (extra.derivation !== undefined) out.derivation = extra.derivation;
  if (extra.dateRule !== undefined) out.dateRule = extra.dateRule;
  if (extra.note !== undefined) out.note = extra.note;
  return out;
}

// ---- the store ----

export interface FetchHop {
  protocol: string;
  status: number;
  headers: [string, string][];
}

/** What one fetch returned: the body and every hop's status and headers. */
export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: Instant;
  status: number;
  bytes: Buffer;
  hops: FetchHop[];
}

const RECORD_NAME = /^[0-9a-f]{64}\.[0-9]{8}T[0-9]{6}Z\.json$/;
const BODY_NAME = /^[0-9a-f]{64}$/;

export interface RetrievalRecord {
  sha256: string;
  size: number;
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: Instant;
  status: number;
  client: string;
  note: string;
  hops: FetchHop[];
}

const RECORD_NOTE =
  "Body stored exactly as received. Set-Cookie values are not kept; their names are.";

/**
 * Response headers that name the account an API was read with. Their values are replaced
 * in the retrieval record: run evidence is uploaded as a workflow artifact, which anyone
 * who can read the repository can download.
 */
const ACCOUNT_HEADER = /organi[sz]ation|project/i;

/** A hop with account-identifying header values redacted. */
export function redactHop(hop: FetchHop): FetchHop {
  return {
    ...hop,
    headers: hop.headers.map(([name, value]) => [
      name,
      ACCOUNT_HEADER.test(name) ? "[redacted]" : value,
    ]),
  };
}

function recordName(sha256: string, retrievedAt: Instant): string {
  return `${sha256}.${retrievedAt.replace(/[-:]/g, "")}.json`;
}

/**
 * Stores a fetch under `dir` as `evidence/<sha256>` plus a retrieval record, and returns
 * the citable Evidence. A body is written once and never rewritten; a repeated body
 * only adds a record.
 */
export function storeEvidence(dir: string, page: FetchedPage, client: string): Evidence {
  const digest = sha256Hex(page.bytes);
  const body = join(dir, digest);
  if (existsSync(body)) {
    const existing = readFileSync(body);
    if (!existing.equals(page.bytes)) {
      throw new ReaderBug(`evidence/${digest} exists with different bytes`);
    }
  } else {
    writeFileSync(body, page.bytes, { flag: "wx" });
  }
  const record: RetrievalRecord = {
    sha256: digest,
    size: page.bytes.length,
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    retrievedAt: page.retrievedAt,
    status: page.status,
    client,
    note: RECORD_NOTE,
    hops: page.hops.map(redactHop),
  };
  const name = recordName(digest, page.retrievedAt);
  const recordPath = join(dir, name);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (existsSync(recordPath)) {
    if (readFileSync(recordPath, "utf8") !== serialized) {
      throw new ReaderBug(`evidence/${name} exists with different content`);
    }
  } else {
    writeFileSync(recordPath, serialized, { flag: "wx" });
  }
  return new Evidence({
    bytes: page.bytes,
    url: page.requestedUrl,
    retrievedAt: page.retrievedAt,
    sha256: digest,
  });
}

/** The evidence dir read back: bodies plus their retrieval records, by requested URL. */
export class EvidenceStore {
  readonly dir: string;
  private readonly byDigest = new Map<string, Buffer>();
  private readonly records: RetrievalRecord[] = [];

  constructor(dir: string) {
    this.dir = dir;
    for (const name of readdirSync(dir)) {
      if (BODY_NAME.test(name)) {
        this.byDigest.set(name, readFileSync(join(dir, name)));
      } else if (RECORD_NAME.test(name)) {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as RetrievalRecord;
        this.records.push(record);
      }
    }
  }

  /** Every retrieval record, oldest first. */
  get allRecords(): RetrievalRecord[] {
    return [...this.records].sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt));
  }

  /** Records of a requested URL, oldest first. */
  recordsFor(url: string): RetrievalRecord[] {
    return this.allRecords.filter((r) => r.requestedUrl === url);
  }

  /** The newest body a URL was retrieved as, or undefined when never fetched. */
  latest(url: string): Evidence | undefined {
    const records = this.recordsFor(url);
    const record = records[records.length - 1];
    if (record === undefined) return undefined;
    const bytes = this.byDigest.get(record.sha256);
    if (bytes === undefined) return undefined;
    return new Evidence({
      bytes,
      url: record.requestedUrl,
      retrievedAt: record.retrievedAt,
      sha256: record.sha256,
    });
  }

  /** The body behind a digest, or undefined. */
  body(sha256: string): Evidence | undefined {
    const bytes = this.byDigest.get(sha256);
    if (bytes === undefined) return undefined;
    const record = this.allRecords.find((r) => r.sha256 === sha256);
    return new Evidence({
      bytes,
      url: record?.requestedUrl ?? "",
      retrievedAt: record?.retrievedAt ?? "",
      sha256,
    });
  }
}
