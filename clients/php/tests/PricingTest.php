<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use Closure;
use stdClass;
use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\Exception\BasisException;
use OpenAdviser\AiCatalog\Exception\ConversionException;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Jcs;
use OpenAdviser\AiCatalog\PriceRequest;
use OpenAdviser\AiCatalog\Pricing;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversClass(Pricing::class)]
final class PricingTest extends TestCase
{
    /**
     * @return iterable<string, array{string, int, string, string, int, int, string}>
     */
    public static function conversions(): iterable
    {
        yield 'identity' => ['token', 1000000, '2.50', 'token', 1000000, 6, '2.5'];
        yield 'per thousand to per million' => ['token', 1000, '0.0025', 'token', 1000000, 6, '2.5'];
        yield 'per million to per token' => ['token', 1000000, '2', 'token', 1, 6, '0.000002'];
        yield 'hour to millisecond' => ['hour', 1, '3.6', 'millisecond', 1000000, 6, '1'];
        yield 'zero stays zero' => ['minute', 1, '0.00', 'millisecond', 1, 0, '0'];
        yield 'twelve digits' => ['token', 1, '0.000000000001', 'token', 1, 12, '0.000000000001'];
        yield 'integer result needs no point' => ['second', 1, '1', 'millisecond', 1000, 0, '1'];
    }

    #[DataProvider('conversions')]
    public function testConvertsExactly(string $unit, int $per, string $amount, string $toUnit, int $toPer, int $scale, string $expected): void
    {
        self::assertSame($expected, Pricing::convertRate($unit, $per, $amount, $toUnit, $toPer, $scale));
    }

    /**
     * @return iterable<string, array{string, int, string, string, int, int, string}>
     */
    public static function refusals(): iterable
    {
        yield 'inexact at scale' => ['minute', 1, '0.10', 'millisecond', 1000000, 6, 'inexact-conversion'];
        yield 'one digit too few' => ['token', 1000000, '2.5', 'token', 1, 6, 'inexact-conversion'];
        yield 'target per not a power of ten' => ['token', 1, '1', 'token', 2, 6, 'invalid-per'];
        yield 'target per zero' => ['token', 1, '1', 'token', 0, 6, 'invalid-per'];
        yield 'target per 10^10' => ['token', 1, '1', 'token', 10000000000, 6, 'invalid-per'];
        yield 'dimension mismatch' => ['token', 1, '1', 'character', 1, 6, 'dimension-mismatch'];
        yield 'compound' => ['token-hour', 1, '1', 'token-hour', 1, 6, 'unsupported-unit'];
        yield 'compound to token is a dimension mismatch first' => ['token-hour', 1, '1', 'token', 1, 6, 'dimension-mismatch'];
        yield 'unknown unit' => ['fortnight', 1, '1', 'second', 1, 6, 'unknown-unit'];
        yield 'bad amount' => ['token', 1, '1.', 'token', 1, 6, 'invalid-amount'];
    }

    #[DataProvider('refusals')]
    public function testRefuses(string $unit, int $per, string $amount, string $toUnit, int $toPer, int $scale, string $code): void
    {
        try {
            Pricing::convertRate($unit, $per, $amount, $toUnit, $toPer, $scale);
            self::fail('converted');
        } catch (ConversionException $e) {
            self::assertSame($code, $e->errorCode());
        }
    }

    public function testEveryArgumentOfConvertRateIsJudgedByTypeToo(): void
    {
        $call = static fn(array $over = []): string => Pricing::convertRate(...array_replace(['minute', 1, '0.15', 'millisecond', 1000000, 6], $over));
        self::assertSame('2.5', $call());
        foreach ([[-1, 'invalid-request'], [13, 'invalid-request'], [null, 'invalid-request'], ['6', 'invalid-request'], [2.5, 'invalid-request'], [6.0, 'invalid-request'], [true, 'invalid-request']] as [$scale, $code]) {
            $this->assertConversionRefusal($code, fn() => $call([5 => $scale]));
        }
        foreach ([[0, 5], [0, null], [0, ['minute']], [3, 5], [3, 'furlong']] as [$index, $wrong]) {
            $this->assertConversionRefusal('unknown-unit', fn() => $call([$index => $wrong]));
        }
        foreach ([1e2, 5, null, '1e2', '-1', ''] as $wrong) {
            $this->assertConversionRefusal('invalid-amount', fn() => $call([2 => $wrong]));
        }
        foreach ([[1, '1'], [1, 3], [1, 1.0], [1, null], [4, '1000'], [4, 3], [4, 10000000000]] as [$index, $wrong]) {
            $this->assertConversionRefusal('invalid-per', fn() => $call([$index => $wrong]));
        }
    }

