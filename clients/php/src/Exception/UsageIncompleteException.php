<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Exception;

use OpenAdviser\AiCatalog\ErrorCode;

/** The usage report cannot be priced (USAGE-1, USAGE-2). Carries the sorted `missing` components. */
final class UsageIncompleteException extends PriceException
{
    /**
     * @param list<string> $missing required components absent from the report, sorted by code point;
     *                              empty for a `totals-only` report that happens to cover them all
     */
    public function __construct(
        public readonly array $missing,
    ) {
        parent::__construct(
            ErrorCode::UsageIncomplete,
            $missing === [] ? 'the report is not complete' : 'missing ' . implode(', ', $missing),
        );
    }
}
