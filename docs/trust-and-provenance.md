# Trust and provenance

> **Status: Draft.** The rules below are decided. The evidence store arrives in C2 and the checks in C4.

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
- Every production read keeps its response bytes, content-addressed under
  [`evidence/`](../evidence/), with retrieval metadata (URL, time, status, headers) and the location of
  each extracted value. Reconciliation decisions link to that evidence.
- Cross-check sources confirm a price but are never its source.

## Integrity

- Each release has a sha256. Clients check it, and reject a known version whose hash differs.
- Releases are immutable and addressed by version.
- A change that two independent sources agree on, within the factor, merges by itself. Everything else
  is reviewed by a person. See [update policy](update-policy.md).

## Security

Consumers enforce budgets with these prices, so a tampered or misleading price is a security issue.
Report it privately. See [SECURITY.md](../SECURITY.md).
