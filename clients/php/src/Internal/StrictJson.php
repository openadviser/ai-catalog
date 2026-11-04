<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigInteger;
use JsonException;
use stdClass;

/**
 * Reads JSON text the way the specification requires (JSON-1, JSON-2).
 *
 * Two parsers can read the same bytes differently, so the bytes are checked before any value is
 * built from them:
 *
 * 1. A scanner walks the raw text once. It rejects anything that is not RFC 8259 JSON, an object that
 *    repeats a member name (compared after unescaping), and every number that is not an integer
 *    literal `-?(0|[1-9][0-9]*)`. Nothing is converted, so nothing is rounded.
 * 2. Only then does `json_decode` build the value, with `JSON_BIGINT_AS_STRING` so that no integer
 *    becomes a float. An integer that does not fit a PHP int, and `-0` (which PHP may read as the
 *    int 0), are recorded by the scanner with their path and put back exactly: the first as a
 *    {@see BigInteger}, the second as the float -0.0.
 *
 * The result has objects as stdClass and arrays as lists, so `{}` and `[]` stay distinct. Integers
 * are `int` or {@see BigInteger}. The only float in it is `-0.0`, the one value a validator must
 * refuse wherever it requires a nonnegative integer, and not read as 0 (JSON-2).
 *
 * @internal
 */
final class StrictJson
{
    /** Nesting deeper than this is refused (JSON-1); a document nested exactly this deep is read. */
    private const int MAX_DEPTH = 512;

    private int $pos = 0;

    private readonly int $length;

    /** @var list<string|int> */
    private array $path = [];

    /** @var list<array{0: list<string|int>, 1: float|BigInteger}> */
    private array $overrides = [];

    private function __construct(private readonly string $text)
    {
        $this->length = strlen($text);
    }

