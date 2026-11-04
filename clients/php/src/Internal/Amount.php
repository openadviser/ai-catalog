<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigInteger;
use Brick\Math\BigRational;

/**
 * Amounts of NUM-1 as exact rationals, and their canonical text (NUM-4). No float is involved at any
 * point.
 *
 * @internal
 */
final class Amount
{
    public const string PATTERN = '/\A(0|[1-9][0-9]*)(\.[0-9]{1,12})?\z/';

    private function __construct() {}

    public static function isValid(mixed $value): bool
    {
        return is_string($value) && preg_match(self::PATTERN, $value) === 1;
    }

    /** NUM-4: strip trailing zeros of the fraction, and the point if no fraction remains. */
    public static function canonical(string $amount): string
    {
        if (!str_contains($amount, '.')) {
            return $amount;
        }

        return rtrim(rtrim($amount, '0'), '.');
    }

    /** The exact value of a valid amount: its digits over a power of ten, in lowest terms. */
    public static function rational(string $amount): BigRational
    {
        $parts = explode('.', $amount, 2);
        $fraction = $parts[1] ?? '';
        $numerator = BigInteger::of($parts[0] . $fraction);
        $denominator = BigInteger::of(10)->power(strlen($fraction));

        // `of('n/d')` exists in every supported brick/math; `nd()` is deprecated in 0.14.
        return BigRational::of($numerator . '/' . $denominator)->simplified();
    }
}
