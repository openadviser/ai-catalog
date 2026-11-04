<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Exception;

/** A call was refused by `price` or `priceFromBasis`, or a model lookup failed. No amount is returned. */
class PriceException extends AiCatalogException {}
