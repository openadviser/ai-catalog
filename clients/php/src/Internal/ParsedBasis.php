<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * A basis that passed every check of BASIS-4, in the form the pricing engine takes.
 *
 * @internal
 */
final readonly class ParsedBasis
{
    /**
     * @param non-empty-list<Schedule> $schedules
     * @param list<string>             $conditionInputs sorted; empty without conditions
     */
    public function __construct(
        public string $currency,
        public int $exponent,
        public array $conditionInputs,
        public array $schedules,
    ) {}
}
