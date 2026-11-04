<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * The expected digest of a catalog (VAL-2).
 *
 * A digest is 64 lowercase hexadecimal characters; any other spelling cannot equal a computed digest.
 * The sidecar `catalog.json.sha256` is in `sha256sum` format: its digest is the first
 * whitespace-delimited field of its first line.
 *
 * @internal
 */
final class Digest
{
    /** Whether the text is a digest: exactly 64 lowercase hexadecimal characters. */
    public static function isDigest(string $text): bool
    {
        return preg_match('/\A[0-9a-f]{64}\z/', $text) === 1;
    }

    /**
     * The first whitespace-delimited field of the first line of the sidecar text, or the empty string
     * when there is none. The first line ends at the first line feed; a carriage return before it is
     * ignored (it is whitespace).
     */
    public static function fromSidecar(string $sidecar): string
    {
        $firstLine = explode("\n", $sidecar, 2)[0];
        if (preg_match('/\A[ \t\r]*([^ \t\r]+)/', $firstLine, $m) !== 1) {
            return '';
        }

        return $m[1];
    }
}
