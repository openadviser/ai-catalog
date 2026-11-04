# schema/

The JSON Schema for the catalog. **Empty until slice C1**, which writes it together with
[`docs/specification.md`](../docs/specification.md).

## What lands here

- The JSON Schema of `catalog.json`: catalog, provider, model, offering and rate.
- The closed vocabularies for components and units, which are versioned with the schema.

## Rules that already bind it

- The schema follows SemVer through `schemaVersion`. See [versioning](../docs/versioning.md).
- Amounts are decimal strings that match `^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$`, never JSON numbers.
- `per` is a power of ten from 1 to 10^9, so that division is always an exact decimal.
- Validity windows are half-open, `[validFrom, validUntil)`, in RFC 3339 UTC, and may not overlap.
- A value outside the bounds is a validation error, never a rounded value.
- `schema/` is owned by the maintainers in [CODEOWNERS](../.github/CODEOWNERS).
