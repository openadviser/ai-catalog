# conformance/

The test vectors every client must pass. They pin the [specification](../docs/specification.md): two
clients that pass them all cannot price a call differently. The TypeScript client (C5) and the PHP client
(P1) each ship a runner over this directory.

```text
conformance/
  vectors/     the vectors, one JSON file per area of the specification
  fixtures/    byte-exact catalogs the vectors load; invalid/ holds one defect each; basis/ holds
               a basis whose bytes cannot be a JSON string
  tools/       pin.ts, which pins the basis bytes (not a client, see below)
```

## The vector format

Each file in `vectors/` is `{ "description", "vectors": [...] }` and satisfies
[`schema/vector.schema.json`](../schema/vector.schema.json). Every vector has:

| Member                     | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `id`                       | Unique across all files                                                                    |
| `rule`                     | The specification rule it pins, such as `ROUND-3`. Appendix B lists every vector of a rule |
| `kind`                     | `load`, `load-sequence`, `price`, `priceFromBasis` or `convert`                            |
| `title`                    | One line for people                                                                        |
| `derivation`               | The arithmetic written out, one step per line, so a reviewer can check it by hand          |
| `expected`/`expectedError` | Exactly one of them: the result, or `{ "code" }` (plus `missing` for `usage-incomplete`)   |

What the runner does, per kind:

- **`load`:** `{ catalog: { fixture }, expectedSha256? }`.
  1. Read the fixture's bytes.
  2. Load them with the client's loader, passing `expectedSha256` as the expected hash when present.
  3. `expected: { "loads": true }` means the catalog becomes last good. `expectedError.code` is the code
     the loader must reject with.
- **`load-sequence`:** `{ steps: [...] }`, the loads of one client in order. The runner makes **one new
  client** for the vector: a loader with the state VAL-1 and VAL-2 describe, a last good copy and every
  version accepted so far. It runs the steps on that client, in order. A step is `{ catalog: { fixture },
  expectedSha256?, expected | expectedError, lastGood? }`:
  1. Read the fixture's bytes and load them, as a `load` vector does.
  2. Compare the outcome with `expected: { "loads": true }` or with `expectedError.code`.
  3. When `lastGood` is given, compare the sha256 of the client's last good catalog with the sha256 of the
     named fixture's bytes. A refused step leaves the previous last good copy in force (VAL-1).

  The vector fails on the first step that differs, and the runner says which step it was.
- **`price`:** `{ catalog: { fixture }, request: { provider, modelId, tier, at, settlement,
  conditionInputs?, usage } }`. An API-1 vector (`rule: "API-1"`) may send a request that is not an
  object, or members of the wrong type, and expects a refusal with a code. A runner passes the value
  through as it is, in the language's own representation of JSON, and does not check or fix it first.
  1. Load the fixture's bytes. They always load, so a failure here is a runner failure.
  2. Call `price` with the request.
  3. Compare `provider`, `modelId`, `tier`, `currency`, `schedule`, `exact`, `estimate` and `booked` as
     strings and integers.
  4. Compare `basis` **byte for byte** with the client's canonical basis, and compare `basisSha256`.
- **`priceFromBasis`:** `{ request: { basis | basisFixture, basisSha256, conditionInputs?, usage } }`.
  1. Call `priceFromBasis` with the basis bytes and the stated sha256. The bytes are the UTF-8 encoding of
     the `basis` string, or, when the request has `basisFixture` instead, the bytes of that file under
     `fixtures/` (read as bytes, never re-serialized: a basis that is not UTF-8 cannot be a JSON string).
  2. Compare the figures. `basisFrom` names the vector whose basis it is, for readers, and is ignored.
- **`convert`:** `{ request: { rate: { unit, per, amount }, to: { unit, per, scale } } }`. Call
  `convertRate` (UNIT-4), and compare `amount` or the code. An API-1 vector sends an argument that breaks a
  precondition, such as a `scale` of 13, and expects a refusal with a code, not a language exception.

The fixture's sha256 is part of every basis (`origin.sha256`). A runner MUST therefore read fixture files
as bytes, and MUST NOT re-serialize them. Git keeps their bytes (see [`.gitattributes`](../.gitattributes)),
and the formatter skips them.

A runner fails a vector on any difference, including an extra or a different error code. It reports every
failing vector, not only the first.

## The areas

