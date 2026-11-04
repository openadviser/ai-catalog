<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/**
 * The package's identity, kept here so the toolchain has something real to check
 * until the client code arrives in slice P1.
 */
final class Version
{
    /** The Packagist name published by the read-only ai-catalog-php mirror. */
    public const string PACKAGE = 'openadviser/ai-catalog';

    /** The running version; `0.0.0` until the first release. */
    public const string VERSION = '0.0.0';

    /** @codeCoverageIgnore */
    private function __construct() {}
}
