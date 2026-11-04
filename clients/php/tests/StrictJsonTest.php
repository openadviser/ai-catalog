<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\Internal\JsonFailure;
use OpenAdviser\AiCatalog\Internal\StrictJson;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use stdClass;

#[CoversClass(StrictJson::class)]
final class StrictJsonTest extends TestCase
{
    /**
     * @return iterable<string, array{string}>
     */
    public static function rejected(): iterable
    {
        yield 'duplicate member' => ['{"a":1,"a":2}'];
        yield 'duplicate member, same value' => ['{"a":1,"a":1}'];
        yield 'duplicate after unescaping' => ['{"a":1,"a":2}'];
        yield 'duplicate after unescaping a slash' => ['{"a/b":1,"a\/b":2}'];
        yield 'duplicate in a nested object' => ['{"x":[{"k":1,"k":2}]}'];
        yield 'duplicate empty names' => ['{"":1,"":2}'];
        yield 'fraction' => ['{"a":1.0}'];
        yield 'fraction that rounds to an integer' => ['{"a":0.99999999999999999}'];
        yield 'fraction that a double reads as 10^6' => ['{"a":1000000.00000000001}'];
        yield 'exponent' => ['{"a":1e3}'];
        yield 'negative exponent that a double reads as zero' => ['{"a":1e-999}'];
        yield 'capital exponent' => ['[1E2]'];
        yield 'leading zero' => ['[01]'];
        yield 'lone minus' => ['[-]'];
        yield 'plus sign' => ['[+1]'];
        yield 'bare point' => ['[.5]'];
        yield 'trailing comma in an array' => ['[1,]'];
        yield 'trailing comma in an object' => ['{"a":1,}'];
        yield 'single quotes' => ["{'a':1}"];
        yield 'comment' => ['[1] // c'];
        yield 'trailing text' => ['{} x'];
        yield 'empty text' => [''];
        yield 'unterminated string' => ['"abc'];
        yield 'raw control character in a string' => ["\"a\tb\""];
        yield 'invalid escape' => ['"\x"'];
        yield 'lone high surrogate' => ['"\ud800"'];
        yield 'lone low surrogate' => ['"\udc00"'];
        yield 'short unicode escape' => ['"\u12"'];
        yield 'invalid UTF-8' => ["\"\xff\""];
        yield 'byte order mark' => ["\xef\xbb\xbf{}"];
        yield 'NaN' => ['[NaN]'];
        yield 'nested 513 deep' => [str_repeat('[', 513) . '0' . str_repeat(']', 513)];
        yield 'objects nested 513 deep' => [str_repeat('{"a":', 513) . '0' . str_repeat('}', 513)];
    }

    #[DataProvider('rejected')]
    public function testRejects(string $text): void
    {
        $this->expectException(JsonFailure::class);
        StrictJson::decode($text);
    }

    public function testReadsADocumentNestedExactlyFiveHundredTwelveDeep(): void
    {
        $value = StrictJson::decode(str_repeat('[', 512) . '0' . str_repeat(']', 512));
        for ($depth = 0; $depth < 511; ++$depth) {
            self::assertIsArray($value);
            $value = $value[0];
        }
        self::assertSame([0], $value);
    }

    public function testDecodesObjectsAsStdClassAndKeepsEmptyObjectDistinctFromEmptyArray(): void
    {
        $value = StrictJson::decode(' { "o" : { } , "a" : [ ] , "s" : "x" , "t" : true , "n" : null , "i" : -5 } ');
        self::assertInstanceOf(stdClass::class, $value);
        self::assertEquals(new stdClass(), $value->o);
        self::assertSame([], $value->a);
        self::assertSame('x', $value->s);
        self::assertTrue($value->t);
        self::assertNull($value->n);
        self::assertSame(-5, $value->i);
    }

    public function testUnescapesStrings(): void
    {
        self::assertSame("a\"b\\c/d\x08\x0c\n\r\t\u{E9}\u{1F600}", StrictJson::decode('"a\"b\\\\c\/d\b\f\n\r\té😀"'));
    }

    public function testKeepsAnIntegerNearTheFloatLimitExact(): void
    {
        // 2^53 and 2^53 + 1 are told apart: no double was involved.
        $value = StrictJson::decode('[9007199254740992,9007199254740993,9223372036854775807]');
        self::assertSame([9007199254740992, 9007199254740993, 9223372036854775807], $value);
        $boundary = StrictJson::decode('[-9223372036854775808,9223372036854775808]');
        self::assertIsArray($boundary);
        self::assertContainsOnlyInstancesOf(BigInteger::class, $boundary);
    }

    public function testKeepsAnIntegerBeyondPhpIntExactAsBigInteger(): void
    {
        $value = StrictJson::decode('{"big":[1,{"n":9223372036854775808}],"neg":-9223372036854775809,"max":123456789012345678901234567890}');
        self::assertInstanceOf(stdClass::class, $value);
        self::assertIsArray($value->big);
        self::assertSame(1, $value->big[0]);
        self::assertInstanceOf(stdClass::class, $value->big[1]);
        self::assertInstanceOf(BigInteger::class, $value->big[1]->n);
        self::assertSame('9223372036854775808', (string) $value->big[1]->n);
        self::assertInstanceOf(BigInteger::class, $value->neg);
        self::assertSame('-9223372036854775809', (string) $value->neg);
        self::assertInstanceOf(BigInteger::class, $value->max);
        self::assertSame('123456789012345678901234567890', (string) $value->max);
    }

    public function testNegativeZeroIsTheIntegerZero(): void
    {
        // PHP reads -0 as the float -0.0. It must come back as an int.
        self::assertSame([0, 0], StrictJson::decode('[-0,0]'));
    }

    public function testNeverProducesAFloat(): void
    {
        $value = StrictJson::decode('{"a":[0,-0,1,9007199254740993,99999999999999999999],"b":{"c":-1}}');
        self::assertIsObject($value);
        array_walk_recursive($value, static function (mixed $leaf): void {
            self::assertFalse(is_float($leaf));
        });
        $json = json_encode($value);
        self::assertIsString($json);
        self::assertStringNotContainsString('.', $json);
    }

    public function testNumericAndEmptyMemberNames(): void
    {
        $value = StrictJson::decode('{"1":9223372036854775808,"":-0}');
        self::assertInstanceOf(stdClass::class, $value);
        self::assertInstanceOf(BigInteger::class, $value->{'1'});
        self::assertSame(0, $value->{''});
    }
}
