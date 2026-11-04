# Adding a source or a provider

> **Status: Draft.** The process below follows the rules already decided. The reader interface and the
> test helpers are defined in C2 and C3, and this page is completed there.

## Purpose

To walk a contributor through adding a pricing source, a model list or a whole provider.

## Before you start

Open a _New model or provider_ issue and link the provider's official pricing page. If the page is not the
provider's own, it cannot be the source of truth. It can only be a cross-check. See
[sources](sources.md).

## The steps

1. **Read the page by hand first.** Note every table, tier, unit and footnote that changes a rate, and
   whether any rate is dated.
2. **Add a reader** in `readers/<name>/`. It returns readings and follows the rules in
   [`readers/`](../readers/):
   - it fails closed: a missing table, a missing model or an unparseable price is an `unreadable`
     reading with the reason, never a zero;
   - it names the table a price comes from, because the tier comes from it;
   - it asserts the structure of the page: the expected headers, tier headings and footnotes it
     understands.
3. **Save the page** as a fixture under `readers/<name>/fixtures/` and write tests that fail when the
   reading changes.
4. **Add mutation fixtures:** an inserted column, a moved heading and a footnote whose scope changed
   must each produce `needs-review`.
5. **Declare the cross-check and its lineage,** if there is an independent one. Two sources that share
   an upstream count as one.
6. **Keep the evidence:** a production read stores its response bytes under
   [`evidence/`](../evidence/).
7. **Document it** in [sources](sources.md): the source, its cross-check, its form and its traps.
8. **Open a pull request** with the checklist filled in. Add a [changelog](../CHANGELOG.md) entry.

## Decided in later slices

The reader's exact interface, the fixture layout and the test helpers: C2 and C3. The provider id of a
new provider is chosen with the maintainers. Ids are our own and stable.
