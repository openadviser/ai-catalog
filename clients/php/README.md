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

## Requirements

- PHP 8.3 or newer
- The package has no runtime dependencies yet; what the client needs is decided with the client
  code in a later slice.

## Install

_The first release has not been tagged yet. After it is:_

```sh
composer require openadviser/ai-catalog
```

## Quick start (planned)

```php
// Planned API, not published yet.
$catalog = $loader->load('<catalog.json URL or path>');
$price = $catalog->price('example-model', 'example:standard', $usage, $now);
```

## The conformance promise

Every release of this client passes every conformance vector in
[`conformance/`](https://github.com/openadviser/ai-catalog/tree/main/conformance), so a call is
priced the same way in PHP as in every other language.

## Status

The toolchain is in place; the framework-neutral core arrives in slice P1 and an optional Symfony
bundle in P2. See [docs/clients.md](https://github.com/openadviser/ai-catalog/blob/main/docs/clients.md).

## Links

- [Contributing](https://github.com/openadviser/ai-catalog/blob/main/CONTRIBUTING.md) ·
  [Security](https://github.com/openadviser/ai-catalog/blob/main/SECURITY.md) ·
  [Changelog](CHANGELOG.md)
- [MIT licence](LICENSE)
