# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The framework-neutral core, built from the specification (schema 1.0.0, basis version 1):
  - `Catalog::load`, `loadFile` and `loadUrl` (PSR-18 and PSR-17): the raw-text checks JSON-1 and JSON-2
    before parsing, then structure and semantic validation, failing atomically with the specification's
    codes; `CatalogLoader` keeps the last good copy;
  - `Catalog::loadUrl` refuses `http` and an `https`-to-`http` redirect unless allowed, wraps every
    fetch failure in `SourceException`, and reads the `.sha256` sidecar when no digest is given;
  - `Catalog::price`, `Pricing::priceFromBasis` and `Pricing::convertRate`, in exact arithmetic with
    `brick/math`; the model, alias and effort reads;
  - RFC 8785 canonicalization (`Jcs`) for the basis, and typed exceptions that carry the specification's
    error code and `missing`.
- The second-round rules of the specification:
  - a digest is 64 lowercase hexadecimal characters, and any other spelling is `hash-mismatch` (VAL-2);
    `Catalog::loadWithSidecar` and `CatalogLoader::loadWithSidecar` take the text of `catalog.json.sha256`
    and read the first field of its first line;
  - `-0` is refused, not read as 0, wherever a nonnegative integer is required (JSON-2): `invalid-usage`
    in a usage report, `invalid-per` or `invalid-structure` in a catalog;
  - the conformance runner reads the `sidecar` input of a `load` vector.
- A conformance runner over every vector of `conformance/`, with unit tests for the parts the vectors
  do not pin.
- The release procedure ("Releasing" in the README) and the `php-split.yml` workflow that publishes the
  read-only mirror on `php-v*` tags.

### Dependencies

- Runtime: `brick/math` (exact rationals and big integers); the interfaces `psr/http-client`,
  `psr/http-factory` and `psr/clock`.
