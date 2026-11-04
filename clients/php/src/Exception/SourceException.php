<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Exception;

use RuntimeException;

/**
 * The catalog bytes could not be fetched or read (an unreadable file, a network failure, an HTTP
 * status other than 200). This is not a specification refusal and has no code: no bytes arrived, so
 * there was nothing to validate.
 */
final class SourceException extends RuntimeException {}
