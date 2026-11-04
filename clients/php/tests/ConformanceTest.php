<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use JsonException;
use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\CatalogLoader;
use OpenAdviser\AiCatalog\Exception\AiCatalogException;
use OpenAdviser\AiCatalog\Exception\UsageIncompleteException;
use OpenAdviser\AiCatalog\Pricing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Throwable;

/**
 * Runs every conformance vector of `conformance/vectors/*.json` through the public API only.
 *
 * - Fixtures are read as bytes and handed to the loader untouched: the fixture's sha256 is part of
 *   every basis, so nothing may re-serialize them.
 * - A vector passes only when every figure, every basis byte, the digest and the error code (with
 *   `missing`) are exactly the expected ones. An extra or different error is a failure.
 * - There is no skip. A vector of a kind this runner does not know fails.
 *
 * The directory is found from the monorepo layout, `clients/php/tests` -> `conformance`. The mirror
 * `openadviser/ai-catalog-php` excludes this file (`export-ignore`), so it never runs there.
 */
final class ConformanceTest extends TestCase
{
    private const string ROOT = __DIR__ . '/../../../conformance';

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function vectors(): iterable
    {
        $files = glob(self::ROOT . '/vectors/*.json');
        if ($files === false || $files === []) {
            throw new \RuntimeException('no conformance vectors found under ' . self::ROOT . '/vectors');
        }
        sort($files);
        $seen = [];
        foreach ($files as $file) {
            $document = self::json((string) file_get_contents($file));
            $vectors = $document['vectors'] ?? null;
            if (!is_array($vectors) || $vectors === []) {
                throw new \RuntimeException(basename($file) . ' holds no vectors');
            }
            foreach ($vectors as $vector) {
                if (!is_array($vector) || !isset($vector['id']) || !is_string($vector['id'])) {
                    throw new \RuntimeException(basename($file) . ' holds a vector without an id');
                }
                $id = $vector['id'];
                if (isset($seen[$id])) {
                    throw new \RuntimeException('duplicate vector id ' . $id);
                }
                $seen[$id] = true;
                /** @var array<string, mixed> $vector */
                yield $id => [$vector];
            }
        }
    }

    /**
     * @param array<string, mixed> $vector
     */
    #[DataProvider('vectors')]
    public function testVector(array $vector): void
    {
        $kind = $vector['kind'] ?? null;
        match ($kind) {
            'load' => $this->runLoad($vector),
            'load-sequence' => $this->runLoadSequence($vector),
            'price' => $this->runPrice($vector),
            'priceFromBasis' => $this->runPriceFromBasis($vector),
            'convert' => $this->runConvert($vector),
            default => self::fail('unknown vector kind ' . var_export($kind, true)),
        };
    }

    /**
     * The runner's own guard: the number of vectors it runs is the number the files hold.
     */
    public function testEveryVectorIsRun(): void
    {
        $files = glob(self::ROOT . '/vectors/*.json');
        self::assertNotFalse($files);
        $expected = 0;
        foreach ($files as $file) {
            $document = self::json((string) file_get_contents($file));
            self::assertIsArray($document['vectors']);
            $expected += count($document['vectors']);
        }
        $provided = iterator_count(self::vectors());
        self::assertSame($expected, $provided);
        self::assertGreaterThanOrEqual(151, $provided, 'the vector set shrank');
    }

    /** @param array<string, mixed> $vector */
    private function runLoad(array $vector): void
    {
        $catalog = self::member($vector, 'catalog');
        $bytes = $this->fixture(self::string($catalog, 'fixture'));
        $expectedSha = isset($vector['expectedSha256']) && is_string($vector['expectedSha256']) ? $vector['expectedSha256'] : null;

        try {
            Catalog::load($bytes, $expectedSha);
        } catch (AiCatalogException $e) {
            $this->assertRefusal($vector, $e);

            return;
        }
        self::assertSame(['loads' => true], $vector['expected'] ?? null, 'the catalog loaded but the vector expects a refusal');
    }

    /**
     * One new loader for the vector, then each step in order: the outcome of the load, and (when the step
     * says so) the sha256 of the last good catalog.
     *
     * @param array<string, mixed> $vector
     */
    private function runLoadSequence(array $vector): void
    {
        $steps = $vector['steps'] ?? null;
        self::assertIsArray($steps);
        self::assertNotSame([], $steps);
        $loader = new CatalogLoader();
        foreach (array_values($steps) as $index => $step) {
            self::assertIsArray($step);
            /** @var array<string, mixed> $step */
            $label = 'step ' . ($index + 1);
            $bytes = $this->fixture(self::string(self::member($step, 'catalog'), 'fixture'));
            $expectedSha = isset($step['expectedSha256']) && is_string($step['expectedSha256']) ? $step['expectedSha256'] : null;

            try {
                $loader->load($bytes, $expectedSha);
                self::assertSame(['loads' => true], $step['expected'] ?? null, $label . ': the catalog loaded but the step expects a refusal');
            } catch (AiCatalogException $e) {
                self::assertArrayHasKey('expectedError', $step, $label . ': refused with ' . $e->getMessage() . ' but the step expects a result');
                self::assertSame(self::member($step, 'expectedError')['code'], $e->errorCode(), $label . ': ' . $e->getMessage());
            }

            if (isset($step['lastGood'])) {
                $named = self::string(self::member($step, 'lastGood'), 'fixture');
                self::assertSame(hash('sha256', $this->fixture($named)), $loader->lastGood()?->sha256, $label . ': the last good catalog is not ' . $named);
            }
        }
    }

