<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * The half-open interval (gt, lte] over the one input `inputTokens` (COND-1). A missing bound is open.
 *
 * @internal
 */
final readonly class Condition
{
    public function __construct(
        public ?int $gt,
        public ?int $lte,
    ) {}

    public function holds(int $input): bool
    {
        return ($this->gt === null || $input > $this->gt) && ($this->lte === null || $input <= $this->lte);
    }

    public function sameAs(?self $other): bool
    {
        return $other !== null && $this->gt === $other->gt && $this->lte === $other->lte;
    }

    /** The lower bound as a number to sort by: an open lower bound is below every `gt`. */
    public function lowerKey(): int
    {
        return $this->gt ?? -1;
    }
}
