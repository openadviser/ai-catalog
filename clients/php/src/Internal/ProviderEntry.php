<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * A validated provider with its models.
 *
 * @internal
 */
final readonly class ProviderEntry
{
    /** @param list<ModelEntry> $models */
    public function __construct(
        public string $id,
        public string $name,
        public array $models,
    ) {}
}
