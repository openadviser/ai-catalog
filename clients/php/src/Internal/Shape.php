<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\ErrorCode;
use OpenAdviser\AiCatalog\Exception\AiCatalogException;
use stdClass;

/**
 * Small structural checks over decoded JSON, shared by the catalog and the basis validators. Each
 * check throws the exception class and code its caller gives it.
 *
 * @internal
 */
final class Shape
{
    /**
     * @param class-string<AiCatalogException> $exception
     */
    public function __construct(
        private readonly string $exception,
        private readonly ErrorCode $structure,
    ) {}

    public function fail(ErrorCode $code, string $path, string $message): never
    {
        throw new ($this->exception)($code, $path . ': ' . $message);
    }

    /** An error of the generic structural code. */
    public function bad(string $path, string $message): never
    {
        $this->fail($this->structure, $path, $message);
    }

    /**
     * A JSON object with exactly the required members and at most the optional ones.
     *
     * @param list<string> $required
     * @param list<string> $optional
     *
     * @return array<string, mixed>
     */
    public function object(mixed $value, string $path, array $required, array $optional = []): array
    {
        if (!$value instanceof stdClass) {
            $this->bad($path, 'must be an object');
        }
        $members = [];
        foreach (get_object_vars($value) as $name => $member) {
            $members[(string) $name] = $member;
        }
        foreach (array_keys($members) as $name) {
            if (!in_array($name, $required, true) && !in_array($name, $optional, true)) {
                $this->bad($path, 'unknown member "' . $name . '"');
            }
        }
        foreach ($required as $name) {
            if (!array_key_exists($name, $members)) {
                $this->bad($path, 'missing member "' . $name . '"');
            }
        }

        return $members;
    }

    /** @return list<mixed> */
    public function list(mixed $value, string $path, int $min = 0): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            $this->bad($path, 'must be an array');
        }
        if (count($value) < $min) {
            $this->bad($path, 'must have at least ' . $min . ' item(s)');
        }

        return $value;
    }

    public function string(mixed $value, string $path, int $minLength = 0): string
    {
        if (!is_string($value)) {
            $this->bad($path, 'must be a string');
        }
        if ($minLength > 0 && $value === '') {
            $this->bad($path, 'must not be empty');
        }

        return $value;
    }

    /** A string matching `$pattern` (an anchored PCRE), else the structural code. */
    public function matching(mixed $value, string $path, string $pattern): string
    {
        $string = $this->string($value, $path);
        if (preg_match($pattern, $string) !== 1) {
            $this->bad($path, 'does not match the required form');
        }

        return $string;
    }

    /** A string of at most `$max` characters (code points). */
    public function maxChars(string $value, string $path, int $max): string
    {
        if (preg_match_all('/./su', $value) > $max) {
            $this->bad($path, 'is longer than ' . $max . ' characters');
        }

        return $value;
    }

    /** A JSON integer `>= 0` (and `< $below` when given); a literal too large for an int is out of range. */
    public function nonNegativeInteger(mixed $value, string $path, ?int $below = null): int
    {
        if ($value instanceof BigInteger && !$value->isNegative()) {
            $this->bad($path, 'is out of range');
        }
        if (!is_int($value) || $value < 0) {
            $this->bad($path, 'must be a nonnegative integer');
        }
        if ($below !== null && $value >= $below) {
            $this->bad($path, 'must be below ' . $below);
        }

        return $value;
    }

    /** A nonnegative integer of any size, for members the schema leaves unbounded (such as an offset). */
    public function unboundedInteger(mixed $value, string $path): void
    {
        if ($value instanceof BigInteger && !$value->isNegative()) {
            return;
        }
        $this->nonNegativeInteger($value, $path);
    }

    public function unique(mixed $value, string $path): void
    {
        $seen = [];
        foreach ($this->list($value, $path) as $item) {
            $key = is_string($item) ? $item : serialize($item);
            if (isset($seen[$key])) {
                $this->bad($path, 'items must be unique');
            }
            $seen[$key] = true;
        }
    }
}
