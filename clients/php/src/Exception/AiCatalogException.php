<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Exception;

use OpenAdviser\AiCatalog\ErrorCode;
use RuntimeException;

/**
 * A refusal defined by the specification. {@see self::$errorCode} is the code of Appendix A; it is
 * what a caller branches on. The message is for people and may change between releases.
 */
abstract class AiCatalogException extends RuntimeException
{
    public function __construct(
        public readonly ErrorCode $errorCode,
        string $detail = '',
    ) {
        parent::__construct($detail === '' ? $errorCode->value : $errorCode->value . ': ' . $detail);
    }

    /** The specification's code as a string, such as `usage-incomplete`. */
    final public function errorCode(): string
    {
        return $this->errorCode->value;
    }
}
