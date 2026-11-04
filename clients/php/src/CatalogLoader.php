<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use OpenAdviser\AiCatalog\Exception\LoadException;
use OpenAdviser\AiCatalog\Exception\SourceException;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;

/**
 * Keeps the "last good" catalog (VAL-1). A candidate becomes the last good copy only when it passes
 * every check of Section 14; a candidate that fails any check is rejected as a whole and the previous
 * copy stays in force.
 *
 * It also enforces the second sentence of VAL-2: a candidate whose `version` this loader already
 * holds, with different bytes, is rejected with `version-conflict`. That is a different fault from
 * `hash-mismatch` (bytes that do not match the published sha256), with a different repair.
 */
final class CatalogLoader
{
    private ?Catalog $lastGood = null;

    /** @var array<string, string> catalog version => sha256 of the bytes first adopted for it */
    private array $held = [];

    /** The last good catalog, or null before the first successful load. */
    public function lastGood(): ?Catalog
    {
        return $this->lastGood;
    }

    /**
     * @throws LoadException the candidate was rejected; the last good copy is unchanged
     */
    public function load(string $bytes, ?string $expectedSha256 = null): Catalog
    {
        return $this->adopt(Catalog::load($bytes, $expectedSha256));
    }

    /**
     * @throws LoadException
     * @throws SourceException
     */
    public function loadFile(string $path, ?string $expectedSha256 = null): Catalog
    {
        return $this->adopt(Catalog::loadFile($path, $expectedSha256));
    }

    /**
     * @throws LoadException
     * @throws SourceException
     */
    public function loadUrl(ClientInterface $client, RequestFactoryInterface $requests, string $url, ?string $expectedSha256 = null, bool $allowInsecureHttp = false): Catalog
    {
        return $this->adopt(Catalog::loadUrl($client, $requests, $url, $expectedSha256, $allowInsecureHttp));
    }

    private function adopt(Catalog $candidate): Catalog
    {
        $held = $this->held[$candidate->version] ?? null;
        if ($held !== null && $held !== $candidate->sha256) {
            throw new LoadException(ErrorCode::VersionConflict, 'version ' . $candidate->version . ' is already held with different bytes');
        }
        $this->held[$candidate->version] = $candidate->sha256;
        $this->lastGood = $candidate;

        return $candidate;
    }
}
