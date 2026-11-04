<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Exception;

/** A rate cannot be converted exactly into the consumer's unit (UNIT-4). */
final class ConversionException extends AiCatalogException {}
