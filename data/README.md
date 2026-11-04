# data/

The published catalog. **Empty until slice C1**, which enters the first version by hand from the
providers' pages, with provenance.

## What lands here

- `catalog.json`: the catalog itself.
- `catalog.json.sha256`: its hash.

The README's coverage table is generated from `catalog.json` by `npm run coverage:table`.

## Rules that already bind it

- Every price carries its provenance: the source, the page URL, when it was read, and the reader version.
- After the first entry, data changes arrive as pull requests: from the update job (slice C4), or from a
  person with the sources linked. Nothing is edited without review.
- A release is one validated commit that produces the version, `catalog.json` and the hash together.
  Releases are immutable and addressed by version.
- No price is invented, and no price is copied from a third-party dataset without the provider's page
  agreeing with it.
- `data/` is owned by the maintainers in [CODEOWNERS](../.github/CODEOWNERS).
- The data is MIT-licensed, like the code.

See [update policy](../docs/update-policy.md) and [trust and provenance](../docs/trust-and-provenance.md).
