<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\Effort;
use OpenAdviser\AiCatalog\Exception\LoadException;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Exception\SourceException;
use OpenAdviser\AiCatalog\Exception\UsageIncompleteException;
use OpenAdviser\AiCatalog\PriceRequest;
use OpenAdviser\AiCatalog\Pricing;
use OpenAdviser\AiCatalog\UsageReport;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;
use Psr\Clock\ClockInterface;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamInterface;

#[CoversClass(Catalog::class)]
#[CoversClass(PriceRequest::class)]
final class CatalogTest extends TestCase
{
    private const string CONFORMANCE = __DIR__ . '/../../../conformance';

    public function testTheRealCatalogLoads(): void
    {
        // VAL-7: data/catalog.json MUST load, with the digest published beside it.
        $dir = __DIR__ . '/../../../data';
        $digest = explode(' ', (string) file_get_contents($dir . '/catalog.json.sha256'))[0];
        $catalog = Catalog::loadFile($dir . '/catalog.json', $digest);
        self::assertSame($digest, $catalog->sha256);
        self::assertSame('1.0.0', $catalog->schemaVersion);
        self::assertNotSame([], $catalog->providers());
        foreach ($catalog->providers() as $provider) {
            self::assertNotSame([], $catalog->models($provider));
        }
    }

    public function testReadsModelsAliasesAndEffort(): void
    {
        $catalog = Catalog::load((string) file_get_contents(self::CONFORMANCE . '/fixtures/text.json'));
        self::assertSame(['anthropic'], $catalog->providers());
        $ids = array_map(static fn($m): string => $m->id, $catalog->models('anthropic'));
        self::assertContains('vector-text', $ids);

        // An alias resolves to its model, whatever its status; an exact id wins over an alias.
        self::assertSame('vector-text', $catalog->model('anthropic', 'vector-text-latest')->id);
        self::assertSame('vector-text', $catalog->model('anthropic', 'vector-text-2026')->id);
        self::assertSame('vector-mini', $catalog->model('anthropic', 'vector-mini')->id);
        self::assertSame(['anthropic:standard'], $catalog->model('anthropic', 'vector-text')->tiers);

        $this->assertRefusal('unknown-provider', fn() => $catalog->models('nobody'));
        $this->assertRefusal('unknown-model', fn() => $catalog->model('anthropic', 'nope'));
        $this->assertRefusal('unknown-model', fn() => $catalog->effort('anthropic', 'nope'));
    }

    public function testEffortLevelsAndDefault(): void
    {
        $effort = [
            'levels' => ['low', 'medium', 'high'],
            'default' => 'medium',
            'provenance' => CatalogFactory::provenance(),
        ];
        $json = CatalogFactory::json([CatalogFactory::rate('input', '1')], null, '2026.11.04.1', ['effort' => $effort]);
        $catalog = Catalog::load($json);
        $read = $catalog->effort('openai', 'test-alias');
        self::assertInstanceOf(Effort::class, $read);
        self::assertSame(['low', 'medium', 'high'], $read->levels);
        self::assertSame('medium', $read->default);

        $none = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        self::assertNull($none->effort('openai', 'test-model'));
    }

    public function testExpectedDigestIsCheckedBeforeParsing(): void
    {
        // Not JSON at all: the digest mismatch must be what is reported.
        try {
            Catalog::load('not json', str_repeat('0', 64));
            self::fail('accepted');
        } catch (LoadException $e) {
            self::assertSame('hash-mismatch', $e->errorCode());
        }
        try {
            Catalog::load('not json');
            self::fail('accepted');
        } catch (LoadException $e) {
            self::assertSame('invalid-json', $e->errorCode());
        }
        $bytes = CatalogFactory::json([CatalogFactory::rate('input', '1')]);
        self::assertSame(hash('sha256', $bytes), Catalog::load($bytes, strtoupper(hash('sha256', $bytes)))->sha256);
    }

