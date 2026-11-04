# evidence/

Source snapshots, kept so that any catalog value can be traced to the bytes it was read from.
**Empty until slice C2**, when the first readers keep their reads here.

## What lands here

For every production read, content-addressed under `evidence/<sha256>`:

- the response bytes, exactly as received;
- retrieval metadata: URL, time, status and headers;
- the location of each value extracted from the response.

## Rules that already bind it

- **Content-addressed:** a file's name is the sha256 of its bytes. A file is never edited after
  it is written.
- The bytes are stored untouched. [`.gitattributes`](../.gitattributes) turns off line-ending conversion
  here and marks the directory so GitHub does not count it as code.
- Reconciliation decisions link to the evidence they relied on.
- A provider's deprecation notice that retires a model is stored here too.
- The link check and the formatter skip this directory.

See [trust and provenance](../docs/trust-and-provenance.md).
