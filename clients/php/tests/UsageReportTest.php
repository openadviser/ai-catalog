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

    public function testAWholeFloatIsJudgedByItsValue(): void
    {
        self::assertSame(['input' => 3], UsageReport::fromArray(['completeness' => 'complete', 'quantities' => ['input' => 3.0]])->quantities);
        $this->assertRefused('quantity-out-of-range', ['completeness' => 'complete', 'quantities' => ['input' => 9007199254740992.0]]);
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

    public function testFromJsonReadsNegativeZeroAsZero(): void
    {
        self::assertSame(['input' => 0], UsageReport::fromJson('{"completeness":"complete","quantities":{"input":-0}}')->quantities);
    }

    private function assertRefused(string $code, mixed $data): void
    {
        try {
            UsageReport::fromArray($data);
        } catch (PriceException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());

            return;
        }
        self::fail('the report was accepted');
    }
}
