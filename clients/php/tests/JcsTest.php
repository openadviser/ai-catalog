<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use Brick\Math\BigInteger;
use InvalidArgumentException;
use OpenAdviser\AiCatalog\Jcs;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use stdClass;

#[CoversClass(Jcs::class)]
final class JcsTest extends TestCase
{
    /**
     * @return iterable<string, array{mixed, string}>
     */
    public static function encodings(): iterable
    {
        yield 'null' => [null, 'null'];
        yield 'booleans' => [[true, false], '[true,false]'];
        yield 'zero' => [0, '0'];
        yield 'negative' => [-17, '-17'];
        yield 'largest safe integer' => [9007199254740991, '9007199254740991'];
        yield 'empty list' => [[], '[]'];
        yield 'empty object' => [new stdClass(), '{}'];
        yield 'no whitespace' => [['a' => [1, 2], 'b' => null], '{"a":[1,2],"b":null}'];
        yield 'members sorted by name' => [['b' => 1, 'a' => 2, 'c' => 3], '{"a":2,"b":1,"c":3}'];
        yield 'a prefix sorts before its extension' => [['ab' => 1, 'a' => 2, 'abc' => 3, 'aa' => 4], '{"a":2,"aa":4,"ab":1,"abc":3}'];
        yield 'nested objects are sorted too' => [['z' => ['y' => 1, 'x' => 2], 'a' => 0], '{"a":0,"z":{"x":2,"y":1}}'];
        yield 'quote and backslash' => ['say "hi" \\ bye', '"say \\"hi\\" \\\\ bye"'];
        yield 'named controls' => ["\x08\t\n\x0c\r", '"\\b\\t\\n\\f\\r"'];
        yield 'other controls use lowercase \\u00xx' => ["\x00\x1f\x0b", '"\\u0000\\u001f\\u000b"'];
        yield 'slash is not escaped' => ['a/b', '"a/b"'];
        yield 'DEL and non-ASCII are written as is' => ["\x7f é €", "\"\x7f é €\""];
        yield 'U+2028 is not escaped' => ["a\u{2028}b", "\"a\u{2028}b\""];
        yield 'astral characters are written as is' => ["\u{1F600}", "\"\u{1F600}\""];
    }

    #[DataProvider('encodings')]
    public function testEncodes(mixed $value, string $expected): void
    {
        self::assertSame($expected, Jcs::encode($value));
    }

    /**
     * RFC 8785 section 3.2.3: member names sort by UTF-16 code units, so U+FB33 (one unit, 0xFB33)
     * sorts after U+1F600 (the surrogate pair 0xD83D 0xDE00), which a code-point sort would reverse.
     */
    public function testSortsNamesByUtf16CodeUnitsNotCodePoints(): void
    {
        $names = ["\u{20AC}", "\r", "\u{FB33}", "\u{1F600}", "\u{80}", "\u{F6}", '1'];
        $object = [];
        foreach ($names as $name) {
            $object[$name] = 0;
        }
        $expected = ["\r", '1', "\u{80}", "\u{F6}", "\u{20AC}", "\u{1F600}", "\u{FB33}"];
        $encoded = Jcs::encode($object);
        $decoded = json_decode($encoded, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);
        self::assertSame($expected, array_map(strval(...), array_keys($decoded)));
        self::assertSame(
            '{"\\r":0,"1":0,"' . "\u{80}" . '":0,"' . "\u{F6}" . '":0,"' . "\u{20AC}" . '":0,"' . "\u{1F600}" . '":0,"' . "\u{FB33}" . '":0}',
            $encoded,
        );
    }

    public function testNumericLookingNamesStayNames(): void
    {
        // PHP turns the key "10" into the int 10; it must still be written, and sorted, as the text "10".
        self::assertSame('{"1":"a","10":"b","2":"c"}', Jcs::encode(['2' => 'c', '10' => 'b', '1' => 'a']));
    }

    public function testWritesAnObjectAsAnObjectEvenWhenItsKeysLookLikeAList(): void
    {
        self::assertSame('{"1":1}', Jcs::encode([1 => 1]));
    }

    public function testIsStableAcrossInsertionOrder(): void
    {
        self::assertSame(
            Jcs::encode(['x' => ['b' => 1, 'a' => 2], 'a' => 1]),
            Jcs::encode(['a' => 1, 'x' => ['a' => 2, 'b' => 1]]),
        );
    }

    /**
     * @return iterable<string, array{mixed}>
     */
    public static function refused(): iterable
    {
        yield 'a float' => [1.5];
        yield 'an integral float' => [2.0];
        yield '2^53' => [9007199254740992];
        yield 'minus 2^53' => [-9007199254740992];
        yield 'a big integer' => [BigInteger::of('9007199254740993')];
        yield 'a resource-like object' => [new \ArrayObject()];
        yield 'invalid UTF-8' => ["\xff"];
        yield 'invalid UTF-8 in a name' => [["\xc3" => 1]];
    }

    #[DataProvider('refused')]
    public function testRefusesWhatItCannotWriteExactly(mixed $value): void
    {
        $this->expectException(InvalidArgumentException::class);
        Jcs::encode($value);
    }
}
