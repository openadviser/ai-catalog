<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\Exception\BasisException;
use OpenAdviser\AiCatalog\Exception\ConversionException;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Internal\Amount;
use OpenAdviser\AiCatalog\Internal\BasisChecker;
use OpenAdviser\AiCatalog\Internal\ConditionInputs;
use OpenAdviser\AiCatalog\Internal\Engine;
use OpenAdviser\AiCatalog\Internal\Vocab;

/**
 * The parts of pricing that need no catalog: replaying a price from its basis (BASIS-3) and
 * converting a rate into a consumer's unit (UNIT-4).
 */
final class Pricing
{
    private function __construct() {}

    /**
     * BASIS-3, BASIS-4. Prices a usage report from a basis alone, without a catalog and without an
     * instant, after checking the basis in the order BASIS-4 gives. For the same usage and
     * `$conditionInputs` the result equals the `price` result that wrote the basis.
     *
     * @param string                            $basis           the canonical bytes, as `Price::$basis` holds them
     * @param string                            $basisSha256     the digest stated with them
     * @param mixed                             $usage           a {@see UsageReport} or the PHP value of one
     * @param mixed                             $conditionInputs null, or exactly `['inputTokens' => 'unknown']`
     *
     * @throws BasisException `basis-hash-mismatch`, `unsupported-basis-version` or `invalid-basis`
     * @throws PriceException the refusals of `price` that apply once the rates are known
     */
    public static function priceFromBasis(string $basis, string $basisSha256, mixed $usage, mixed $conditionInputs = null): BasisPrice
    {
        $parsed = BasisChecker::check($basis, $basisSha256);
        $unknown = ConditionInputs::isUnknown($conditionInputs);
        $report = $usage instanceof UsageReport ? $usage : UsageReport::fromArray($usage);
        $figures = Engine::price($parsed->schedules, $parsed->conditionInputs, $report, $unknown, $parsed->exponent);

        return new BasisPrice($parsed->currency, $figures->schedule, $figures->exact, $figures->estimate, $figures->booked);
    }

    /**
     * UNIT-4. Converts a rate `(unit, per, amount)` into the target `(unit, per)` exactly, and returns
     * the amount in canonical form (NUM-4). A conversion that is not exact at `$scale` fractional
     * digits is refused, never rounded.
     *
     * Every argument is judged, in the order below, before the steps of UNIT-4 (API-1), so a wrong
     * type is a refusal with a code and never a language error.
     *
     * @param mixed $unit   the rate's unit: a string of the unit vocabulary, else `unknown-unit`
     * @param mixed $per    the rate's `per`: an int power of ten from 1 to 10^9, else `invalid-per`
     * @param mixed $amount the rate's amount: a NUM-1 string, else `invalid-amount`
     * @param mixed $toUnit the target unit, as `$unit`
     * @param mixed $toPer  the target `per`, as `$per`
     * @param mixed $scale  the fractional digits the consumer can hold: an int from 0 to 12, else `invalid-request`
     *
     * @throws ConversionException `invalid-request`, `unknown-unit`, `invalid-amount`, `invalid-per`,
     *                             `dimension-mismatch`, `unsupported-unit` or `inexact-conversion`
     */
    public static function convertRate(mixed $unit, mixed $per, mixed $amount, mixed $toUnit, mixed $toPer, mixed $scale): string
    {
        // API-1: the arguments.
        if (!is_int($scale) || $scale < 0 || $scale > 12) {
            throw new ConversionException(ErrorCode::InvalidRequest, 'scale must be an integer from 0 to 12');
        }
        if (!is_string($unit) || !Vocab::isUnit($unit)) {
            throw new ConversionException(ErrorCode::UnknownUnit, 'the rate\'s unit is not a unit');
        }
        if (!is_string($toUnit) || !Vocab::isUnit($toUnit)) {
            throw new ConversionException(ErrorCode::UnknownUnit, 'the target unit is not a unit');
        }
        if (!is_string($amount) || !Amount::isValid($amount)) {
            throw new ConversionException(ErrorCode::InvalidAmount, 'the rate\'s amount is not an amount');
        }
        // Step 1 of UNIT-4, and the same rule for the source rate.
        if (!is_int($per) || !in_array($per, Vocab::PERS, true)) {
            throw new ConversionException(ErrorCode::InvalidPer, 'the rate\'s per is not a power of ten from 1 to 10^9');
        }
        if (!is_int($toPer) || !in_array($toPer, Vocab::PERS, true)) {
            throw new ConversionException(ErrorCode::InvalidPer, 'the target per is not a power of ten from 1 to 10^9');
        }
        // Step 2: the same dimension.
        if (Vocab::unitDimension($unit) !== Vocab::unitDimension($toUnit)) {
            throw new ConversionException(ErrorCode::DimensionMismatch, $unit . ' and ' . $toUnit . ' measure different things');
        }
        // Step 3: a compound unit cannot be converted.
        $from = Vocab::factor($unit);
        $to = Vocab::factor($toUnit);
        if ($from === null || $to === null) {
            throw new ConversionException(ErrorCode::UnsupportedUnit, 'a compound unit cannot be converted');
        }
        // Step 4: a2 = a * p2 * f(u2) / (p1 * f(u1)), exactly.
        $converted = Amount::rational($amount)
            ->multipliedBy(BigInteger::of($toPer)->multipliedBy($to))
            ->dividedBy(BigInteger::of($per)->multipliedBy($from))
            ->simplified();
        // Step 5: a2 * 10^s must be an integer.
        $scaled = $converted->multipliedBy(BigInteger::of(10)->power($scale))->simplified();
        if (!$scaled->getDenominator()->isEqualTo(1)) {
            throw new ConversionException(ErrorCode::InexactConversion, 'the converted amount has more than ' . $scale . ' fractional digits');
        }
        // Step 6: canonical form.
        $digits = str_pad((string) $scaled->getNumerator(), $scale + 1, '0', STR_PAD_LEFT);
        $text = $scale === 0 ? $digits : substr($digits, 0, -$scale) . '.' . substr($digits, -$scale);

        return Amount::canonical($text);
    }
}
