# Update policy

> **Status: decided.** The workflow is [`update.yml`](../.github/workflows/update.yml), the reconciler
> is [`reconcile/`](../reconcile/), and the numbers are in
> [`reconcile/policy.json`](../reconcile/policy.json).

## Purpose

To say how a change reaches the catalog, and which changes need a person. Nothing reaches a release
unless two independent sources confirmed it within the factor, or a person approved it.

## The update job

A GitHub Action runs daily at 06:17 UTC and on demand (`workflow_dispatch`, with an optional `dry_run`).
Each run:

1. **Reads every source live.** The four providers' pages and APIs are the sources of truth;
   models.dev and genai-prices are the cross-checks. The bytes go to the run's own directory, never
   straight into [`evidence/`](../evidence/). See [trust and provenance](trust-and-provenance.md).
2. **Keeps the evidence.** Every body, retrieval record and reading is uploaded as the run's workflow
   artifact, kept 90 days.
3. **Reconciles** the readings with the catalog on `main`. It does so only when `main`'s catalog is
   byte for byte the latest release, so the baseline is always the latest released catalog. While a
   release is pending, the run reports and files issues but proposes nothing.
4. **Runs `npm run check`** on the exact tree it proposes.
5. **Opens or refreshes the two pull requests** (see below), and merges the confirmed one when its
   check passed.

