# Versioning

> **Status: Draft — specified in C1.** The rules below are decided. The release mechanics arrive in C4.

## Purpose

To say how the schema, the data and the clients are versioned, and how they fit together.

## The schema

The schema follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Its version is the
catalog's `schemaVersion`.

## The data

Data releases are dated versions: `YYYY.MM.DD`, plus a sequence number when several land in one day. The
exact form of the sequence number is decided in C1.

- Each release has a sha256, published as `catalog.json.sha256` beside `catalog.json`.
- One validated commit produces the version, `catalog.json` and the hash together.
- Artifacts are addressed by version and are immutable. They are published before the "latest" pointer
  moves.
- Clients reject a known version whose hash differs.

## The clients

Each client states the range of schema versions it supports. A client rejects a catalog outside that
range, and keeps the last good copy it already has.

Every client release must pass every [conformance](../conformance/) vector.

## Changelog

Schema changes and data releases are recorded in separate sections of the [changelog](../CHANGELOG.md).

## Decided in later slices

The sequence-number format: C1. The release workflow and the "latest" pointer: C4. Client version
numbers: C5 and P1.
