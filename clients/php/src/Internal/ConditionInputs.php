<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use OpenAdviser\AiCatalog\ErrorCode;
use OpenAdviser\AiCatalog\Exception\PriceException;
use stdClass;

/**
 * The request's `conditionInputs` (PRICE-1, COND-7): absent, or exactly `{ "inputTokens": "unknown" }`.
 * A decoded JSON object may arrive as an array or as a stdClass; both mean the same thing.
 *
 * @internal
 */
final class ConditionInputs
{
    private function __construct() {}

    /**
     * @return bool true for `{ "inputTokens": "unknown" }`, false when absent
     *
     * @throws PriceException `invalid-request` for anything else
     */
    public static function isUnknown(mixed $value): bool
    {
        if ($value === null) {
            return false;
        }
        if ($value instanceof stdClass) {
            $value = get_object_vars($value);
        }
        if ($value !== ['inputTokens' => 'unknown']) {
            throw new PriceException(ErrorCode::InvalidRequest, 'conditionInputs must be exactly {"inputTokens": "unknown"}');
        }

        return true;
    }
}
