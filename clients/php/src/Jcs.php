<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use Brick\Math\BigInteger;
use InvalidArgumentException;
use stdClass;

/**
 * The JSON Canonicalization Scheme, RFC 8785, for the value types the basis allows (BASIS-2):
 * strings, integers below 2^53, `null`, booleans, arrays and objects.
 *
 * - no whitespace;
 * - object members sorted by name, comparing UTF-16 code units;
 * - integers in decimal, without exponent or fraction;
 * - strings escape only `"`, `\` and the controls below U+0020, as `\b`, `\t`, `\n`, `\f`, `\r` or
 *   `\u00xx` with lowercase hex; everything else, `/` and non-ASCII included, is written as is.
 *
 * A float is refused, not formatted: no amount, quantity or sum in this package is ever a float, and
 * RFC 8785's number formatting is only needed for them.
 *
 * A PHP list becomes a JSON array and any other array becomes a JSON object. An empty PHP array is
 * `[]`; write an empty object as `new \stdClass()`.
 */
final class Jcs
{
    /** The largest magnitude an I-JSON number may have exactly: 2^53 - 1. */
    private const int MAX_SAFE_INTEGER = 9007199254740991;

    private function __construct() {}

    /**
     * @throws InvalidArgumentException when the value has a type or content RFC 8785 cannot write here
     */
    public static function encode(mixed $value): string
    {
        return self::write($value);
    }

    private static function write(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            return self::integer($value);
        }
        if ($value instanceof BigInteger) {
            throw new InvalidArgumentException('an integer of magnitude 2^53 or more cannot be written in canonical JSON');
        }
        if (is_string($value)) {
            return self::string($value);
        }
        if ($value instanceof stdClass) {
            return self::object(get_object_vars($value));
        }
        if (is_array($value)) {
            return array_is_list($value) ? self::list($value) : self::object($value);
        }

        throw new InvalidArgumentException('a ' . get_debug_type($value) . ' cannot be written in canonical JSON');
    }

    private static function integer(int $value): string
    {
        if ($value > self::MAX_SAFE_INTEGER || $value < -self::MAX_SAFE_INTEGER) {
            throw new InvalidArgumentException('an integer of magnitude 2^53 or more cannot be written in canonical JSON');
        }

        return (string) $value;
    }

    /** @param array<int|string, mixed> $items */
    private static function list(array $items): string
    {
        $parts = [];
        foreach ($items as $item) {
            $parts[] = self::write($item);
        }

        return '[' . implode(',', $parts) . ']';
    }

    /** @param array<int|string, mixed> $members */
    private static function object(array $members): string
    {
        $names = array_map(strval(...), array_keys($members));
        $keyed = [];
        foreach ($names as $name) {
            if (preg_match('//u', $name) !== 1) {
                throw new InvalidArgumentException('a member name must be valid UTF-8');
            }
            $keyed[$name] = self::utf16Units($name);
        }
        usort($names, static fn(string $a, string $b): int => self::compareUnits($keyed[$a], $keyed[$b]));
        $parts = [];
        foreach ($names as $name) {
            $parts[] = self::string($name) . ':' . self::write($members[$name]);
        }

        return '{' . implode(',', $parts) . '}';
    }

    private static function string(string $value): string
    {
        if (preg_match('//u', $value) !== 1) {
            throw new InvalidArgumentException('a string must be valid UTF-8');
        }

        return '"' . preg_replace_callback(
            '/["\\\\\x00-\x1f]/',
            static fn(array $m): string => match ($m[0]) {
                '"' => '\\"',
                '\\' => '\\\\',
                "\x08" => '\\b',
                "\x09" => '\\t',
                "\x0a" => '\\n',
                "\x0c" => '\\f',
                "\x0d" => '\\r',
                default => sprintf('\\u%04x', ord($m[0])),
            },
            $value,
        ) . '"';
    }

    /**
     * Lexicographic comparison of code-unit lists; a proper prefix sorts first. PHP's own `<=>` on
     * arrays compares lengths first, which is not what RFC 8785 asks for.
     *
     * @param list<int> $a
     * @param list<int> $b
     */
    private static function compareUnits(array $a, array $b): int
    {
        $common = min(count($a), count($b));
        for ($i = 0; $i < $common; ++$i) {
            if ($a[$i] !== $b[$i]) {
                return $a[$i] <=> $b[$i];
            }
        }

        return count($a) <=> count($b);
    }

    /**
     * The UTF-16 code units of a UTF-8 string, which is what RFC 8785 sorts member names by. Arrays
     * of ints compare element by element, and a prefix sorts first, as the RFC requires.
     *
     * @return list<int>
     */
    private static function utf16Units(string $utf8): array
    {
        $units = [];
        $length = strlen($utf8);
        for ($i = 0; $i < $length;) {
            $byte = ord($utf8[$i]);
            if ($byte < 0x80) {
                $codePoint = $byte;
                $i += 1;
            } elseif ($byte < 0xE0) {
                $codePoint = ($byte & 0x1F) << 6 | (ord($utf8[$i + 1]) & 0x3F);
                $i += 2;
            } elseif ($byte < 0xF0) {
                $codePoint = ($byte & 0x0F) << 12 | (ord($utf8[$i + 1]) & 0x3F) << 6 | (ord($utf8[$i + 2]) & 0x3F);
                $i += 3;
            } else {
                $codePoint = ($byte & 0x07) << 18 | (ord($utf8[$i + 1]) & 0x3F) << 12 | (ord($utf8[$i + 2]) & 0x3F) << 6 | (ord($utf8[$i + 3]) & 0x3F);
                $i += 4;
            }
            if ($codePoint >= 0x10000) {
                $offset = $codePoint - 0x10000;
                $units[] = 0xD800 | $offset >> 10;
                $units[] = 0xDC00 | $offset & 0x3FF;
            } else {
                $units[] = $codePoint;
            }
        }

        return $units;
    }
}
