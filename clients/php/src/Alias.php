<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/** A model's alias (ID-2). A retired alias still resolves, so that history stays priceable. */
final readonly class Alias
{
    /**
     * @param 'active'|'retired' $status
     */
    public function __construct(
        public string $id,
        public string $status,
    ) {}
}
