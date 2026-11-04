import type { Catalog } from "./catalog.ts";
import { AiCatalogError } from "./errors.ts";
import { type CatalogSource, type LoadOptions, load } from "./load.ts";

/**
 * Keeps the last good catalog (VAL-1). A candidate that fails any check is rejected as a whole and
 * the previous catalog stays in force. A catalog whose `version` the client already holds, with
 * different bytes, is rejected too (VAL-2).
 */
export class CatalogClient {
  #current: Catalog | undefined;
  readonly #held = new Map<string, string>();

  /** The last good catalog, or `undefined` before the first successful load. */
  get current(): Catalog | undefined {
    return this.#current;
  }

  /** The last good catalog; throws when nothing has been loaded. */
  require(): Catalog {
    if (this.#current === undefined) throw new Error("no catalog has been loaded");
    return this.#current;
  }

  async load(source: CatalogSource, options: LoadOptions = {}): Promise<Catalog> {
    const candidate = await load(source, options);
    const heldDigest = this.#held.get(candidate.version);
    if (heldDigest !== undefined && heldDigest !== candidate.sha256) {
      throw new AiCatalogError(
        "version-conflict",
        `version ${candidate.version} is already held with another sha256 (${heldDigest})`,
      );
    }
    this.#held.set(candidate.version, candidate.sha256);
    this.#current = candidate;
    return candidate;
  }
}
