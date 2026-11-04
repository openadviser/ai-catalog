<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/** A model's effort levels (EFF-1), ascending from `none` to `max`. */
final readonly class Effort
{
    /**
     * @param list<string> $levels  nonempty, distinct, ascending
     * @param string|null  $default one of the levels, or null when the source states none
     */
    public function __construct(
        public array $levels,
        public ?string $default,
    ) {}
}
