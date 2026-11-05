# schema/

The JSON Schemas (draft 2020-12) of schema version **1.1.0**. They are the structural gate. The rules no
schema can express, such as non-overlapping windows and exclusive conditions, are the semantic checks of
the [specification](../docs/specification.md), Section 14.

| File                  | Describes                                                       | `$id`                                                                        |
| --------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `catalog.schema.json` | `catalog.json`: providers, models, offerings, rates, provenance | `https://github.com/openadviser/ai-catalog/schema/1.1.0/catalog.schema.json` |
| `usage.schema.json`   | A usage report                                                  | `https://github.com/openadviser/ai-catalog/schema/1.1.0/usage.schema.json`   |
| `basis.schema.json`   | A pricing basis, version 1                                      | `https://github.com/openadviser/ai-catalog/schema/1.1.0/basis.schema.json`   |
| `vector.schema.json`  | A file of conformance vectors                                   | `https://github.com/openadviser/ai-catalog/schema/1.1.0/vector.schema.json`  |

The `$id`s are identifiers, not download locations. The closed vocabularies (components, units, tiers,
currencies, effort levels) are enums in `catalog.schema.json`, versioned with it: adding to one is a minor
version.

`npm run check` validates `data/catalog.json`, every conformance fixture, every usage report, every
pinned basis and every vector file against these schemas, with [ajv](https://ajv.js.org/) in strict
mode. It also checks that the schema alone rejects exactly the invalid fixtures whose defect it can
express.

## Rules that bind it

- The schema follows SemVer through `schemaVersion`. See [versioning](../docs/versioning.md).
- Amounts are decimal strings that match `^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$`, never JSON numbers.
- `per` is a power of ten from 1 to 10^9.
- Validity windows are half-open, `[validFrom, validUntil)`, in RFC 3339 UTC, and may not overlap.
- A value outside the bounds is a validation error, never a rounded value.
- `schema/` is owned by the maintainers in [CODEOWNERS](../.github/CODEOWNERS).
