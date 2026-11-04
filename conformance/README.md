# conformance/

The test vectors every client must pass. **Empty until slice C1**, which writes the vectors with the
specification. The clients implement them in slices C5 (TypeScript) and P1 (PHP).

## What lands here

`*.json` vectors. Each has the shape:

```text
{ catalogFixture, model, tier, at, usage: { component: quantity }, expected: { amount, currency, basis } }
```

## Rules that already bind it

- Every client release must pass every vector. This is what stops two languages pricing the same call
  differently.
- `basis` is the canonical pricing basis. It is a JSON document canonicalised by RFC 8785 (JCS) and
  hashed with sha256. The vector fixes its bytes and its hash, so every client stores the same audit record.
- Arithmetic is exact decimal throughout. The only rounding is on the total, half-up, and yields an
  `estimate` and a `booked` figure (see [specification](../docs/specification.md)).
- Vectors cover zero usage, a sub-cent total, several components rounded once, and one instant before,
  at and after every validity boundary.
