<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\Exception\BasisException;
use OpenAdviser\AiCatalog\Exception\ConversionException;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Internal\Amount;
use OpenAdviser\AiCatalog\Internal\BasisChecker;
use OpenAdviser\AiCatalog\Internal\Engine;
use OpenAdviser\AiCatalog\Internal\Vocab;
use stdClass;

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
     * @param UsageReport|array<mixed>|stdClass $usage
     * @param array<mixed>|null                 $conditionInputs null, or exactly `['inputTokens' => 'unknown']`
     *
     * @throws BasisException `basis-hash-mismatch`, `unsupported-basis-version` or `invalid-basis`
     * @throws PriceException the refusals of `price` that apply once the rates are known
     */
    public static function priceFromBasis(string $basis, string $basisSha256, UsageReport|array|stdClass $usage, ?array $conditionInputs = null): BasisPrice
    {
        $parsed = BasisChecker::check($basis, $basisSha256);
        $unknown = false;
        if ($conditionInputs !== null) {
            if ($conditionInputs !== ['inputTokens' => 'unknown']) {
                throw new PriceException(ErrorCode::InvalidRequest, 'conditionInputs must be exactly {"inputTokens": "unknown"}');
            }
            $unknown = true;
        }
        $report = $usage instanceof UsageReport ? $usage : UsageReport::fromArray($usage);
        $figures = Engine::price($parsed->schedules, $parsed->conditionInputs, $report, $unknown, $parsed->exponent);

        return new BasisPrice($parsed->currency, $figures->schedule, $figures->exact, $figures->estimate, $figures->booked);
    }

    /**
     * UNIT-4. Converts a rate `(unit, per, amount)` into the target `(unit, per)` exactly, and returns
     * the amount in canonical form (NUM-4). A conversion that is not exact at `$scale` fractional
     * digits is refused, never rounded.
     *
     * @param string $unit   the rate's unit
     * @param int    $per    the rate's `per`
     * @param string $amount the rate's amount, a NUM-1 string
     * @param string $toUnit the target unit
     * @param int    $toPer  the target `per`, a power of ten from 1 to 10^9
     * @param int    $scale  the fractional digits the consumer can hold, 0 to 12
     *
     * @throws ConversionException `invalid-per`, `dimension-mismatch`, `unsupported-unit` or `inexact-conversion`;
     *                             `unknown-unit`, `invalid-amount` or `invalid-per` for a source rate that is not
     *                             a catalog rate; `invalid-request` when `$scale` is outside 0 to 12 (API-1)
     */
    public static function convertRate(string $unit, int $per, string $amount, string $toUnit, int $toPer, int $scale): string
    {
        if ($scale < 0 || $scale > 12) {
            throw new ConversionException(ErrorCode::InvalidRequest, 'scale must be an integer from 0 to 12');
        }
        // Step 1: the target per; the source per is held to the same rule.
        if (!in_array($toPer, Vocab::PERS, true) || !in_array($per, Vocab::PERS, true)) {
            throw new ConversionException(ErrorCode::InvalidPer, 'per must be a power of ten from 1 to 10^9');
        }
        if (!Vocab::isUnit($unit)) {
            throw new ConversionException(ErrorCode::UnknownUnit, $unit);
        }
        if (!Vocab::isUnit($toUnit)) {
            throw new ConversionException(ErrorCode::UnknownUnit, $toUnit);
        }
        if (!Amount::isValid($amount)) {
            throw new ConversionException(ErrorCode::InvalidAmount, $amount);
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
