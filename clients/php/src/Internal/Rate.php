<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * One rate entry of a loaded catalog, already validated.
 *
 * @internal
 */
final readonly class Rate
{
    /**
     * @param 'priced'|'inapplicable'|'unsupported' $disposition
     * @param string|null                           $amount      canonical form (NUM-4)
     */
    public function __construct(
        public string $component,
        public string $disposition,
        public ?string $unit,
        public ?int $per,
        public ?string $amount,
        public ?string $currency,
        public ?Condition $condition,
        public ?string $validFrom,
        public ?string $validUntil,
        public ?int $fromMs,
        public ?int $untilMs,
    ) {}

    /** TIME-2: in force at `$ms` when validFrom <= t and t < validUntil. */
    public function inForceAt(int $ms): bool
    {
        return ($this->fromMs === null || $this->fromMs <= $ms) && ($this->untilMs === null || $ms < $this->untilMs);
    }
}