    /** @param array<string, mixed> $vector */
    private function runPrice(array $vector): void
    {
        $fixture = self::string(self::member($vector, 'catalog'), 'fixture');
        $catalog = Catalog::load($this->fixture($fixture)); // always loads; a failure here is the runner's
        // The request goes in as decoded, whatever it is: API-1 vectors send null, a list, wrong types.
        try {
            $price = $catalog->price($vector['request'] ?? null);
        } catch (AiCatalogException $e) {
            $this->assertRefusal($vector, $e);

            return;
        }

        $expected = self::member($vector, 'expected');
        self::assertArrayNotHasKey('expectedError', $vector, 'a price was returned but the vector expects a refusal');
        self::assertSame($expected['provider'], $price->provider);
        self::assertSame($expected['modelId'], $price->modelId);
        self::assertSame($expected['tier'], $price->tier);
        self::assertSame($expected['currency'], $price->currency);
        self::assertSame($expected['schedule'], $price->schedule);
        self::assertSame($expected['exact'], $price->exact);
        self::assertSame($expected['estimate'], $price->estimate);
        self::assertSame($expected['booked'], $price->booked);
        self::assertSame($expected['basis'], $price->basis, 'the basis must match byte for byte');
        self::assertSame($expected['basisSha256'], $price->basisSha256);
        self::assertSame(hash('sha256', $price->basis), $price->basisSha256);
    }

    /** @param array<string, mixed> $vector */
    private function runPriceFromBasis(array $vector): void
    {
        $r = self::member($vector, 'request');

        try {
            $result = Pricing::priceFromBasis(isset($r['basisFixture']) ? $this->fixture(self::string($r, 'basisFixture')) : self::string($r, 'basis'), self::string($r, 'basisSha256'), $r['usage'] ?? null, $r['conditionInputs'] ?? null);
        } catch (AiCatalogException $e) {
            $this->assertRefusal($vector, $e);

            return;
        }

        self::assertArrayNotHasKey('expectedError', $vector, 'a price was returned but the vector expects a refusal');
        $expected = self::member($vector, 'expected');
        self::assertSame($expected['currency'], $result->currency);
        self::assertSame($expected['schedule'], $result->schedule);
        self::assertSame($expected['exact'], $result->exact);
        self::assertSame($expected['estimate'], $result->estimate);
        self::assertSame($expected['booked'], $result->booked);
    }

    /** @param array<string, mixed> $vector */
    private function runConvert(array $vector): void
    {
        $r = self::member($vector, 'request');
        $rate = self::member($r, 'rate');
        $to = self::member($r, 'to');

        try {
            $amount = Pricing::convertRate($rate['unit'] ?? null, $rate['per'] ?? null, $rate['amount'] ?? null, $to['unit'] ?? null, $to['per'] ?? null, $to['scale'] ?? null);
        } catch (AiCatalogException $e) {
            $this->assertRefusal($vector, $e);

            return;
        }

        self::assertArrayNotHasKey('expectedError', $vector, 'an amount was returned but the vector expects a refusal');
        self::assertSame(self::member($vector, 'expected')['amount'], $amount);
    }

    /**
     * The vector must expect exactly this refusal: its code, and `missing` when it states one.
     *
     * @param array<string, mixed> $vector
     */
    private function assertRefusal(array $vector, AiCatalogException $e): void
    {
        self::assertArrayHasKey('expectedError', $vector, 'refused with ' . $e->getMessage() . ' but the vector expects a result');
        $expected = self::member($vector, 'expectedError');
        self::assertSame($expected['code'], $e->errorCode(), $e->getMessage());
        if (array_key_exists('missing', $expected)) {
            self::assertInstanceOf(UsageIncompleteException::class, $e);
            self::assertSame($expected['missing'], $e->missing);
        } else {
            self::assertNotInstanceOf(UsageIncompleteException::class, $e);
        }
    }

    private function fixture(string $name): string
    {
        $path = self::ROOT . '/fixtures/' . $name;
        $bytes = file_get_contents($path);
        self::assertNotFalse($bytes, 'cannot read fixture ' . $path);

        return $bytes;
    }

    /**
     * @return array<string, mixed>
     */
    private static function json(string $text): array
    {
        try {
            $value = json_decode($text, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (JsonException $e) {
            throw new \RuntimeException($e->getMessage(), 0, $e);
        }
        if (!is_array($value)) {
            throw new \RuntimeException('expected a JSON object');
        }
        /** @var array<string, mixed> $value */
        return $value;
    }

    /**
     * @param array<string, mixed> $from
     *
     * @return array<string, mixed>
     */
    private static function member(array $from, string $name): array
    {
        $value = $from[$name] ?? null;
        if (!is_array($value)) {
            throw new \RuntimeException('expected an object at "' . $name . '"');
        }
        /** @var array<string, mixed> $value */
        return $value;
    }

    /**
     * @param array<string, mixed> $from
     */
    private static function string(array $from, string $name): string
    {
        $value = $from[$name] ?? null;
        if (!is_string($value)) {
            throw new \RuntimeException('expected a string at "' . $name . '"');
        }

        return $value;
    }
}
