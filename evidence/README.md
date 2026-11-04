# evidence/

Source snapshots, kept so that any catalog value can be traced to the bytes it was read from.

## Layout

- **`<sha256>`:** the response body, exactly as received, named by the sha256 of its bytes. It was
  requested without `Accept-Encoding`, so no content coding was applied.
- **`<sha256>.<time>.json`:** one retrieval record per fetch that returned those bytes, where `<time>`
  is the retrieval instant in UTC, as `20261104T164920Z`. It holds:
  - the requested URL and the final URL;
  - the time, the final status and the client used;
  - the status and headers of every hop, redirects included.

  A later fetch of identical bytes adds a record and edits nothing. `Set-Cookie` values are not kept,
  only the cookie names.
- **The location of each value** is in the value's `provenance` in `data/catalog.json`: a byte offset
  and the exact excerpt there, with any anchors.

`npm run check` verifies that every body hashes to its name and has a record, that every cited excerpt is
the bytes at its offset, and that every body is cited.

## The seed's evidence

The first catalog was entered from 13 pages fetched on 2026-11-04 between 16:49 and 17:08 UTC, with
`curl` (GET, redirects followed, no `Accept-Encoding`, `User-Agent: ai-catalog-seed/1.0`). Only pages
the catalog cites are kept, 4.3 MB in all.

## The update job's daily reads

The update job reads every source every day. It commits a body here only when a reading it supports
enters a pull request as the provenance of an added or changed value. It commits that body with the
retrieval record the provenance names. Every run's full evidence, committed or not, is kept for 90 days
as the run's workflow artifact, linked from its pull requests and issues. A body no value cites any more
(a value replaced outright) is removed here in the same pull request, and stays in the tagged release
that cited it. See [trust and provenance](../docs/trust-and-provenance.md#evidence-retention).

## Rules that bind it

- **Content-addressed:** a body's name is the sha256 of its bytes. A file is never edited after it is
  written.
- The bytes are stored untouched. [`.gitattributes`](../.gitattributes) turns off line-ending conversion
  here and marks the directory so GitHub does not count it as code.
- Reconciliation decisions link to the evidence they relied on.
- A provider's deprecation notice that retires a model is stored here too.
- The link check and the formatter skip this directory.

See [trust and provenance](../docs/trust-and-provenance.md).