    public function testLoadFileAndLoadUrl(): void
    {
        $bytes = CatalogFactory::json([CatalogFactory::rate('input', '1')]);
        $path = tempnam(sys_get_temp_dir(), 'catalog');
        self::assertNotFalse($path);
        try {
            file_put_contents($path, $bytes);
            self::assertSame(hash('sha256', $bytes), Catalog::loadFile($path)->sha256);
        } finally {
            unlink($path);
        }
        try {
            Catalog::loadFile($path . '.missing');
            self::fail('read a missing file');
        } catch (SourceException $e) {
            self::assertStringContainsString('cannot read', $e->getMessage());
        }

        $catalog = Catalog::loadUrl($this->client(200, $bytes), $this->requests(), 'https://example.com/catalog.json', hash('sha256', $bytes));
        self::assertSame(hash('sha256', $bytes), $catalog->sha256);

        $this->expectException(SourceException::class);
        Catalog::loadUrl($this->client(404, 'nope'), $this->requests(), 'https://example.com/catalog.json');
    }

    public function testLoadUrlReportsAFailedRequestAndRejectsABadBody(): void
    {
        $failing = self::createStub(ClientInterface::class);
        $failing->method('sendRequest')->willThrowException(new class ('down') extends \RuntimeException implements ClientExceptionInterface {});
        try {
            Catalog::loadUrl($failing, $this->requests(), 'https://example.com/catalog.json');
            self::fail('fetched');
        } catch (SourceException $e) {
            self::assertStringContainsString('down', $e->getMessage());
        }

        $this->expectException(LoadException::class);
        Catalog::loadUrl($this->client(200, '{"a":1,"a":2}'), $this->requests(), 'https://example.com/catalog.json');
    }

