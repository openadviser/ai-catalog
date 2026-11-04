<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/**
 * The result of `price` (PRICE-3). The figures are strings, never floats: `exact` is `N/D` in lowest
 * terms, `estimate` and `booked` have exactly the currency's number of fractional digits.
 */
final readonly class Price
{
    /**
     * @param string $modelId     the resolved model id, not the alias asked for
     * @param int    $schedule    index of the chosen schedule in the basis's `schedules`
     * @param string $basis       the canonical RFC 8785 bytes of the basis (BASIS-2)
     * @param string $basisSha256 lowercase hex sha256 of `$basis`
     */
    public function __construct(
        public string $provider,
        public string $modelId,
        public string $tier,
        public string $currency,
        public int $schedule,
        public string $exact,
        public string $estimate,
        public string $booked,
        public string $basis,
        public string $basisSha256,
    ) {}
}
