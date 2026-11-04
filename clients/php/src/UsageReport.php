<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Internal\JsonFailure;
use OpenAdviser\AiCatalog\Internal\StrictJson;
use OpenAdviser\AiCatalog\Internal\Vocab;
use stdClass;

/**
 * A usage report (Section 7): what one call consumed, in the meter of each component's dimension
 * (UNIT-2). Durations are integer milliseconds.
 *
 * Construction applies USAGE-4 (shape) and then NUM-3 (the bound), and nothing else; whether the
 * report is enough to price a call is decided against an offering, by `price`.
 */
final readonly class UsageReport
{
    public const string COMPLETE = 'complete';

    public const string TOTALS_ONLY = 'totals-only';

    public const string PARTIAL = 'partial';

    public const string UNKNOWN = 'unknown';

    private const array COMPLETENESS = [self::COMPLETE, self::TOTALS_ONLY, self::PARTIAL, self::UNKNOWN];

    /**
     * @param array<string, int> $quantities component => quantity, each `0 <= q < 2^53`
     */
    private function __construct(
        public string $completeness,
        public array $quantities,
    ) {}

    /**
     * A report from PHP values: `['completeness' => ..., 'quantities' => ['input' => 1200, ...]]`.
     *
     * A quantity must be an `int` (or a {@see BigInteger}, which is how {@see self::fromJson()} keeps
     * a literal too large for an int). Strings, booleans and floats are `invalid-usage`: a float cannot
     * say which text it was read from. Read JSON text with {@see self::fromJson()}, or with
     * `JSON_BIGINT_AS_STRING` off and no float produced, never with a plain `json_decode`.
     *
     * A report decoded to objects (`json_decode($text)` without `true`) keeps `{}` and `[]` apart; one decoded
     * to arrays cannot, so `quantities` as an empty array is read as the empty object.
     *
     * @throws PriceException `invalid-usage` (USAGE-4) or `quantity-out-of-range` (NUM-3)
     */
    public static function fromArray(mixed $data): self
    {
        $members = self::members($data);
        if ($members === null || !self::sameKeys($members)) {
            throw new PriceException(ErrorCode::InvalidUsage, 'a usage report has exactly completeness and quantities');
        }
        $completeness = $members['completeness'];
        if (!is_string($completeness) || !in_array($completeness, self::COMPLETENESS, true)) {
            throw new PriceException(ErrorCode::InvalidUsage, 'completeness is not one of the four values');
        }
        $quantities = $members['quantities'];
        // A report that was decoded to objects (a stdClass root, which is what `fromJson` builds) tells
        // `{}` from `[]`, so a JSON array is not an object there. A report given as a PHP array cannot:
        // `json_decode(..., true)` turns both into `[]`, and an empty array is read as the empty object.
        if ($data instanceof stdClass && !$quantities instanceof stdClass) {
            throw new PriceException(ErrorCode::InvalidUsage, 'quantities is not an object');
        }
        if ($quantities instanceof stdClass) {
            $quantities = get_object_vars($quantities);
        }
        if (!is_array($quantities) || ($quantities !== [] && array_is_list($quantities))) {
            throw new PriceException(ErrorCode::InvalidUsage, 'quantities is not an object');
        }

        // USAGE-4 for every member first, then NUM-3's bound, so the report's first refusal does not
        // depend on member order.
        $checked = [];
        $tooLarge = null;
        foreach ($quantities as $key => $value) {
            $component = (string) $key;
            if (!Vocab::isComponent($component)) {
                throw new PriceException(ErrorCode::InvalidUsage, $component . ' is not a component');
            }
            $quantity = self::quantity($value, $component);
            if ($quantity === null) {
                $tooLarge ??= $component;
            } else {
                $checked[$component] = $quantity;
            }
        }
        if ($tooLarge !== null) {
            throw new PriceException(ErrorCode::QuantityOutOfRange, $tooLarge . ' is 2^53 or more');
        }

        return new self($completeness, $checked);
    }

    /**
     * A report from JSON text. The text is held to JSON-1 and JSON-2: a repeated member or a number
     * that is not an integer literal (`1.5`, `1e3`, `1e-999`) is refused with `invalid-json`, before
     * any value is built.
     *
     * @throws PriceException
     */
    public static function fromJson(string $json): self
    {
        try {
            $data = StrictJson::decode($json);
        } catch (JsonFailure $e) {
            throw new PriceException(ErrorCode::InvalidJson, $e->getMessage());
        }

        return self::fromArray($data);
    }

    /**
     * @return array<int|string, mixed>|null
     */
    private static function members(mixed $data): ?array
    {
        if ($data instanceof stdClass) {
            return get_object_vars($data);
        }

        return is_array($data) && !array_is_list($data) ? $data : null;
    }

    /** @param array<int|string, mixed> $members */
    private static function sameKeys(array $members): bool
    {
        $keys = array_map(strval(...), array_keys($members));
        sort($keys);

        return $keys === ['completeness', 'quantities'];
    }

    /**
     * @return int|null the quantity, or null when it is 2^53 or more
     *
     * @throws PriceException `invalid-usage` for anything else that is not a nonnegative integer
     */
    private static function quantity(mixed $value, string $component): ?int
    {
        if (is_float($value)) {
            // A float is never a quantity. `json_decode` turns 0.99999999999999999 into 1.0 and 1e-999
            // into 0.0, text JSON-2 requires to be refused; once it is a float, that cannot be told.
            throw new PriceException(ErrorCode::InvalidUsage, $component . ' is a float, not an integer');
        }
        if ($value instanceof BigInteger) {
            if ($value->isNegative()) {
                throw new PriceException(ErrorCode::InvalidUsage, $component . ' is negative');
            }

            return $value->isLessThan(Vocab::BOUND) ? $value->toInt() : null;
        }
        if (!is_int($value)) {
            throw new PriceException(ErrorCode::InvalidUsage, $component . ' is not an integer');
        }
        if ($value < 0) {
            throw new PriceException(ErrorCode::InvalidUsage, $component . ' is negative');
        }

        return $value < Vocab::BOUND ? $value : null;
    }
}
