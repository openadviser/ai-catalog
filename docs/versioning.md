# Versioning

> **Status: decided.** The release mechanics arrive in C4.

## Purpose

To say how the schema, the data and the clients are versioned, and how they fit together.

## The schema

The schema follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Its version is the
catalog's `schemaVersion`, currently `1.0.0`.

- **Patch:** text, descriptions and examples only.
- **Minor:** additions to the closed vocabularies (components, units, tiers, currencies, condition inputs)
  or new optional members.
- **Major:** a change of meaning.

The vocabularies are closed, so a client cannot accept a newer **minor** version: that version may name a
component the client cannot price. A 1.0.0 client accepts `1.0.x` and rejects everything else (rule VAL-3
of the [specification](specification.md)).

The pricing basis has its own version, `basisVersion` (currently `1`). A client reads every basis version
it ever wrote, for ever, and never rewrites a stored basis.

## The data

A data release is `YYYY.MM.DD.N`:

- `YYYY.MM.DD` is the release's date in UTC, zero-padded;
- `N` is the sequence number of the release within that day: `1` for the first, then `2`, `3` and so on,
  written without leading zeros. It is always present.

For example, `2026.11.04.1`, `2026.11.04.2`, `2026.11.05.1`. Two versions compare as four integers
`(YYYY, MM, DD, N)`, never as strings, so `2026.11.04.10` comes after `2026.11.04.9`.

The sequence number is always present, rather than added only to a second release of the day, so that
there is one grammar and no special case: every version parses the same way and sorts by the same rule.
The grammar is checked at load (rule VER-1).

- `publishedAt` is the instant the release is published, in RFC 3339 UTC. A change read with no stated
  effective date takes effect at that instant, never earlier (rule TIME-6).
- Each release has a sha256, published as `catalog.json.sha256` beside `catalog.json`, in the form
  `<sha256>  catalog.json`.
- One validated commit produces the version, `publishedAt`, `catalog.json` and the hash together.
- Artifacts are addressed by version and are immutable. They are published before the "latest" pointer
  moves.
- Clients reject a known version whose hash differs (rule VAL-2).

The file in `data/` on `main` carries the version and `publishedAt` of the release that will publish it.
The first seed carries `2026.11.04.1` and stays under "Unreleased" until the release workflow (C4)
publishes it, restamping both fields if it is released on another day.

## The clients

Each client states the range of schema versions it supports. A client rejects a catalog outside that
range, and keeps the last good copy it already has.

Every client release must pass every [conformance](../conformance/) vector.

## Changelog

Schema changes and data releases are recorded in separate sections of the [changelog](../CHANGELOG.md).

## Decided in later slices

The release workflow and the "latest" pointer: C4. Client version numbers: C5 and P1.
