<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigInteger;
use Brick\Math\BigRational;

/**
 * The exact total of a chosen schedule and its two roundings (Section 4).
 *
 * @internal
 */
final readonly class Figures
{
    public function __construct(
        public int $schedule,
        public string $exact,
        public string $estimate,
        public string $booked,
    ) {}

    /**
     * ROUND-2 and ROUND-3 on an exact total, computed in integers.
     */
    public static function of(int $schedule, BigRational $total, int $exponent): self
    {
        $total = $total->simplified();
        $n = $total->getNumerator();
        $d = $total->getDenominator();
        $scale = BigInteger::of(10)->power($exponent);

        // floor((2 * N * 10^e + D) / (2 * D)); N >= 0, so truncation is the floor.
        $estimate = $n->multipliedBy(2)->multipliedBy($scale)->plus($d)->quotient($d->multipliedBy(2));
        $booked = $estimate;
        if ($total->isPositive() && $estimate->isZero()) {
            $booked = BigInteger::one();
        }

        return new self($schedule, $n . '/' . $d, self::minorUnits($estimate, $exponent), self::minorUnits($booked, $exponent));
    }

    /** A count of minor units as a decimal string with exactly `$exponent` fractional digits. */
    private static function minorUnits(BigInteger $minor, int $exponent): string
    {
        $digits = str_pad((string) $minor, $exponent + 1, '0', STR_PAD_LEFT);
        if ($exponent === 0) {
            return $digits;
        }

        return substr($digits, 0, -$exponent) . '.' . substr($digits, -$exponent);
    }
}
