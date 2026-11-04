<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use OpenAdviser\AiCatalog\Model;

/**
 * A validated model with its offerings.
 *
 * @internal
 */
final readonly class ModelEntry
{
    /** @param list<Offering> $offerings */
    public function __construct(
        public Model $model,
        public array $offerings,
    ) {}
}