    /**
     * @throws JsonFailure when the text is not acceptable JSON
     */
    public static function decode(string $text): mixed
    {
        if (preg_match('//u', $text) !== 1) {
            throw new JsonFailure('the text is not valid UTF-8');
        }
        $scanner = new self($text);
        $scanner->scanDocument();
        try {
            $value = json_decode($text, false, self::MAX_DEPTH + 1, JSON_BIGINT_AS_STRING | JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            throw new JsonFailure($e->getMessage(), 0, $e);
        }
        foreach ($scanner->overrides as [$path, $replacement]) {
            $value = self::put($value, $path, $replacement);
        }

        return $value;
    }

    /**
     * @param list<string|int> $path
     */
    private static function put(mixed $node, array $path, float|BigInteger $replacement): mixed
    {
        if ($path === []) {
            return $replacement;
        }
        $key = array_shift($path);
        if ($node instanceof stdClass) {
            $name = (string) $key;
            $node->{$name} = self::put($node->{$name}, $path, $replacement);
        } elseif (is_array($node) && is_int($key)) {
            $node[$key] = self::put($node[$key], $path, $replacement);
        }

        return $node;
    }

    private function scanDocument(): void
    {
        $this->skipSpace();
        $this->scanValue(0);
        $this->skipSpace();
        if ($this->pos !== $this->length) {
            $this->fail('unexpected text after the document');
        }
    }

    private function fail(string $message): never
    {
        throw new JsonFailure($message . ' at byte ' . $this->pos);
    }

    private function skipSpace(): void
    {
        while ($this->pos < $this->length) {
            $c = $this->text[$this->pos];
            if ($c !== ' ' && $c !== "\t" && $c !== "\n" && $c !== "\r") {
                return;
            }
            ++$this->pos;
        }
    }

    private function scanValue(int $depth): void
    {
        if ($this->pos >= $this->length) {
            $this->fail('unexpected end of the text');
        }
        $c = $this->text[$this->pos];
        if ($c === '{') {
            $this->scanObject($depth + 1);
        } elseif ($c === '[') {
            $this->scanArray($depth + 1);
        } elseif ($c === '"') {
            $this->scanString();
        } elseif ($c === '-' || ($c >= '0' && $c <= '9')) {
            $this->scanNumber();
        } elseif ($this->literal('true') || $this->literal('false') || $this->literal('null')) {
            return;
        } else {
            $this->fail('unexpected character');
        }
    }

    private function literal(string $word): bool
    {
        if (substr($this->text, $this->pos, strlen($word)) === $word) {
            $this->pos += strlen($word);

            return true;
        }

        return false;
    }

    private function scanObject(int $depth): void
    {
        if ($depth > self::MAX_DEPTH) {
            $this->fail('nesting is too deep');
        }
        ++$this->pos;
        $seen = [];
        $this->skipSpace();
        if ($this->peek() === '}') {
            ++$this->pos;

            return;
        }
        while (true) {
            $this->skipSpace();
            if ($this->peek() !== '"') {
                $this->fail('an object member name must be a string');
            }
            $name = $this->scanString();
            if (isset($seen[$name])) {
                $this->fail('duplicate member ' . json_encode($name, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            }
            $seen[$name] = true;
            $this->skipSpace();
            if ($this->peek() !== ':') {
                $this->fail('expected ":"');
            }
            ++$this->pos;
            $this->skipSpace();
            $this->path[] = $name;
            $this->scanValue($depth);
            array_pop($this->path);
            $this->skipSpace();
            $c = $this->peek();
            ++$this->pos;
            if ($c === '}') {
                return;
            }
            if ($c !== ',') {
                --$this->pos;
                $this->fail('expected "," or "}"');
            }
        }
    }

    private function scanArray(int $depth): void
    {
        if ($depth > self::MAX_DEPTH) {
            $this->fail('nesting is too deep');
        }
        ++$this->pos;
        $this->skipSpace();
        if ($this->peek() === ']') {
            ++$this->pos;

            return;
        }
        $index = 0;
        while (true) {
            $this->skipSpace();
            $this->path[] = $index++;
            $this->scanValue($depth);
            array_pop($this->path);
            $this->skipSpace();
            $c = $this->peek();
            ++$this->pos;
            if ($c === ']') {
                return;
            }
            if ($c !== ',') {
                --$this->pos;
                $this->fail('expected "," or "]"');
            }
        }
    }

    private function peek(): string
    {
        return $this->pos < $this->length ? $this->text[$this->pos] : '';
    }

    /**
     * Scans a string and returns its value with every escape resolved (the form member names are
     * compared in).
     */
    private function scanString(): string
    {
        ++$this->pos;
        $out = '';
        while (true) {
            if ($this->pos >= $this->length) {
                $this->fail('unterminated string');
            }
            $c = $this->text[$this->pos];
            if ($c === '"') {
                ++$this->pos;

                return $out;
            }
            if ($c < ' ') {
                $this->fail('a control character must be escaped in a string');
            }
            if ($c !== '\\') {
                $out .= $c;
                ++$this->pos;
                continue;
            }
            $e = $this->text[$this->pos + 1] ?? '';
            $this->pos += 2;
            switch ($e) {
                case '"':
                case '\\':
                case '/':
                    $out .= $e;
                    break;
                case 'b':
                    $out .= "\x08";
                    break;
                case 'f':
                    $out .= "\x0c";
                    break;
                case 'n':
                    $out .= "\n";
                    break;
                case 'r':
                    $out .= "\r";
                    break;
                case 't':
                    $out .= "\t";
                    break;
                case 'u':
                    $out .= self::utf8($this->scanUnicodeEscape());
                    break;
                default:
                    $this->pos -= 2;
                    $this->fail('invalid escape');
            }
        }
    }

    private function scanUnicodeEscape(): int
    {
        $unit = $this->hex4();
        if ($unit >= 0xD800 && $unit <= 0xDBFF) {
            if (substr($this->text, $this->pos, 2) !== '\\u') {
                $this->fail('a high surrogate needs a low surrogate');
            }
            $this->pos += 2;
            $low = $this->hex4();
            if ($low < 0xDC00 || $low > 0xDFFF) {
                $this->fail('a high surrogate needs a low surrogate');
            }

            return 0x10000 + (($unit - 0xD800) << 10) + ($low - 0xDC00);
        }
        if ($unit >= 0xDC00 && $unit <= 0xDFFF) {
            $this->fail('a lone low surrogate');
        }

        return $unit;
    }

    private function hex4(): int
    {
        $hex = substr($this->text, $this->pos, 4);
        if (preg_match('/\A[0-9a-fA-F]{4}\z/', $hex) !== 1) {
            $this->fail('invalid \\u escape');
        }
        $this->pos += 4;

        return (int) hexdec($hex);
    }

    /**
     * Whether an integer's digits are too many for `json_decode` to return an int. It switches to the
     * big-integer path for 19 digits at or above "9223372036854775808" (either sign) and for 20 or more.
     */
    private static function exceedsPhpInt(string $digits): bool
    {
        $length = strlen($digits);

        return $length > 19 || ($length === 19 && strcmp($digits, '9223372036854775808') >= 0);
    }

    private static function utf8(int $codePoint): string
    {
        return match (true) {
            $codePoint < 0x80 => chr($codePoint & 0x7F),
            $codePoint < 0x800 => chr((0xC0 | $codePoint >> 6) & 0xFF) . chr(0x80 | $codePoint & 0x3F),
            $codePoint < 0x10000 => chr((0xE0 | $codePoint >> 12) & 0xFF) . chr(0x80 | $codePoint >> 6 & 0x3F) . chr(0x80 | $codePoint & 0x3F),
            default => chr((0xF0 | $codePoint >> 18) & 0xFF) . chr(0x80 | $codePoint >> 12 & 0x3F) . chr(0x80 | $codePoint >> 6 & 0x3F) . chr(0x80 | $codePoint & 0x3F),
        };
    }

    /** JSON-2: only `-?(0|[1-9][0-9]*)` is accepted; the text is never converted to a number here. */
    private function scanNumber(): void
    {
        $start = $this->pos;
        if ($this->peek() === '-') {
            ++$this->pos;
        }
        $c = $this->peek();
        if ($c === '0') {
            ++$this->pos;
        } elseif ($c >= '1' && $c <= '9') {
            while ($this->peek() >= '0' && $this->peek() <= '9' && $this->peek() !== '') {
                ++$this->pos;
            }
        } else {
            $this->fail('a number needs digits');
        }
        $next = $this->peek();
        if ($next === '.' || $next === 'e' || $next === 'E') {
            $this->pos = $start;
            $this->fail('a number must be an integer literal, without fraction or exponent');
        }
        if ($next >= '0' && $next <= '9' && $next !== '') {
            $this->fail('a number has a leading zero');
        }
        $literal = substr($this->text, $start, $this->pos - $start);
        if ($literal === '-0') {
            $this->overrides[] = [$this->path, -0.0];
        } elseif (self::exceedsPhpInt(ltrim($literal, '-'))) {
            $this->overrides[] = [$this->path, BigInteger::of($literal)];
        }
    }
}
