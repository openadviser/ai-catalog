<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/**
 * The package's identity: its Packagist name and the version this tree releases as.
 */
final class Version
{
    /** The Packagist name published by the read-only ai-catalog-php mirror. */
    public const string PACKAGE = 'openadviser/ai-catalog';

    /** The version this tree releases as; it matches the `php-v*` tag that publishes it. */
    public const string VERSION = '0.2.0';

    /** @codeCoverageIgnore */
    private function __construct() {}
}
