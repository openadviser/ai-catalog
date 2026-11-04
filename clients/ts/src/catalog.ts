import type { CatalogData } from "./model.ts";

/** A validated catalog. It is immutable, and only `load` makes one. */
export interface Catalog {
  /** `YYYY.MM.DD.N` (VER-1). */
  readonly version: string;
  readonly schemaVersion: string;
  /** RFC 3339 UTC, whole seconds. */
  readonly publishedAt: string;
  /** The lowercase hex sha256 of the catalog's bytes exactly as loaded. */
  readonly sha256: string;
}

const registry = new WeakMap<object, CatalogData>();

/** Wraps validated data. Not exported from the package. */
export function wrapCatalog(data: CatalogData): Catalog {
  const catalog: Catalog = Object.freeze({
    version: data.version,
    schemaVersion: data.schemaVersion,
    publishedAt: data.publishedAt,
    sha256: data.sha256,
  });
  registry.set(catalog, data);
  return catalog;
}

/** The data behind a catalog that `load` returned. */
export function dataOf(catalog: Catalog): CatalogData {
  const data = registry.get(catalog);
  if (data === undefined) throw new TypeError("not a catalog returned by load()");
  return data;
}
