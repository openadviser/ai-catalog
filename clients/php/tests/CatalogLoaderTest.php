<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use OpenAdviser\AiCatalog\CatalogLoader;
use OpenAdviser\AiCatalog\Exception\LoadException;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(CatalogLoader::class)]
final class CatalogLoaderTest extends TestCase
{
    public function testAdoptsAValidCandidate(): void
    {
        $loader = new CatalogLoader();
        self::assertNull($loader->lastGood());
        $catalog = $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        self::assertSame($catalog, $loader->lastGood());
    }

    public function testARejectedCandidateLeavesTheLastGoodCopyInForce(): void
    {
        $loader = new CatalogLoader();
        $good = $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '1')], null, '2026.11.04.1'));

        $broken = CatalogFactory::json([CatalogFactory::rate('input', '01')], null, '2026.11.05.1');
        try {
            $loader->load($broken);
            self::fail('adopted');
        } catch (LoadException $e) {
            self::assertSame('invalid-amount', $e->errorCode());
        }
        self::assertSame($good, $loader->lastGood());

        // The digest check also rejects as a whole.
        try {
            $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '2')], null, '2026.11.06.1'), str_repeat('f', 64));
            self::fail('adopted');
        } catch (LoadException $e) {
            self::assertSame('hash-mismatch', $e->errorCode());
        }
        self::assertSame($good, $loader->lastGood());

        $next = $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '2')], null, '2026.11.06.1'));
        self::assertSame($next, $loader->lastGood());
    }

    public function testAVersionAlreadyHeldWithDifferentBytesIsRejected(): void
    {
        $loader = new CatalogLoader();
        $first = CatalogFactory::json([CatalogFactory::rate('input', '1')], null, '2026.11.04.1');
        $loader->load($first);
        $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '1')], null, '2026.11.05.1'));

        // The same bytes again are fine.
        self::assertSame('2026.11.04.1', $loader->load($first)->version);

        // The same version with other bytes is not, even though an older version was superseded.
        try {
            $loader->load(CatalogFactory::json([CatalogFactory::rate('input', '9')], null, '2026.11.04.1'));
            self::fail('adopted');
        } catch (LoadException $e) {
            self::assertSame('version-conflict', $e->errorCode());
        }
        self::assertSame('2026.11.04.1', $loader->lastGood()?->version);
    }
}
