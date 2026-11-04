<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use Brick\Math\BigInteger;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\UsageReport;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversClass(UsageReport::class)]
final class UsageReportTest extends TestCase
{
    public function testAcceptsAReportAndKeepsTheQuantitiesExact(): void
    {
        $report = UsageReport::fromArray(['completeness' => 'complete', 'quantities' => ['input' => 9007199254740991, 'output' => 0]]);
        self::assertSame('complete', $report->completeness);
        self::assertSame(['input' => 9007199254740991, 'output' => 0], $report->quantities);
    }

    public function testAcceptsAnEmptyQuantitiesObject(): void
    {
        self::assertSame([], UsageReport::fromArray(['completeness' => 'unknown', 'quantities' => []])->quantities);
        self::assertSame([], UsageReport::fromArray(['completeness' => 'unknown', 'quantities' => new \stdClass()])->quantities);
    }

    public function testAFloatIsNeverAQuantity(): void
    {
        // A plain json_decode reads 0.99999999999999999 as 1.0 and 1e-999 as 0.0: by the time a float
        // arrives, the text JSON-2 requires to be refused cannot be told from a legitimate integer.
        foreach ([3.0, 1.0, 0.0, -0.0, 0.99999999999999999, 1e-999, 1e3, 9007199254740992.0, 1e300] as $float) {
            $this->assertRefused('invalid-usage', ['completeness' => 'complete', 'quantities' => ['input' => $float]]);
        }
        $decoded = json_decode('{"completeness":"complete","quantities":{"input":0.99999999999999999,"output":1e-999}}', false, 512, JSON_THROW_ON_ERROR);
        $this->assertRefused('invalid-usage', $decoded);
        $this->assertRefused('invalid-json', null, '{"completeness":"complete","quantities":{"input":0.99999999999999999}}');
    }

    /**
     * @return iterable<string, array{string, mixed}>
     */
    public static function refusals(): iterable
    {
        $complete = static fn(mixed $quantities): array => ['completeness' => 'complete', 'quantities' => $quantities];
        yield 'not an object' => ['invalid-usage', 'a string'];
        yield 'a list' => ['invalid-usage', [1, 2]];
        yield 'an extra member' => ['invalid-usage', ['completeness' => 'complete', 'quantities' => [], 'note' => 'x']];
        yield 'a missing member' => ['invalid-usage', ['completeness' => 'complete']];
        yield 'completeness not a string' => ['invalid-usage', ['completeness' => 1, 'quantities' => []]];
        yield 'completeness not one of four' => ['invalid-usage', ['completeness' => 'estimated', 'quantities' => []]];
        yield 'completeness in the wrong case' => ['invalid-usage', ['completeness' => 'Complete', 'quantities' => []]];
        yield 'quantities a list' => ['invalid-usage', $complete([1, 2])];
        yield 'quantities a string' => ['invalid-usage', $complete('x')];
        yield 'unknown component' => ['invalid-usage', $complete(['inputs' => 1])];
        yield 'numeric key' => ['invalid-usage', $complete(['7' => 1])];
        yield 'negative' => ['invalid-usage', $complete(['input' => -1])];
        yield 'fraction' => ['invalid-usage', $complete(['input' => 1.5])];
        yield 'NaN' => ['invalid-usage', $complete(['input' => NAN])];
        yield 'infinity' => ['invalid-usage', $complete(['input' => INF])];
        yield 'numeric string' => ['invalid-usage', $complete(['input' => '5'])];
        yield 'boolean' => ['invalid-usage', $complete(['input' => true])];
        yield 'null' => ['invalid-usage', $complete(['input' => null])];
        yield 'nested array' => ['invalid-usage', $complete(['input' => [1]])];
        yield 'negative big integer' => ['invalid-usage', $complete(['input' => BigInteger::of('-9223372036854775809')])];
        yield 'exactly 2^53' => ['quantity-out-of-range', $complete(['input' => 9007199254740992])];
        yield 'beyond int' => ['quantity-out-of-range', $complete(['input' => BigInteger::of('9223372036854775808')])];
        yield 'shape before bound: out of range then fraction' => ['invalid-usage', $complete(['input' => 9007199254740992, 'output' => 0.5])];
        yield 'shape before bound: out of range then bad key' => ['invalid-usage', $complete(['input' => 9007199254740992, 'nope' => 1])];
    }

    #[DataProvider('refusals')]
    public function testRefuses(string $code, mixed $data): void
    {
        $this->assertRefused($code, $data);
    }

    public function testAJsonArrayIsNotAnObjectOfQuantities(): void
    {
        // quantities: {} is the empty object; quantities: [] is an array and USAGE-4 refuses it.
        self::assertSame([], UsageReport::fromJson('{"completeness":"unknown","quantities":{}}')->quantities);
        foreach (['[]', '[1]', '"x"', 'null', '5'] as $bad) {
            try {
                UsageReport::fromJson('{"completeness":"complete","quantities":' . $bad . '}');
                self::fail('accepted quantities ' . $bad);
            } catch (PriceException $e) {
                self::assertSame('invalid-usage', $e->errorCode(), $bad);
            }
        }
        // The same holds for a report decoded to objects; decoded to arrays, [] and {} cannot be told apart.
        $objects = json_decode('{"completeness":"complete","quantities":[]}', false, 512, JSON_THROW_ON_ERROR);
        $this->assertRefused('invalid-usage', $objects);
        self::assertSame([], UsageReport::fromArray(json_decode('{"completeness":"unknown","quantities":{}}', true, 512, JSON_THROW_ON_ERROR))->quantities);
    }

    public function testFromJsonHoldsTheTextToJson1AndJson2(): void
    {
        self::assertSame(['input' => 5], UsageReport::fromJson('{"completeness":"complete","quantities":{"input":5}}')->quantities);
        foreach ([
            '{"completeness":"complete","quantities":{"input":1e-999}}',
            '{"completeness":"complete","quantities":{"input":1.0}}',
            '{"completeness":"complete","quantities":{"input":1,"input":2}}',
            '{"completeness":"complete","quantities":',
        ] as $text) {
            try {
                UsageReport::fromJson($text);
                self::fail('accepted ' . $text);
            } catch (PriceException $e) {
                self::assertSame('invalid-json', $e->errorCode(), $text);
            }
        }
    }

    public function testFromJsonKeepsHugeLiteralsOutOfRangeNotInvalid(): void
    {
        $this->expectException(PriceException::class);
        $this->expectExceptionMessage('quantity-out-of-range');
        UsageReport::fromJson('{"completeness":"complete","quantities":{"input":99999999999999999999}}');
    }

    public function testFromJsonRefusesNegativeZero(): void
    {
        $this->assertRefused('invalid-usage', null, '{"completeness":"complete","quantities":{"input":-0}}');
    }

    private function assertRefused(string $code, mixed $data, ?string $json = null): void
    {
        try {
            $json === null ? UsageReport::fromArray($data) : UsageReport::fromJson($json);
        } catch (PriceException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());

            return;
        }
        self::fail('the report was accepted');
    }
}