| File              | Area                                                     |
| ----------------- | -------------------------------------------------------- |
| `numbers.json`    | Amounts, `per`, quantities (Section 3)                   |
| `rounding.json`   | Exact totals, `estimate` and `booked` (Sections 3 and 4) |
| `units.json`      | Every unit kind, and the meters (Section 5)              |
| `convert.json`    | `convertRate` (UNIT-4)                                   |
| `components.json` | Components and dispositions (Section 6)                  |
| `usage.json`      | Completeness and shape (Section 7)                       |
| `conditions.json` | Conditions and schedules (Section 9)                     |
| `time.json`       | Instants and windows (Section 10)                        |
| `identity.json`   | Providers, models, aliases, tiers (Sections 8 and 11)    |
| `basis.json`      | `priceFromBasis` (Section 13)                            |
| `validation.json` | Load-time validation (Section 14)                        |
| `api.json`        | Arguments the operations refuse with a code (API-1)      |

The fixtures are test data. Their models (`vector-*`) and amounts are invented for the arithmetic, and are
not prices. The real catalog is [`data/catalog.json`](../data/).

## `tools/pin.ts` is not a client

The basis is long and canonical, so writing its bytes by hand would be error-prone. `tools/pin.ts`
computes them:

```text
npm run conformance:pin     write expected.basis and expected.basisSha256, and copy replayed bases
npm run conformance:check   fail if a pinned basis is stale, or if a hand-written figure is wrong
```

It is kept small and apart, and it is **not a client**, for these reasons:

- It handles only the accepting path, over fixtures that `scripts/validate-catalog.ts` has already
  validated.
- It implements no refusal, no loader, no hash check and no last-good state, and nothing imports it.
- It checks arithmetic only: it skips the API-1 vectors, which refuse an argument before any arithmetic.
- It never supplies a figure. Every `exact`, `estimate` and `booked` is written by hand with its
  derivation. The tool only confirms the hand-written figure, and fails the check when they differ.
- A client MUST be built from the specification, not ported from this file. Then a misreading of the
  specification shows up as a failing vector, not as two programs agreeing on the same mistake.

`npm run check` also runs `scripts/check-conformance.ts`, which:

- validates every vector file against its schema;
- checks every vector's rule against the specification's Appendix B;
- checks that every fixture is used;
- runs every `load` vector through `scripts/validate-catalog.ts`;
- checks that the JSON Schema alone rejects exactly the fixtures whose defect it can express.

## Hand-checked vectors

Each of these was worked out by hand before the tool confirmed it. USD has exponent 2, and
`estimate = floor((2*N*100 + D) / (2*D))` for an exact total `N/D` (ROUND-2).

1. **`price-rounded-once`** (text fixture: input $1.25, cached $0.125, output $10 per 10^6 tokens).
   - input 4000 → 4000 × 1.25 / 10^6 = 0.005;
   - cached 40000 → 40000 × 0.125 / 10^6 = 0.005;
   - output 500 → 500 × 10 / 10^6 = 0.005.

   The exact total is 0.015 = **3/200**. estimate = floor((600 + 200) / 400) = 2 → **0.02**, and booked
   is **0.02**. Rounding each component first would give 0.03.
2. **`price-sub-cent`**: input 1000 → 1000 × 1.25 / 10^6 = 0.00125 = **1/800**. estimate =
   floor((200 + 800) / 1600) = 0 → **0.00**. The total is positive, so booked is **0.01** (ROUND-3).
3. **`price-unit-minute-recurring`** ($0.10 per minute, metered in milliseconds, factor 60000):
   1 ms → 1 × 0.10 / 60000 = **1/600000**, a recurring decimal that stays exact. estimate =
   floor((200 + 600000) / 1200000) = 0 → **0.00**, and booked is **0.01**.
4. **`price-condition-above`**. The input is 200001 + 72000 = 272001 > 272000, so the whole call is
   priced at the higher schedule:
   - input 200001 × 4 / 10^6 = 0.800004;
   - cached 72000 × 0.2 / 10^6 = 0.0144;
   - output 1000 × 15 / 10^6 = 0.015.

   The exact total is 0.829404 = **207351/250000**. estimate = floor((41470200 + 250000) / 500000) = 83 →
   **0.83**.
5. **`price-window-at`** (at `2027-01-01T00:00:00Z`, where the 2027 window begins):
   - input 100000 × 1.50 / 10^6 = 0.15;
   - cached 20000 × 0.15 / 10^6 = 0.003;
   - output 40000 × 7.50 / 10^6 = 0.3.

   The exact total is 0.453 = **453/1000**, and the estimate is floor((90600 + 1000) / 2000) = 45 →
   **0.45**. One millisecond earlier (`price-window-before`) the 2026 rates give 453/2000 → 0.23.
6. **`convert-minute-to-million-ms`**: $0.15 per minute is 0.15 × 10^6 × 1 / (1 × 60000) = **2.5** per
   10^6 ms, which is exact at scale 6. The same rule refuses $0.10 per minute
   (`convert-minute-recurring`), since 5/3 does not terminate.