    private function assertConversionRefusal(string $code, \Closure $call): void
    {
        try {
            $call();
            self::fail('converted; expected ' . $code);
        } catch (ConversionException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());
        }
    }

    public function testAModelIdLongerThanTwoHundredCharactersIsNotInABasis(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1]];
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked'));
        foreach (['id', 'requested'] as $member) {
            foreach ([200 => true, 201 => false] as $length => $accepted) {
                $document = json_decode($price->basis, false, 512, JSON_THROW_ON_ERROR);
                self::assertInstanceOf(stdClass::class, $document);
                $document->model->{$member} = str_repeat('m', $length);
                $bytes = Jcs::encode($document);
                try {
                    Pricing::priceFromBasis($bytes, hash('sha256', $bytes), $usage);
                    self::assertTrue($accepted, $member . ' of ' . $length . ' characters was accepted');
                } catch (BasisException $e) {
                    self::assertFalse($accepted, $member . ' of ' . $length . ' characters was refused');
                    self::assertSame('invalid-basis', $e->errorCode());
                }
            }
        }
    }

    public function testScaleOutsideZeroToTwelveIsAnInvalidRequest(): void
    {
        foreach ([-1, 13, PHP_INT_MAX] as $scale) {
            try {
                Pricing::convertRate('token', 1, '1', 'token', 1, $scale);
                self::fail('converted at scale ' . $scale);
            } catch (ConversionException $e) {
                self::assertSame('invalid-request', $e->errorCode());
            }
        }
    }

    public function testAConversionNeverRoundsTripsThroughAFloat(): void
    {
        // 1/3 of a minute-millisecond: the exact result has no finite decimal expansion.
        $this->expectException(ConversionException::class);
        Pricing::convertRate('hour', 1, '1', 'millisecond', 1000000000, 12);
    }

    public function testPriceFromBasisChecksTheDigestBeforeAnythingElse(): void
    {
        foreach ([['{"basisVersion":2}', 'basis-hash-mismatch'], ['', 'basis-hash-mismatch']] as [$bytes, $code]) {
            try {
                Pricing::priceFromBasis($bytes, str_repeat('0', 64), ['completeness' => 'complete', 'quantities' => []]);
                self::fail('priced');
            } catch (BasisException $e) {
                self::assertSame($code, $e->errorCode());
            }
        }
    }

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function brokenBases(): iterable
    {
        yield 'not json' => ['not json', 'invalid-basis'];
        yield 'not an object' => ['[]', 'invalid-basis'];
        yield 'no version' => ['{}', 'invalid-basis'];
        yield 'version 2' => ['{"basisVersion":2}', 'unsupported-basis-version'];
        yield 'version as text' => ['{"basisVersion":"1"}', 'unsupported-basis-version'];
        yield 'version 1 and nothing else' => ['{"basisVersion":1}', 'invalid-basis'];
        yield 'duplicate member' => ['{"basisVersion":1,"basisVersion":1}', 'invalid-basis'];
        yield 'float literal' => ['{"basisVersion":1.0}', 'unsupported-basis-version'];
    }

    #[DataProvider('brokenBases')]
    public function testRefusesABasisThatIsNotOneAfterVerifyingItsDigest(string $bytes, string $code): void
    {
        // A float literal is not an integer literal: JSON-2 makes the text unreadable, so it is
        // invalid-basis rather than a version.
        $expected = $bytes === '{"basisVersion":1.0}' ? 'invalid-basis' : $code;
        try {
            Pricing::priceFromBasis($bytes, hash('sha256', $bytes), ['completeness' => 'complete', 'quantities' => []]);
            self::fail('priced');
        } catch (BasisException $e) {
            self::assertSame($expected, $e->errorCode());
        }
    }

    public function testConditionInputsOfAReplayAreChecked(): void
    {
        // The basis is checked first, so give it a valid one.
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1]];
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked'));

        $this->expectException(PriceException::class);
        $this->expectExceptionMessage('invalid-request');
        Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage, ['inputTokens' => 'known']);
    }

    /**
     * @return iterable<string, array{Closure}>
     */
    public static function basisEdits(): iterable
    {
        yield 'tier of another provider' => [static function (stdClass $b): void {
            $b->tier = 'anthropic:standard';
        }];
        yield 'exponent of another currency' => [static function (stdClass $b): void {
            $b->rounding->exponent = 3;
        }];
        yield 'factor that is not the unit\'s' => [static function (stdClass $b): void {
            $b->schedules[0]->components[0]->factor = 1000;
        }];
        yield 'amount not canonical' => [static function (stdClass $b): void {
            $b->schedules[0]->components[0]->amount = '1.0';
        }];
        yield 'window bound that is not a date' => [static function (stdClass $b): void {
            $b->schedules[0]->components[0]->validUntil = '2027-02-30T00:00:00Z';
        }];
        yield 'window that runs backwards' => [static function (stdClass $b): void {
            $b->schedules[0]->components[0]->validFrom = '2027-01-01T00:00:00Z';
            $b->schedules[0]->components[0]->validUntil = '2026-01-01T00:00:00Z';
        }];
        yield 'entries that share no instant' => [static function (stdClass $b): void {
            $b->schedules[0]->components[0]->validUntil = '2026-06-01T00:00:00Z';
            $b->schedules[0]->components[1]->validFrom = '2026-06-01T00:00:00Z';
        }];
        yield 'components out of order' => [static function (stdClass $b): void {
            $components = $b->schedules[0]->components;
            self::assertIsArray($components);
            $b->schedules[0]->components = array_reverse($components);
        }];
        yield 'a repeated component' => [static function (stdClass $b): void {
            $b->schedules[0]->components[1] = $b->schedules[0]->components[0];
        }];
        yield 'condition on a single schedule' => [static function (stdClass $b): void {
            $b->schedules[0]->condition = (object) ['inputTokens' => (object) ['lte' => 5]];
        }];
        yield 'conditionInputs on a single schedule' => [static function (stdClass $b): void {
            $b->conditionInputs = (object) ['inputTokens' => ['input']];
        }];
        yield 'an extra member' => [static function (stdClass $b): void {
            $b->note = 'x';
        }];
    }

    #[DataProvider('basisEdits')]
    public function testRefusesABasisThatPriceCouldNotHaveWritten(Closure $edit): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1'), CatalogFactory::rate('output', '2')]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1, 'output' => 1]];
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked'));
        self::assertSame('3/1000000', Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage)->exact);

        // Re-write it canonically with one edit, so that only BASIS-4 step 5 (or the schema) can object.
        $document = json_decode($price->basis, false, 512, JSON_THROW_ON_ERROR);
        self::assertInstanceOf(stdClass::class, $document);
        $edit($document);
        $bytes = Jcs::encode($document);
        try {
            Pricing::priceFromBasis($bytes, hash('sha256', $bytes), $usage);
            self::fail('priced from a basis price could not have written');
        } catch (BasisException $e) {
            self::assertSame('invalid-basis', $e->errorCode(), $e->getMessage());
        }
    }

    public function testEntriesWithOverlappingWindowsOfOneInstantAreAccepted(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([
            CatalogFactory::rate('input', '1', 1000000, ['validUntil' => '2027-01-01T00:00:00Z']),
            CatalogFactory::rate('output', '2', 1000000, ['validFrom' => '2026-06-01T00:00:00Z']),
        ]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1, 'output' => 1]];
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked'));
        self::assertSame('3/1000000', Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage)->exact);
    }
}