    public function testTiesBetweenSchedulesGoToTheLowestInterval(): void
    {
        // COND-7: when the input is unknown and two schedules cost the same, the lowest interval wins.
        $rates = [];
        foreach ([['lte' => 100], ['gt' => 100]] as $bounds) {
            $rates[] = CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => $bounds]]);
            $rates[] = CatalogFactory::rate('output', '2', 1000000, ['condition' => ['inputTokens' => $bounds]]);
        }
        $catalog = Catalog::load(CatalogFactory::json($rates, ['inputTokens' => ['input']]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 50, 'output' => 5]];
        $request = new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked', ['inputTokens' => 'unknown']);
        $price = $catalog->price($request);
        self::assertSame(0, $price->schedule);

        // The basis carries both schedules, and replaying with the actual usage picks the actual one.
        $high = Pricing::priceFromBasis($price->basis, $price->basisSha256, ['completeness' => 'complete', 'quantities' => ['input' => 500, 'output' => 5]]);
        self::assertSame(1, $high->schedule);
        $low = Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage);
        self::assertSame(0, $low->schedule);
        self::assertSame($price->exact, $low->exact);
    }

    public function testAFullyDecodedConditionalReservationRequestPrices(): void
    {
        // json_decode with objects makes conditionInputs a stdClass; that is the same request.
        $rates = [];
        foreach ([['lte' => 100], ['gt' => 100]] as $bounds) {
            $rates[] = CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => $bounds]]);
        }
        $catalog = Catalog::load(CatalogFactory::json($rates, ['inputTokens' => ['input']]));
        $body = '{"provider":"openai","modelId":"test-model","tier":"openai:standard","at":"2026-11-04T12:00:00Z",'
            . '"settlement":"booked","conditionInputs":{"inputTokens":"unknown"},'
            . '"usage":{"completeness":"complete","quantities":{"input":50}}}';
        $asObject = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
        $asArray = json_decode($body, true, 512, JSON_THROW_ON_ERROR);

        $fromObject = $catalog->price($asObject);
        self::assertSame($catalog->price($asArray)->basisSha256, $fromObject->basisSha256);
        self::assertSame(0, $fromObject->schedule);

        // And it still refuses what is not exactly {"inputTokens": "unknown"}.
        foreach (['{"inputTokens":"known"}', '{"inputTokens":"unknown","x":1}', '{}', '[]', '"unknown"', '5'] as $bad) {
            $request = json_decode(str_replace('{"inputTokens":"unknown"}', $bad, $body), false, 512, JSON_THROW_ON_ERROR);
            $this->assertRefusal('invalid-request', fn() => $catalog->price($request));
        }
        $replay = Pricing::priceFromBasis($fromObject->basis, $fromObject->basisSha256, $asObject->usage, $asObject->conditionInputs);
        self::assertSame($fromObject->exact, $replay->exact);
    }

    public function testAnEmptyArrayOfQuantitiesDoesNotPriceAnOfferingThatNeedsNone(): void
    {
        // An offering whose only entry is not per call requires no quantity, so an empty report prices
        // to zero; but quantities: [] is not an object and must be refused rather than read as {}.
        $rate = [
            'component' => 'cache_storage',
            'disposition' => 'priced',
            'unit' => 'token-hour',
            'per' => 1000000,
            'amount' => '1',
            'currency' => 'USD',
            'provenance' => CatalogFactory::provenance(true),
        ];
        $catalog = Catalog::load(CatalogFactory::json([$rate], null));
        $request = static fn(string $quantities): object => (object) [
            ...['provider' => 'openai', 'modelId' => 'test-model', 'tier' => 'openai:standard', 'at' => '2026-11-04T12:00:00Z', 'settlement' => 'booked'],
            'usage' => json_decode('{"completeness":"complete","quantities":' . $quantities . '}', false, 512, JSON_THROW_ON_ERROR),
        ];
        $this->assertRefusal('invalid-usage', fn() => $catalog->price($request('[]')));
        self::assertSame('0/1', $catalog->price($request('{}'))->exact);
    }

    public function testQuantitiesNearTwoToThe53StayExact(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 9007199254740991]];
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'booked'));
        self::assertSame('9007199254740991/1000000', $price->exact);
        self::assertSame('9007199254.74', $price->estimate);
    }

    public function testTwelveFractionalDigitsAreExactAndNothingIsRoundedBeforeTheTotal(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([
            CatalogFactory::rate('input', '0.000000000001', 1),
            CatalogFactory::rate('output', '0.000000000001', 1),
        ]));
        $request = static fn(int $in, int $out): PriceRequest => new PriceRequest(
            'openai',
            'test-model',
            'openai:standard',
            '2026-11-04T12:00:00Z',
            ['completeness' => 'complete', 'quantities' => ['input' => $in, 'output' => $out]],
            'estimate',
        );
        $one = $catalog->price($request(1, 0));
        self::assertSame('1/1000000000000', $one->exact);
        self::assertSame('0.00', $one->estimate);
        self::assertSame('0.01', $one->booked);

        // Two halves of a cent: 0.005 + 0.005 rounds once, to 0.01, not 0.00 + 0.00.
        $halves = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '5', 1000), CatalogFactory::rate('output', '5', 1000)]));
        $price = $halves->price($request(1, 1));
        self::assertSame('1/100', $price->exact);
        self::assertSame('0.01', $price->estimate);
    }

    public function testAnHalfCentRoundsUp(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '5', 1000)]));
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', ['completeness' => 'complete', 'quantities' => ['input' => 1]], 'booked'));
        self::assertSame('1/200', $price->exact);
        self::assertSame('0.01', $price->estimate);
    }

    public function testRefusalsFollowTheOrderOfPrice2(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $make = static fn(
            string $provider = 'openai',
            string $modelId = 'test-model',
            string $tier = 'openai:standard',
            string $at = '2026-11-04T12:00:00Z',
            array $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1]],
            string $settlement = 'booked',
            ?array $conditionInputs = null,
        ): PriceRequest => new PriceRequest($provider, $modelId, $tier, $at, $usage, $settlement, $conditionInputs);
        // Step 1 comes before everything: a bad settlement beats a bad instant, a bad provider and bad usage.
        $this->assertRefusal('invalid-request', fn() => $catalog->price($make(settlement: 'x', at: 'x', provider: 'x', usage: ['x'])));
        $this->assertRefusal('invalid-request', fn() => $catalog->price($make(conditionInputs: ['inputTokens' => 'known'])));
        $this->assertRefusal('invalid-request', fn() => $catalog->price($make(conditionInputs: ['inputTokens' => 'unknown', 'x' => 1])));
        $this->assertRefusal('invalid-instant', fn() => $catalog->price($make(at: '2026-11-04T12:00:00.1234Z', provider: 'x')));
        // Step 2 comes before the usage shape.
        $this->assertRefusal('unknown-provider', fn() => $catalog->price($make(provider: 'x', usage: ['x'])));
        $this->assertRefusal('unknown-model', fn() => $catalog->price($make(modelId: 'x', usage: ['x'])));
        $this->assertRefusal('unknown-offering', fn() => $catalog->price($make(tier: 'openai:batch', usage: ['x'])));
        // Step 3 comes before completeness.
        $this->assertRefusal('invalid-usage', fn() => $catalog->price($make(usage: ['completeness' => 'partial', 'quantities' => ['input' => -1]])));
        $this->assertRefusal('quantity-out-of-range', fn() => $catalog->price($make(usage: ['completeness' => 'partial', 'quantities' => ['input' => 9007199254740992]])));
        // Step 5 comes before COMP-3.
        $this->assertRefusal('usage-incomplete', fn() => $catalog->price($make(usage: ['completeness' => 'complete', 'quantities' => ['web_search' => 1]])));
        $this->assertRefusal('component-not-offered', fn() => $catalog->price($make(usage: ['completeness' => 'complete', 'quantities' => ['input' => 1, 'web_search' => 1]])));
        // A zero quantity for a component the offering does not list costs nothing.
        self::assertSame('1/1000000', $catalog->price($make(usage: ['completeness' => 'complete', 'quantities' => ['input' => 1, 'web_search' => 0]]))->exact);
    }

    public function testAnArgumentOfTheWrongTypeIsASpecificationRefusalNotALanguageError(): void
    {
        // API-1: every argument error of a public operation is an AiCatalogException.
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $usage = ['completeness' => 'complete', 'quantities' => ['input' => 1]];
        $ok = ['provider' => 'openai', 'modelId' => 'test-model', 'tier' => 'openai:standard', 'at' => '2026-11-04T12:00:00Z', 'usage' => $usage, 'settlement' => 'booked'];

        self::assertSame('1/1000000', $catalog->price($ok)->exact, 'a decoded request object prices');
        self::assertSame('1/1000000', $catalog->price((object) $ok)->exact);

        foreach (['provider', 'modelId', 'tier'] as $member) {
            foreach ([5, null, ['openai'], true, 1.5] as $wrong) {
                $this->assertRefusal('invalid-request', fn() => $catalog->price([...$ok, $member => $wrong]));
            }
        }
        foreach ([5, null, ['2026-11-04T12:00:00Z'], true] as $wrong) {
            $this->assertRefusal('invalid-instant', fn() => $catalog->price([...$ok, 'at' => $wrong]));
        }
        foreach ([5, null, true, ['booked']] as $wrong) {
            $this->assertRefusal('invalid-request', fn() => $catalog->price([...$ok, 'settlement' => $wrong]));
        }
        foreach (['x', 5, null, true] as $wrong) {
            $this->assertRefusal('invalid-usage', fn() => $catalog->price([...$ok, 'usage' => $wrong]));
        }
        foreach ([null, 'request', 5, [1, 2], true] as $notAnObject) {
            $this->assertRefusal('invalid-request', fn() => $catalog->price($notAnObject));
        }
        $this->assertRefusal('invalid-request', fn() => $catalog->price([...$ok, 'surprise' => 1]));
    }

    public function testUsageIncompleteCarriesMissingSortedByCodePoint(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('output', '1'), CatalogFactory::rate('input_cached', '1'), CatalogFactory::rate('input', '1')]));
        try {
            $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', ['completeness' => 'partial', 'quantities' => ['input' => 1]], 'booked'));
            self::fail('priced');
        } catch (UsageIncompleteException $e) {
            self::assertSame('usage-incomplete', $e->errorCode());
            self::assertSame(['input_cached', 'output'], $e->missing);
        }
    }

    public function testEveryPriceVectorReplaysFromItsBasisToTheSameFigures(): void
    {
        // BASIS-3: for the same usage and conditionInputs, priceFromBasis equals the price that wrote the basis.
        $catalog = Catalog::load((string) file_get_contents(self::CONFORMANCE . '/fixtures/conditional.json'));
        foreach (['unknown' => ['inputTokens' => 'unknown'], 'known' => null] as $label => $conditionInputs) {
            foreach ([1000, 272000, 272001, 5_000_000] as $input) {
                $usage = ['completeness' => 'complete', 'quantities' => ['input' => $input, 'input_cached' => 0, 'cache_write_30m' => 0, 'cache_write_12h' => 0, 'output' => 123]];
                $price = $catalog->price(new PriceRequest('openai', 'vector-long', 'openai:standard', '2026-11-04T12:00:00Z', $usage, 'estimate', $conditionInputs));
                $replay = Pricing::priceFromBasis($price->basis, $price->basisSha256, $usage, $conditionInputs);
                self::assertSame([$price->currency, $price->schedule, $price->exact, $price->estimate, $price->booked], [$replay->currency, $replay->schedule, $replay->exact, $replay->estimate, $replay->booked], $label . ' ' . $input);
            }
        }
    }

    public function testPriceRequestNowUsesTheClockInUtcToTheMillisecond(): void
    {
        $clock = new class implements ClockInterface {
            public function now(): \DateTimeImmutable
            {
                return new \DateTimeImmutable('2026-11-04T13:30:15.123456+01:00');
            }
        };
        $request = PriceRequest::now($clock, 'openai', 'test-model', 'openai:standard', ['completeness' => 'complete', 'quantities' => []], 'booked');
        self::assertSame('2026-11-04T12:30:15.123Z', $request->at);
    }

    public function testTheBasisNamesTheRequestedAliasAndTheResolvedModel(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $price = $catalog->price(new PriceRequest('openai', 'test-alias', 'openai:standard', '2026-11-04T12:00:00Z', ['completeness' => 'complete', 'quantities' => ['input' => 1]], 'booked'));
        self::assertSame('test-model', $price->modelId);
        self::assertStringContainsString('"model":{"id":"test-model","requested":"test-alias"}', $price->basis);
        self::assertStringContainsString('"origin":{"kind":"catalog","sha256":"' . $catalog->sha256 . '","version":"2026.11.04.1"}', $price->basis);
    }

    public function testUsageReportObjectIsAccepted(): void
    {
        $catalog = Catalog::load(CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        $report = UsageReport::fromJson('{"completeness":"complete","quantities":{"input":1}}');
        $price = $catalog->price(new PriceRequest('openai', 'test-model', 'openai:standard', '2026-11-04T12:00:00Z', $report, 'booked'));
        self::assertSame('1/1000000', $price->exact);
    }

    private function assertRefusal(string $code, callable $call): void
    {
        try {
            $call();
        } catch (PriceException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());

            return;
        }
        self::fail('expected ' . $code);
    }

    private function client(int $status, string $body): ClientInterface
    {
        $stream = self::createStub(StreamInterface::class);
        $stream->method('__toString')->willReturn($body);
        $response = self::createStub(ResponseInterface::class);
        $response->method('getStatusCode')->willReturn($status);
        $response->method('getBody')->willReturn($stream);
        $client = self::createStub(ClientInterface::class);
        $client->method('sendRequest')->willReturn($response);

        return $client;
    }

    private function requests(): RequestFactoryInterface
    {
        $request = self::createStub(RequestInterface::class);
        $factory = self::createStub(RequestFactoryInterface::class);
        $factory->method('createRequest')->willReturn($request);

        return $factory;
    }
}
