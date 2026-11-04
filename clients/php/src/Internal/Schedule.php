<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * The rate entries of an offering that share one condition (Section 9), as built at one instant or
 * read from a basis.
 *
 * @internal
 */
final readonly class Schedule
{
    /**
     * @param list<Entry> $entries one per component, ascending by code point
     */
    public function __construct(
        public ?Condition $condition,
        public array $entries,
    ) {}
}
