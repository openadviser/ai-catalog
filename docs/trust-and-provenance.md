# Trust and provenance

> **Status: decided.** The evidence store is in [`readers/kit/`](../readers/kit/), and the checks are in
> `scripts/check-data.ts` and [`reconcile/`](../reconcile/).

## Purpose

To say what you can trust the catalog for, how a value can be traced, and where the limits are.

## Limits

- **Not affiliated with any provider.** This is an independent project.
- **The provider's invoice is authoritative.** The catalog is a best-effort reading of public pages and
  can be wrong or late.
- **Not modelled:** plan-based discounts, credits, free tiers and regional prices. Applications express
  those as their own overrides.
- A price the catalog cannot read is reported as unreadable, never as zero.

## Provenance

- Every rate carries `provenance`: the source, the page URL, when it was read, and the version of the
  reader that read it.
- Every read keeps its response bytes, content-addressed, with retrieval metadata:
  - the URL, the time and the status;
  - the headers of every hop;
  - the location of each extracted value.
- Reconciliation decisions link to that evidence.
- Cross-check sources confirm a price but are never its source.

## Evidence retention

The update job reads every source every day. Most of those reads change nothing, so their bytes are not
committed.

- **A run's bytes never go to [`evidence/`](../evidence/) directly.** A live run stores every body and
  retrieval record in its own run directory.
  - The run directory also holds every report, the plan, the bodies of the pull requests and the
    issues, and the commits it proposes.
  - It is uploaded as the workflow artifact `run-<run id>` (and `review-<run id>` after the review
    build), **kept 90 days**.
  - Every pull request and issue links to the run.
- **Bytes are committed to `evidence/` only when a reading they support enters a pull request.** That
  means the reading is the provenance of a catalog entry the pull request adds or changes. Exactly those
  bodies go in, with the retrieval record of the URL and read time the provenance names. Nothing else
  from the run is committed. That covers:
  - unchanged facts;
  - cross-check readings, which link to their sha-pinned URL where one exists (genai-prices is read
    at a commit);
  - findings;
  - every page of a run that changes nothing.
- **Content-addressed and write-once.** A body is named by its sha256 and never edited.
  - A superseded price stays as a history window, so its evidence stays cited.
  - A value can also be replaced outright: a price in a window that has not begun, an effort list, a
    status. Then a body that no value cites any more is removed from `evidence/` in the same pull
    request. It stays in the tagged release that cited it and in git history.
  - `npm run check` keeps two rules: every body in `evidence/` is cited, and every cited body is there.
- **Account details are redacted.** API reads run with the repository's keys. In the retrieval records,
  the values of response headers that name an account or project are replaced with `[redacted]`:
  `anthropic-organization-id`, `openai-organization`, `openai-project` and the like. The reason is that
  the artifacts of a public repository can be downloaded by anyone who can read it. The keys themselves
  travel only in request headers, which are never stored.

## The excerpt check

On every run, the reconciler re-verifies the provenance of every reading it uses, official and
cross-check alike. First, the bytes at the cited offset must be the excerpt. Then the excerpt must
contain the value it supports, not merely exist somewhere in the page:

| Reading      | The excerpt must contain                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Priced rate  | The amount, as a number token                                                                                        |
| Derived rate | The stated result. The formula's operands must multiply exactly to the amount, and each must appear in a cited input |
| Effort       | Every level and the default, in the excerpt or its anchors                                                           |
| Model        | Its id or its name                                                                                                   |
| Status, date | The status word, or the retirement date, in the status excerpt                                                       |

A failure is `needs-review`, and it blocks the fact's group. A cross-check reading that fails is not
counted. `npm run check` re-verifies every excerpt the catalog cites, byte for byte, at every commit.

## Integrity

- Each release has a sha256. Clients check it, and reject a known version whose hash differs.
- Releases are immutable and addressed by version. A version that already exists with different bytes
  fails the release. See [versioning](versioning.md#releasing).
- A change that two independent sources agree on, within the factor, merges by itself. Everything else
  is reviewed by a person. See [update policy](update-policy.md).
- The workflow jobs that hold a write token run no npm code. They push the exact commit a read-only job
  built and checked, verified by its tree hash.

## Security

Consumers enforce budgets with these prices, so a tampered or misleading price is a security issue.
Report it privately. See [SECURITY.md](../SECURITY.md).
