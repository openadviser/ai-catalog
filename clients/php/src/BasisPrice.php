<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/** The result of `priceFromBasis` (BASIS-3): the figures of `price`, without the identity and basis. */
final readonly class BasisPrice
{
    public function __construct(
        public string $currency,
        public int $schedule,
        public string $exact,
        public string $estimate,
        public string $booked,
    ) {}
}
