# Update policy

> **Status: Draft.** The rules below are decided. The workflow that applies them arrives in slice C4, and
> the exact defaults are confirmed there.

## Purpose

To say how a change reaches the catalog, and which changes need a person.

## The update job

A GitHub Action runs on a daily schedule and on demand (`workflow_dispatch`). Each run:

1. runs the readers;
2. reconciles the readings with the latest released catalog;
3. opens or refreshes the pull requests for the changes;
4. merges the confirmed ones automatically;
5. on merge, bumps the version, publishes the release (`catalog.json` plus its sha256) and tags it.

Releases are made by a workflow, never by hand.

## How a change is classed

The reconciler compares **whole price facts**. A fact is the price together with its provider, model,
tier, component, unit, `per`, currency, condition and validity window. Each change is classed as:

| Class           | Meaning                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `confirmed`     | The source of truth and at least one independent cross-check agree, within the factor |
| `single-source` | Only the source of truth reads the change                                             |
| `conflict`      | An eligible source disagrees                                                          |
| `unreadable`    | A source could not be read. The reason is recorded, never a zero or a guess           |

A cross-check confirms a fact only if it covers the same tier, condition and window. Partial coverage
counts as single-source. Each source declares its lineage, and two sources that share an upstream count
as one. A cross-check older than the change it would confirm is not eligible.

## What merges by itself, and what waits

- `confirmed` changes go to a pull request that merges automatically.
- Everything else goes to a review pull request and waits for a person: a single-source change, a
  conflict, a model the catalog lists that a source no longer shows, and any change beyond the factor.
- Facts that depend on each other (all components of one offering, and one window) stay together.
- A source that cannot be read opens or updates a review issue, even when it produces no change.
- Effort-level changes from a single official source are `single-source`.
- The catalog keeps its last version when a page cannot be read.

## The change factor

The ratio is `max(new/old, old/new)` on comparable positive prices, compared with the factor. The
baseline is the latest released catalog. A change to or from zero, a new fact, and a change of unit,
`per`, condition or window always go to a person. The default factor, proposed as ×1.5, and the default
schedule, proposed as daily, are confirmed in C4.

## Models and lifecycle

- New models enter with the `status` the source shows. Whether an application may use a new model is
  that application's decision, not the catalog's.
- Absence from a model list never retires a model. Retirement needs a provider deprecation notice,
  stored as [evidence](../evidence/).
- A change read with no stated effective date becomes effective at the release's `publishedAt`, never
  earlier, and is flagged as undated.

## Decided in later slices

The configuration format of the policy, the workflow files and the release mechanics: C4.
