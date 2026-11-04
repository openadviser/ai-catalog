<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use RuntimeException;

/**
 * The text is not JSON this specification accepts: a syntax error, a duplicate member (JSON-1) or a
 * number that is not an integer literal (JSON-2). Each caller maps it to its own code.
 *
 * @internal
 */
final class JsonFailure extends RuntimeException {}