Releases are made by the [release workflow](versioning.md#releasing), never by hand.

## Whole facts

The reconciler compares **whole price facts**, never field by field. A fact is
`(provider, model, tier, component, condition, window) → value`, where the value is:

- the disposition;
- when priced, the unit, `per`, currency and amount;
- otherwise, the reason.

- **Window.** A window is identified by the bounds the source states. A `validFrom` that TIME-6 gave
  an undated change was never stated, so it is not part of the identity.
- **History.** An entry whose window has ended is history. It is never reconciled, and never counted
  as "tracked, not read": a source naturally stops stating a past window.
- **Tracked scope.**
  - Rate facts: the models the catalog lists, and the tiers it holds an offering for on each.
  - Model, effort and lifecycle facts: the listed models.
  - Readings outside that scope are listed as "read, not tracked" and never open a pull request.
    That includes untracked models, and the tiers of a model listed only for its effort levels.
  - Adding a model or an offering is a person's pull request. A paid model needs the owner's word.

## How a change is classed

| Class           | Meaning                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | The source of truth changed, every eligible cross-check agrees, at least `minIndependent` (1) independent cross-checks agree, and the change is within the factor |
| `single-source` | A comparable change that no eligible independent cross-check confirms                                                                                             |
| `conflict`      | An eligible cross-check disagrees. This outranks every other class                                                                                                |
| `needs-review`  | Anything a person must look at. The cases are listed below                                                                                                        |
| `unreadable`    | A source could not be read. The reason is recorded, never a zero or a guess                                                                                       |

`needs-review` covers:

- **Reader findings:** a reading that is not `ok` in tracked scope, or a provider-level observation not
  in [`reconcile/acknowledged.json`](../reconcile/acknowledged.json).
- **Tracked, not read:** every current fact, model, effort list, retirement date or non-available
  status the catalog holds that no official reading yields any more. It never becomes a removal. It is
  never silently kept as confirmed either: it blocks its group and is listed until someone acts.
  - An offering's condition inputs count too. They say which tokens select a schedule. When no
    official reading states them, every window of the offering waits.
- **Structural changes:**
  - a change to or from zero;
  - a new fact in a tracked offering;
  - a change of unit, `per`, currency, disposition or condition inputs;
  - a window or condition change, which shows as a new fact beside one tracked, not read;
  - two official readings of one fact that disagree.
- **A change beyond the factor.**
- **A failed excerpt check:** the cited bytes do not contain the value they support
  ([trust and provenance](trust-and-provenance.md#the-excerpt-check)).
- **A change inside a dated window already in force.** The schema cannot record an undated change
  there, so a person decides.

Effort-level and lifecycle changes have no independent cross-check, so they are `single-source` at
best. So are ElevenLabs prices, which no tracker covers.

## Cross-checks

A cross-check confirms a fact only if it states the **same** tier, condition and window. Partial coverage
counts as single-source. models.dev states no dates, so it never confirms a dated window. A conditional
cross-check must also state the same condition inputs, so that its bound counts the same tokens; one that
states none is not counted.

- **Lineage.** Each source declares its upstreams. Sources that share one count as one: genai-prices
  took its initial data from models.dev, LiteLLM, Helicone and llm-prices, so it and models.dev are one
  independent cross-check.
- **Eligibility.** A cross-check counts only when its own revision of the entry is later than the
  catalog's recorded observation of the value it would confirm (the old value's `provenance.readAt`).
  A tracker revised before then cannot have seen the change.
  - The revision is models.dev's `last_updated`, or genai-prices' `prices_checked`.
  - A cross-check with no revision date, or whose excerpt check fails, is shown and never counted.
- **Conflict.** Any eligible disagreement is a conflict.

The mapping of each tracker's fields is in [sources](sources.md#cross-checks).

## The change factor

The ratio is `max(new/old, old/new)` on two positive prices of the same unit, `per` and currency,
compared exactly with the factor. Equal to the factor counts as within. The factor is **×1.5**
(`factor` in [`reconcile/policy.json`](../reconcile/policy.json)).

A change to or from zero, a new fact, and a change of unit, `per`, condition or window always go to a
person. The baseline is the latest released catalog.

## Two pull requests

Dependent facts stay together. A **group** is either:

- every component and condition schedule of one offering in one window; or
- one model's effort list, or its lifecycle.

A group is confirmed only when every change in it is `confirmed` and nothing blocks it. A finding blocks:

- the whole provider, when it is provider-level;
- every group of the model, when it is model-level;
- the offering's groups, when it is offering-level.

**`catalog/confirmed`** carries the confirmed groups.

- The workflow builds it as one commit and runs `npm ci && npm run check` on that exact tree.
- It records the result in the body and as the commit status `catalog-update/check`.
- It merges through the API, only when the check passed (`--match-head-commit`). The free plan has no
  auto-merge.
- Pull requests opened with `GITHUB_TOKEN` start no CI, which is why the workflow checks its own tree.
- The merge starts no `push` workflow either, so the update workflow calls the release workflow itself.

**`catalog/review`** carries every other group with a change that can be applied.

- It is rebuilt on `main` after the confirmed merge and its release, and checked the same way.
- The workflow never merges it.
- If a person has pushed to the branch, the workflow leaves it alone.

Each body shows every change:

- its class and reason;
- the catalog's value and the official reading, each with its evidence link;
- every cross-check, with its revision and eligibility;
- the ratio against the factor.

A partition with nothing to propose closes its open pull request.

## Issues

- **One issue per unreadable source** (label `source-unreadable`), opened or updated on every run even
  when the source produced no change, and closed when it reads again. A missing API key makes that
  source unreadable with "no key", never a failed run.
- **One "Catalog review: findings without a change" issue** (label `catalog-review`). It lists every
  finding no tree change can carry: tracked, not read; reader findings; failed excerpt checks; changes
  inside a dated window in force; and groups that could not be applied. A pull request cannot exist
  without a diff, so this issue keeps them in view. It is refreshed every run and closed when empty.

## Acknowledged observations

A reader reports some provider-level observations on every run, for things the catalog does not track:

- ElevenLabs products and price rows;
- the thinking defaults of untracked Gemini models.

Unacknowledged, each would block its whole provider every day.
[`reconcile/acknowledged.json`](../reconcile/acknowledged.json) lists the ones a person accepted. Each
entry holds:

- its **observation key**: the sha256 of the observation's whole content, its source, its excerpt and
  its message;
- a reason, and the date it was acknowledged.

If anything in the observation changes, its key changes and it is raised again. Only provider-level
observations can be acknowledged. A finding about a tracked fact cannot.

## Models and lifecycle

- New models enter by a person's pull request, with the `status` the source shows.
- Absence from a model list never retires a model. A retirement needs a provider deprecation notice,
  stored as [evidence](../evidence/).
- A change read with no stated effective date becomes effective at the release's `publishedAt`, never
  earlier (TIME-6). It is flagged as undated.
- The catalog keeps its last version when a page cannot be read.
