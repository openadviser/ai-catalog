# clients/php/

The PHP client. **Empty for now.** The toolchain arrives in slice P0, the core client in P1 and the
Symfony bundle in P2.

## What lands here

- **P0:** Composer with PSR-4, PHPUnit, PHPStan at max level, PHP-CS-Fixer, and a CI job over the
  supported PHP versions.
- **P1:** a framework-neutral core for PHP 8.3+, built on PSR-18, PSR-20 and brick/math: `Catalog`,
  `Model`, `Rate`, `Price`, `PricingBasis` and `CatalogLoader`. It passes every vector in
  [`conformance/`](../../conformance/).
- **P2:** an optional Symfony bundle in the same package.

## Rules that already bind it

- **This directory is split to a read-only mirror, `openadviser/ai-catalog-php`, on tags.** Composer and
  Packagist need `composer.json` at a repository root. A workflow splits `clients/php/` on each tag. The
  mirror is never edited by hand.
- **Issues and pull requests go to `openadviser/ai-catalog`**, never to the mirror.
- Once it has a front page, this README is also the mirror's, so it must read well on its own and say
  that the mirror is read-only.
- The mirror ships only `src/`; tests are excluded with `export-ignore`.
- Every client release passes every conformance vector.

See [clients](../../docs/clients.md).
