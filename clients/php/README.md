# AI Catalog for PHP

**The PHP client for [AI Catalog](https://github.com/openadviser/ai-catalog): prices, models and
effort levels for AI APIs, read from the providers' own pages, cross-checked, and published as
versioned JSON with dated rates.**

[![CI](https://github.com/openadviser/ai-catalog/actions/workflows/php.yml/badge.svg)](https://github.com/openadviser/ai-catalog/actions/workflows/php.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PHP >=8.3](https://img.shields.io/badge/PHP-%3E%3D8.3-777bb3.svg)](composer.json)

> **This package is a read-only split.** It is split automatically from
> [`clients/php/`](https://github.com/openadviser/ai-catalog/tree/main/clients/php) into
> `openadviser/ai-catalog-php` on each tag, the way Symfony publishes its components. The mirror is
> never edited by hand: **issues and pull requests go to
> [`openadviser/ai-catalog`](https://github.com/openadviser/ai-catalog)**.

The client loads a catalog, checks it as a whole, and prices a call from it with exact arithmetic. It
is built from the [specification](https://github.com/openadviser/ai-catalog/blob/main/docs/specification.md)
alone: two clients that pass the [conformance vectors](#the-conformance-promise) cannot price the same
call differently.

## Requirements

- PHP 8.3 or newer, on a 64-bit platform (quantities and condition bounds go up to 2^53, and Composer
  refuses to install on 32-bit PHP)
- [`brick/math`](https://github.com/brick/math), the only runtime library: exact rationals and
  integers of any size
- The interfaces `psr/http-client`, `psr/http-factory` and `psr/clock`. They are interfaces only, and
  you bring the implementations (Guzzle, Symfony HttpClient, `symfony/clock`, ...) if you use URLs or
  want the clock. Loading from bytes or a file needs none of them.

## Install

_The first release has not been tagged yet. After it is:_

```sh
composer require openadviser/ai-catalog
```

## Quick start

Load a catalog from its exact bytes, check them against the published digest, and price a call.

```php
use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\PriceRequest;
use OpenAdviser\AiCatalog\Pricing;

// catalog.json.sha256 reads "<sha256>  catalog.json".
$sha256 = explode(' ', trim((string) file_get_contents('catalog.json.sha256')))[0];

$catalog = Catalog::loadFile('catalog.json', expectedSha256: $sha256);
// or, with any PSR-18 client and PSR-17 request factory (see "Loading from a URL"):
// $catalog = Catalog::loadUrl($httpClient, $requestFactory, $catalogUrl, $sha256);

// What the call consumed. `complete` needs every per-call component the offering prices, zero included.
$usage = [
    'completeness' => 'complete',
    'quantities' => [
        'input' => 12000,
        'input_cached' => 30000,
        'cache_write_5m' => 0,
        'cache_write_1h' => 0,
        'output' => 800,
        'web_search' => 0,
        'code_execution' => 0,
    ],
];

$price = $catalog->price(new PriceRequest(
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',          // a model id or one of its aliases
    tier: 'anthropic:standard',          // no fallback to another tier
    at: '2026-11-04T12:00:00Z',          // RFC 3339 UTC, to the millisecond
    usage: $usage,
    settlement: PriceRequest::BOOKED,    // the figure you reserve or settle with
));

$price->exact;        // "19/500", the exact total as N/D in lowest terms
$price->estimate;     // "0.04", rounded once, half-up, to the currency's minor unit
$price->booked;       // "0.04", like estimate, but a positive total never books less than 0.01
$price->currency;     // "USD"
$price->basis;        // the audit record of the rates used: canonical JSON (RFC 8785)
$price->basisSha256;  // its sha256; store both

// Later, with no catalog and no clock: the same figures from the basis alone.
$settled = Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage);
$settled->exact;      // "19/500"
```

Amounts are strings and totals are exact rationals; no float touches a price. Quantities are PHP ints
below 2^53; a PHP float is refused (`invalid-usage`), because `json_decode` reads `0.99999999999999999`
as `1.0` and `1e-999` as `0.0`. Read a usage report from JSON text with `UsageReport::fromJson()`,
which holds the text to the specification's integer-literal rule, and pass the result to `price`. If the input tokens are not known before the call, send
`conditionInputs: ['inputTokens' => 'unknown']`, reserve with the result, and settle with
`Pricing::priceFromBasis()` and the actual usage.

Other reads:

```php
$catalog->models('openai');                        // list<Model>: id, name, aliases, status, tiers, effort ...
$catalog->model('openai', 'gpt-6.1-sol');          // by id or alias; a retired alias still resolves
$catalog->effort('openai', 'gpt-6.1-sol');         // Effort: levels (ascending) and default, or null

// A rate in another unit or `per`, converted exactly or refused, never rounded:
Pricing::convertRate('minute', 1, '0.15', 'millisecond', 1_000_000, scale: 6);   // "2.5"
```

### Loading from a URL

```php
$catalog = Catalog::loadUrl($httpClient, $requestFactory, 'https://example.com/data/catalog.json');
```

- **https only.** An `http` URL, and a redirect from `https` to `http`, are refused with a
  `SourceException` unless you pass `allowInsecureHttp: true`. The rule is the same for the catalog and
  for its digest. The loader follows at most five redirects itself and resolves a relative `Location`;
  configure your PSR-18 client **not to follow redirects**, or its redirects are outside this check.
- **The digest.** Pass `$expectedSha256` from a source you trust. Without one, the loader reads the
  sidecar published beside the catalog: the catalog URL with `.sha256` appended to its path, the query
  kept and the fragment dropped (`…/catalog.json?v=2#x` reads `…/catalog.json.sha256?v=2`). Its first
  field is the digest. A sidecar from the catalog's own origin catches a corrupted or truncated
  download; it does not protect you from that origin being hostile.
- **Failures.** Anything that goes wrong in fetching, including a failure while reading a response body,
  is a `SourceException` with the original as `getPrevious()`. A body that arrives and is not a good
  catalog is a `LoadException`.

To keep a "last good" catalog across updates, hand each candidate to a `CatalogLoader`. A candidate
that fails any check is rejected as a whole and the previous catalog stays in force:

```php
$loader = new OpenAdviser\AiCatalog\CatalogLoader();
$loader->loadFile('catalog.json', $sha256);
$loader->lastGood();   // the Catalog, or null before the first good load
```

## Errors

Every refusal the specification defines is an exception that carries the specification's code
(Appendix A), so a caller branches on a value that is the same in every language:

```php
use OpenAdviser\AiCatalog\Exception\AiCatalogException;
use OpenAdviser\AiCatalog\Exception\UsageIncompleteException;

try {
    $price = $catalog->price($request);
} catch (UsageIncompleteException $e) {
    $e->errorCode();   // "usage-incomplete"
    $e->missing;       // ["cache_write_5m", "web_search"], sorted; the report must state them
} catch (AiCatalogException $e) {
    $e->errorCode();   // for example "no-rate-in-force"
    $e->errorCode;     // the same, as the OpenAdviser\AiCatalog\ErrorCode enum
}
```

| Class                      | Raised by                                                                | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoadException`            | `Catalog::load*`, `CatalogLoader`                                        | `invalid-json`, `hash-mismatch`, `version-conflict`, `unsupported-schema-version`, `invalid-structure`, `invalid-amount`, `invalid-per`, `unknown-currency`, `unknown-unit`, `unit-mismatch`, `unknown-component`, `unknown-tier`, `tier-provider-mismatch`, `invalid-instant`, `invalid-window`, `windows-overlap`, `condition-inputs-invalid`, `conditions-mixed`, `conditions-not-exclusive`, `conditions-not-covering`, `schedules-mismatch`, `duplicate-provider`, `duplicate-model`, `duplicate-alias`, `duplicate-offering`, `alias-collision`, `mixed-currencies`, `offering-without-price`, `invalid-version`, `invalid-effort` |
| `PriceException`           | `Catalog::price`, `models`, `model`, `effort`, `Pricing::priceFromBasis` | `invalid-request`, `unknown-provider`, `unknown-model`, `unknown-offering`, `invalid-instant`, `invalid-usage`, `quantity-out-of-range`, `component-not-offered`, `unsupported-component`, `inapplicable-component-used`, `no-rate-in-force`, `unsupported-unit`, `invalid-json` (a usage report read from text)                                                                                                                                                                                                                                                                                                                         |
| `UsageIncompleteException` | the same (a `PriceException`)                                            | `usage-incomplete`, with `missing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BasisException`           | `Pricing::priceFromBasis`                                                | `basis-hash-mismatch`, `unsupported-basis-version`, `invalid-basis`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ConversionException`      | `Pricing::convertRate`                                                   | `invalid-per`, `dimension-mismatch`, `unsupported-unit`, `inexact-conversion`, `unknown-unit`, `invalid-amount`, `invalid-request`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SourceException`          | `Catalog::loadFile`, `Catalog::loadUrl`                                  | no code: the bytes could not be read or fetched, or a fetch was refused (insecure URL, too many redirects); there was nothing to validate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`ErrorCode` lists every code. The meaning of each is in the
[specification](https://github.com/openadviser/ai-catalog/blob/main/docs/specification.md#appendix-a-error-codes).

## Things the client will not do

- **No float, anywhere near an amount.** Catalog text is checked before it is parsed: a repeated member
  or a number that is not an integer literal (`1.5`, `1e3`) is `invalid-json`, because parsers read
  such text differently. Integers too large for a PHP int stay exact.
- **No rounding but one.** Components are never rounded one by one; the total is rounded once.
- **No guessing.** A component missing from a `complete` report is never read as zero, and a tier is
  never replaced by another.
- **No partial catalogs.** A catalog that fails any check is rejected whole.

## The conformance promise

Every release of this client passes every conformance vector in
[`conformance/`](https://github.com/openadviser/ai-catalog/tree/main/conformance), so a call is
priced the same way in PHP as in every other language. The runner is
`tests/ConformanceTest.php` in the monorepo: it reads each fixture as bytes, runs each vector through
the public API only, and compares figures, error codes, the basis bytes and its sha256 exactly. A
skipped vector is a failure.

The runner and the other tests are not part of the mirror (they need the monorepo's `conformance/`
directory); run them there:

```sh
git clone https://github.com/openadviser/ai-catalog.git
cd ai-catalog/clients/php
composer install
composer check      # PHPUnit incl. the conformance vectors, PHPStan level max, coding style
```

## Releasing

_For maintainers. The mirror is written by one workflow and by nobody else._

A release is a tag on the monorepo. The workflow
[`php-split.yml`](https://github.com/openadviser/ai-catalog/blob/main/.github/workflows/php-split.yml)
runs on tags named `php-v*` and on nothing else. It splits `clients/php/` into the root of
`openadviser/ai-catalog-php` with `git subtree split` (history kept), then pushes the result as the
mirror's `main` and as the mirror's tag `vX.Y.Z`.

One-time setup (the repository `openadviser/ai-catalog-php` must exist, empty and public; Packagist
watches it):

1. Create an SSH key pair that is used for nothing else, for example
   `ssh-keygen -t ed25519 -C ai-catalog-php-deploy -f deploy_key -N ''`.
2. Add `deploy_key.pub` to `openadviser/ai-catalog-php` under _Settings → Deploy keys_, with **Allow
   write access**.
3. Store the contents of `deploy_key` (the private half) as the Actions secret
   `AI_CATALOG_PHP_DEPLOY_KEY` of `openadviser/ai-catalog`, then delete the local files.
4. Submit `https://github.com/openadviser/ai-catalog-php` to Packagist once, with the GitHub hook
   enabled so that new tags appear by themselves.

Without the secret the workflow fails at its first step with a message that says so, before anything
else runs. The deploy key is read by that check and by the last job only; the validation job, which runs
the repository's code, never sees it.

To release:

1. On `main`, make sure CI is green and [`CHANGELOG.md`](CHANGELOG.md) has the release's entry. Move
   the _Unreleased_ items under a heading `## [X.Y.Z] - YYYY-MM-DD` in a pull request, and merge it.
   `Version::VERSION` is updated in the same pull request.
2. Tag the merge commit and push the tag. The tag is `php-vX.Y.Z` (or `php-vX.Y.Z-rc.1`), the
   [Semantic Versioning](https://semver.org/spec/v2.0.0.html) number of this package, which is
   independent of the schema and of the data versions:

   ```sh
   git tag -s php-v0.1.0 -m "PHP client 0.1.0"
   git push origin php-v0.1.0
   ```

3. Watch the _PHP split_ run. Three jobs, each needing the one before:
   - _preflight_: the secret exists, the tag's form is right, the tagged commit is on `main`;
   - _validate_: `composer check` (the conformance vectors, PHPStan, coding style) passes **on the tagged
     commit** on PHP 8.3 (lowest dependencies), 8.4 and 8.5. A red check stops the release before the
     deploy key is read;
   - _split_: splits, verifies the split's `composer.json`, and pushes `main` and the tag `v0.1.0`
     together (`--atomic`, no force).

   Packagist picks the tag up from the mirror.
4. Check `composer require openadviser/ai-catalog:^0.1` in a scratch project.

Rules the workflow enforces, and what to do when it refuses:

- **A tag is final.** The mirror's tag is never moved. A wrong release is fixed by a new patch version,
  not by re-tagging; if the push is rejected because the tag exists, pick the next number.
- **The mirror only moves forward.** The split is deterministic, so each release extends the mirror's
  history. If the push is rejected as non-fast-forward, someone wrote to the mirror by hand: do not
  force it; find out what changed and fix it in the monorepo.
- **Only `src/`, `composer.json`, `README.md`, `LICENSE` and `CHANGELOG.md` are installed.** Tests and
  tooling are `export-ignore`d in [`.gitattributes`](.gitattributes), so Composer's dist archive
  carries `src/` only.
- **Rotating the key:** generate a new pair, replace the deploy key on the mirror and the secret on the
  monorepo, and remove the old key.

## Status

The core is complete: loading and validation, `price`, `priceFromBasis`, `convertRate`, and the model,
alias and effort reads. An optional Symfony bundle arrives in slice P2. See
[docs/clients.md](https://github.com/openadviser/ai-catalog/blob/main/docs/clients.md).

## Links

- [Contributing](https://github.com/openadviser/ai-catalog/blob/main/CONTRIBUTING.md) ·
  [Security](https://github.com/openadviser/ai-catalog/blob/main/SECURITY.md) ·
  [Changelog](CHANGELOG.md)
- [MIT licence](LICENSE)
