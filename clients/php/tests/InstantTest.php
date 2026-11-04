<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use OpenAdviser\AiCatalog\Internal\Instant;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversClass(Instant::class)]
final class InstantTest extends TestCase
{
    public function testComputesMillisecondsSinceTheEpoch(): void
    {
        self::assertSame(0, Instant::parse('1970-01-01T00:00:00Z'));
        self::assertSame(86_400_000, Instant::parse('1970-01-02T00:00:00Z'));
        self::assertSame(1_793_793_600_000, Instant::parse('2026-11-04T12:00:00Z'));
        self::assertSame(951_782_400_000, Instant::parse('2000-02-29T00:00:00Z'));
        self::assertSame(253_402_300_799_000, Instant::parse('9999-12-31T23:59:59Z'));
    }

    public function testFractionsAreMillisecondsAndOnlyWhereAllowed(): void
    {
        self::assertSame(1, Instant::parse('1970-01-01T00:00:00.001Z', true));
        self::assertSame(100, Instant::parse('1970-01-01T00:00:00.1Z', true));
        self::assertSame(120, Instant::parse('1970-01-01T00:00:00.12Z', true));
        self::assertSame(999, Instant::parse('1970-01-01T00:00:00.999Z', true));
        self::assertSame(0, Instant::parse('1970-01-01T00:00:00Z', true));
        self::assertNull(Instant::parse('1970-01-01T00:00:00.001Z'));
        self::assertNull(Instant::parse('1970-01-01T00:00:00.0001Z', true));
        self::assertNull(Instant::parse('1970-01-01T00:00:00.Z', true));
    }

    public function testOrdersInstantsToTheMillisecond(): void
    {
        $before = Instant::parse('2026-12-31T23:59:59.999Z', true);
        $at = Instant::parse('2027-01-01T00:00:00.000Z', true);
        self::assertNotNull($before);
        self::assertNotNull($at);
        self::assertSame(1, $at - $before);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function invalid(): iterable
    {
        yield 'offset' => ['2026-11-04T12:00:00+01:00'];
        yield 'lowercase t' => ['2026-11-04t12:00:00Z'];
        yield 'lowercase z' => ['2026-11-04T12:00:00z'];
        yield 'no zone' => ['2026-11-04T12:00:00'];
        yield 'a date' => ['2026-11-04'];
        yield 'February 30th' => ['2026-02-30T00:00:00Z'];
        yield 'February 29th in a common year' => ['2027-02-29T00:00:00Z'];
        yield 'February 29th in 1900' => ['1900-02-29T00:00:00Z'];
        yield 'April 31st' => ['2026-04-31T00:00:00Z'];
        yield 'month 13' => ['2026-13-01T00:00:00Z'];
        yield 'month 0' => ['2026-00-01T00:00:00Z'];
        yield 'day 0' => ['2026-01-00T00:00:00Z'];
        yield 'hour 24' => ['2026-01-01T24:00:00Z'];
        yield 'minute 60' => ['2026-01-01T00:60:00Z'];
        yield 'a leap second' => ['2026-12-31T23:59:60Z'];
        yield 'before 1970' => ['1969-12-31T23:59:59Z'];
        yield 'trailing newline' => ["2026-11-04T12:00:00Z\n"];
        yield 'leading space' => [' 2026-11-04T12:00:00Z'];
        yield 'five-digit year' => ['12026-11-04T12:00:00Z'];
        yield 'empty' => [''];
    }

    #[DataProvider('invalid')]
    public function testRejects(string $text): void
    {
        self::assertNull(Instant::parse($text, true));
    }

    public function testDates(): void
    {
        self::assertTrue(Instant::isDate('2026-11-04'));
        self::assertTrue(Instant::isDate('2028-02-29'));
        self::assertTrue(Instant::isDate('1970-01-01'));
        self::assertFalse(Instant::isDate('2026-02-30'));
        self::assertFalse(Instant::isDate('2027-02-29'));
        self::assertFalse(Instant::isDate('1969-12-31'));
        self::assertFalse(Instant::isDate("2026-11-04\n"));
        self::assertFalse(Instant::isDate('2026-11-04T00:00:00Z'));
    }
}
