/** Every error code of the specification's Appendix A. */
export const ERROR_CODES = [
  "invalid-json",
  "hash-mismatch",
  "version-conflict",
  "unsupported-schema-version",
  "invalid-structure",
  "invalid-amount",
  "invalid-per",
  "unknown-currency",
  "unknown-unit",
  "unit-mismatch",
  "unknown-component",
  "unknown-tier",
  "tier-provider-mismatch",
  "invalid-instant",
  "invalid-window",
  "windows-overlap",
  "condition-inputs-invalid",
  "conditions-mixed",
  "conditions-not-exclusive",
  "conditions-not-covering",
  "schedules-mismatch",
  "duplicate-provider",
  "duplicate-model",
  "duplicate-alias",
  "duplicate-offering",
  "alias-collision",
  "mixed-currencies",
  "offering-without-price",
  "invalid-version",
  "invalid-effort",
  "invalid-request",
  "unknown-provider",
  "unknown-model",
  "unknown-offering",
  "invalid-usage",
  "quantity-out-of-range",
  "usage-incomplete",
  "component-not-offered",
  "unsupported-component",
  "inapplicable-component-used",
  "no-rate-in-force",
  "unsupported-unit",
  "basis-hash-mismatch",
  "unsupported-basis-version",
  "invalid-basis",
  "dimension-mismatch",
  "inexact-conversion",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A refusal the specification names. `code` is the code of Appendix A, exactly as written.
 * `missing` is set only for `usage-incomplete`: the sorted list of USAGE-1.
 */
export class AiCatalogError extends Error {
  readonly code: ErrorCode;
  readonly missing: readonly string[] | undefined;

  constructor(code: ErrorCode, detail: string, missing?: readonly string[]) {
    super(`${code}: ${detail}`);
    this.name = "AiCatalogError";
    this.code = code;
    this.missing = missing === undefined ? undefined : Object.freeze([...missing]);
  }
}

/**
 * A failure to fetch a catalog, which the specification does not cover (it fixes no transport).
 * It is never a catalog verdict: no catalog was read, so no `AiCatalogError` code applies.
 */
export class CatalogFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CatalogFetchError";
  }
}

export function fail(code: ErrorCode, detail: string, missing?: readonly string[]): never {
  throw new AiCatalogError(code, detail, missing);
}
