<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use OpenAdviser\AiCatalog\Version;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(Version::class)]
final class VersionTest extends TestCase
{
    public function testDeclaresThePackageIdentity(): void
    {
        self::assertSame('openadviser/ai-catalog', Version::PACKAGE);
        self::assertMatchesRegularExpression('/^\d+\.\d+\.\d+$/', Version::VERSION);
    }
}
