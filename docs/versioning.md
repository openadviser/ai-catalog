# Versioning

> **Status: decided.** The release mechanics are under [Releasing](#releasing).

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

The file in `data/` on `main` carries the version and `publishedAt` of the latest release. Between a
merge and its release it carries the provisional stamp of the pull request that changed it. The first
seed carries `2026.11.04.1` and stays unreleased until the release workflow publishes it, restamping both
fields to the day it is released.

## Releasing

[`release.yml`](../.github/workflows/release.yml) publishes the catalog on `main`. It runs:

- on a push to `main` that changes `data/`;
- when the update workflow calls it after merging the confirmed pull request. A merge made with
  `GITHUB_TOKEN` starts no `push` workflow, so the update workflow calls this one itself;
- by hand (`workflow_dispatch`), for the first release and to resume a failed one.

### The restamp: the release workflow's own commit

A pull request that changes the catalog stamps a **provisional** `version` and `publishedAt` P, the
instant it was built, after every reading. TIME-6 gives each undated change in it the bounds P: the old
entry ends at P, the new one starts at P.

The release workflow restamps, in a commit of its own:

- `version` becomes `YYYY.MM.DD.N`: today's UTC date, and N one more than today's highest `data-v*`
  tag;
- `publishedAt` becomes R, now in whole seconds;
- every rate bound equal to P, on an entry the latest release does not hold, becomes R.

It then verifies TIME-6: every undated entry new since the latest release that has a `validFrom` starts
exactly at R. It writes `catalog.json.sha256`, runs the full `npm run check` on that exact tree, and
commits it. That commit is the one validated commit that produces the version, `publishedAt`,
`catalog.json` and the hash together.

The alternative was for the confirmed pull request to stamp itself before its merge. That covers only
the automatic path:

- a review pull request that a person merges days later would carry a stale `publishedAt`;
- its undated changes would then take effect before the release that carries them, which breaks
  TIME-6's "never earlier";
- so would a hand-made data pull request.

The release workflow sees every path to `main`, so `publishedAt` is always the real publication instant.
check-data's rule that no reading postdates `publishedAt` stays true, because every reading precedes the
release.

### Publication

1. The release commit and the tag `data-v<version>` are pushed to `main` together (`git push
   --atomic`), fast-forward only and never forced. If `main` moved meanwhile, the push is refused and
   the next run publishes.
2. A **draft** release `data-v<version>` gets `catalog.json` and `catalog.json.sha256`. Both are
   downloaded back and compared with the tagged bytes.
3. Only then is the release published and marked **latest**. The "latest" pointer moves only after the
   assets exist.
4. A version that already exists with different bytes fails the release, and nothing is published. A
   rerun after a partial failure resumes from the tag and never re-uploads different bytes.
5. If `main` already carries a version whose tag holds its exact bytes, the run is a resume. A push that
   changes only `data/README.md` lands here and publishes nothing new.

The jobs that hold a write token run no npm code: they push and publish the commit a read-only job built
and checked.

### Settings the release relies on

- **Immutable releases.** Turn on immutable releases in the repository settings, so a published
  release's assets and tag can never change.
- **If `main` is protected.** The release commit is pushed to `main` by the workflow with
  `GITHUB_TOKEN`. A branch protection rule or ruleset on `main` must allow GitHub Actions to push, for
  example by adding the GitHub Actions app as a bypass actor. Otherwise every release fails at the push,
  before anything is published.
- **Required status checks.** CI does not run on the bot's pull requests or on the release commit. The
  update workflow records its own check as the commit status `catalog-update/check`, and the release
  workflow runs the full check before it commits. A rule that requires the CI check would block the
  confirmed merge; require `catalog-update/check` for those branches instead, or leave checks
  unrequired. A person who wants CI on the review pull request can close and reopen it.

### The first release

After the pull request that adds these workflows merges, nothing is published yet: that pull request
does not touch `data/`. To publish the seed:

1. In **Actions → Release → Run workflow**, run it on `main`.
2. `prepare` restamps the seed to `2026.11.0x.1` (`x` the day it runs, in UTC) and `publishedAt` to that
   instant. It runs `npm run check` and commits "Release data 2026.11.0x.1" as `github-actions[bot]`.
3. `publish` pushes that commit to `main` with the tag `data-v2026.11.0x.1`. It creates the draft
   release with both files, verifies them, and publishes it as latest.

Then verify:

- the release `data-v2026.11.0x.1` is the latest, not a draft, and holds exactly `catalog.json` and
  `catalog.json.sha256`;
- `sha256sum catalog.json` of the downloaded asset equals the first field of `catalog.json.sha256`;
- `git show data-v2026.11.0x.1:data/catalog.json` is byte for byte that asset, and its `version` and
  `publishedAt` are the new ones;
- `main`'s head is the release commit, and the next scheduled update run reports the baseline as
  released.

## The clients

Each client states the range of schema versions it supports. A client rejects a catalog outside that
range, and keeps the last good copy it already has.

Every client release must pass every [conformance](../conformance/) vector.

## Changelog

Schema changes and data releases are recorded in separate sections of the [changelog](../CHANGELOG.md).
Each data release also lists its changes against the previous one in its release notes.

## Decided in later slices

Client version numbers: C5 and P1.
