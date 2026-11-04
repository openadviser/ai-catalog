<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigInteger;
use Brick\Math\BigRational;

/**
 * A component of a built schedule: what the basis records for it (BASIS-1). Only a `priced` entry
 * carries a unit, a `per`, an amount, a meter, a factor and a window.
 *
 * @internal
 */
final readonly class Entry
{
    /**
     * @param 'priced'|'inapplicable'|'unsupported'|'no-rate' $disposition
     * @param string|null                                     $amount      canonical form
     */
    public function __construct(
        public string $component,
        public string $disposition,
        public ?string $unit = null,
        public ?int $per = null,
        public ?string $amount = null,
        public ?int $factor = null,
        public ?string $meter = null,
        public ?string $validFrom = null,
        public ?string $validUntil = null,
    ) {}

    /** Whether the entry is priced in a compound unit, for which 1.0.0 defines no arithmetic (UNIT-3). */
    public function isCompound(): bool
    {
        return $this->disposition === 'priced' && $this->factor === null;
    }

    /**
     * UNIT-2: a quantity `q` costs exactly `q * a / (p * f)`.
     *
     * @throws \LogicException when the entry is not priced or is compound
     */
    public function cost(int $quantity): BigRational
    {
        if ($this->amount === null || $this->per === null || $this->factor === null) {
            throw new \LogicException('only an entry priced in a simple unit has a cost');
        }

        return Amount::rational($this->amount)
            ->multipliedBy($quantity)
            ->dividedBy(BigInteger::of($this->per)->multipliedBy($this->factor))
            ->simplified();
    }
}
