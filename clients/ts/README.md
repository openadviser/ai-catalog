# clients/ts/

The TypeScript client. **Empty until slice C5.** It becomes an npm workspace when it gets its
`package.json`. Publishing to npm is decided later.

## What lands here

A client with the behaviour shared by every language:

- `load(url | path)`: fetch, check the sha256 and the `schemaVersion`, keep the last good copy.
- `price(model, tier, usage, at)`: returns `{ amount, currency, basis, basisSha256 }`.
  It throws on an unknown model or tier, a missing component rate, or no validity window at `at`.
- `priceFromBasis(basis, usage)`: prices from a stored basis alone, without the catalog.
- `models(provider)` and `effort(model)`.

## Rules that already bind it

- It passes every vector in [`conformance/`](../../conformance/) on every release.
- It uses exact decimal arithmetic and rounds once, on the total.
- A catalog becomes the last good copy only after it passes the schema, the hash check and semantic
  validation. A malformed candidate is rejected as a whole.
- It states the range of schema versions it supports.

See [clients](../../docs/clients.md).
