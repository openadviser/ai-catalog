<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use Closure;
use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\Exception\LoadException;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Load-time rules the conformance vectors pin with one example each, probed at their edges. Each case
 * changes one thing in a valid catalog and names the code of the most specific rule it breaks (VAL-4).
 */
#[CoversClass(Catalog::class)]
final class CatalogValidationTest extends TestCase
{
    /**
     * @return array<string, mixed>
     */
    private static function base(): array
    {
        $decoded = json_decode(CatalogFactory::json([
            CatalogFactory::rate('input', '1'),
            CatalogFactory::rate('output', '2'),
        ]), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);
        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /**
     * A closure that edits the first rate of the only offering.
     *
     * @param array<string, mixed> $set
     */
    private static function rate(array $set): Closure
    {
        return static function (array &$c) use ($set): void {
            $c['providers'][0]['models'][0]['offerings'][0]['rates'][0] = [...$c['providers'][0]['models'][0]['offerings'][0]['rates'][0], ...$set];
        };
    }

    /**
     * @return iterable<string, array{string, Closure}>
     */
    public static function breakages(): iterable
    {
        yield 'amount null' => ['invalid-amount', self::rate(['amount' => null])];
        yield 'amount array' => ['invalid-amount', self::rate(['amount' => ['1']])];
        yield 'amount integer' => ['invalid-amount', self::rate(['amount' => 1])];
        yield 'amount trailing newline' => ['invalid-amount', self::rate(['amount' => "1\n"])];
        yield 'amount trailing point' => ['invalid-amount', self::rate(['amount' => '1.'])];
        yield 'amount empty' => ['invalid-amount', self::rate(['amount' => ''])];
        yield 'amount plus sign' => ['invalid-amount', self::rate(['amount' => '+1'])];
        yield 'amount thirteen decimals' => ['invalid-amount', self::rate(['amount' => '0.0000000000001'])];
        yield 'per as text' => ['invalid-per', self::rate(['per' => '1000'])];
        yield 'per null' => ['invalid-per', self::rate(['per' => null])];
        yield 'per 10^10' => ['invalid-per', self::rate(['per' => 10000000000])];
        yield 'per negative' => ['invalid-per', self::rate(['per' => -1000])];
        yield 'currency lowercase' => ['unknown-currency', self::rate(['currency' => 'usd'])];
        yield 'currency unknown' => ['unknown-currency', self::rate(['currency' => 'JPY'])];
        yield 'unit uppercase' => ['unknown-unit', self::rate(['unit' => 'Token'])];
        yield 'unit of another dimension' => ['unit-mismatch', self::rate(['unit' => 'character'])];
        yield 'compound unit on a token component' => ['unit-mismatch', self::rate(['unit' => 'token-hour'])];
        yield 'priced storage has no unit' => ['unit-mismatch', self::rate(['component' => 'file_search_storage'])];
        yield 'component unknown' => ['unknown-component', self::rate(['component' => 'Input'])];
        yield 'disposition unknown' => ['invalid-structure', self::rate(['disposition' => 'free'])];
        yield 'unsupported with an amount' => ['invalid-structure', self::rate(['disposition' => 'unsupported', 'reason' => 'x'])];
        yield 'inapplicable without a reason' => ['invalid-structure', self::rate(['disposition' => 'inapplicable', 'unit' => null])];
        yield 'priced with a reason' => ['invalid-structure', self::rate(['reason' => 'x'])];
        yield 'priced without a unit' => ['invalid-structure', static function (array &$c): void {
            unset($c['providers'][0]['models'][0]['offerings'][0]['rates'][0]['unit']);
        }];
        yield 'unknown member' => ['invalid-structure', self::rate(['surprise' => 1])];
        yield 'unknown member at the root' => ['invalid-structure', static function (array &$c): void {
            $c['extra'] = true;
        }];
        yield 'provider unknown' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['id'] = 'mistral';
        }];
        yield 'model id with a space' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['id'] = 'test model';
        }];
        yield 'model status unknown' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['status'] = 'beta';
        }];
        yield 'deprecated without status provenance' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['status'] = 'deprecated';
        }];
        yield 'rates empty' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'][0]['rates'] = [];
        }];
        yield 'rate provenance without dateRule' => ['invalid-structure', static function (array &$c): void {
            unset($c['providers'][0]['models'][0]['offerings'][0]['rates'][0]['provenance']['dateRule']);
        }];
        yield 'provenance with location and derivation' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['provenance']['derivation'] = ['formula' => 'x', 'inputs' => []];
        }];
        yield 'provenance url not https' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['provenance']['url'] = 'http://example.com';
        }];
        yield 'evidence not a digest' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['provenance']['evidence'] = str_repeat('A', 64);
        }];
        yield 'schema 1.1.0' => ['unsupported-schema-version', static function (array &$c): void {
            $c['schemaVersion'] = '1.1.0';
        }];
        yield 'schema 2.0.0 beats a broken body' => ['unsupported-schema-version', static function (array &$c): void {
            $c = ['schemaVersion' => '2.0.0', 'anything' => 'else'];
        }];
        yield 'schema not semver' => ['unsupported-schema-version', static function (array &$c): void {
            $c['schemaVersion'] = 'one';
        }];
        yield 'schema 1.0.01' => ['unsupported-schema-version', static function (array &$c): void {
            $c['schemaVersion'] = '1.0.01';
        }];
        yield 'version on February 30th' => ['invalid-version', static function (array &$c): void {
            $c['version'] = '2026.02.30.1';
        }];
        yield 'version sequence zero' => ['invalid-version', static function (array &$c): void {
            $c['version'] = '2026.11.04.0';
        }];
        yield 'publishedAt with a fraction' => ['invalid-instant', static function (array &$c): void {
            $c['publishedAt'] = '2026-11-04T00:00:00.5Z';
        }];
        yield 'validFrom with an offset' => ['invalid-instant', self::rate(['validFrom' => '2026-11-04T00:00:00+00:00'])];
        yield 'retiresOn with a time' => ['invalid-instant', static function (array &$c): void {
            $c['providers'][0]['models'][0]['retiresOn'] = '2026-12-01T00:00:00Z';
            $c['providers'][0]['models'][0]['statusProvenance'] = $c['providers'][0]['models'][0]['provenance'];
        }];
        yield 'window of zero length' => ['invalid-window', self::rate(['validFrom' => '2026-11-04T00:00:00Z', 'validUntil' => '2026-11-04T00:00:00Z'])];
        yield 'active alias equal to its own model' => ['alias-collision', static function (array &$c): void {
            $c['providers'][0]['models'][0]['aliases'] = [['id' => 'test-model', 'status' => 'active']];
        }];
        yield 'alias twice in one model' => ['duplicate-alias', static function (array &$c): void {
            $c['providers'][0]['models'][0]['aliases'] = [['id' => 'a', 'status' => 'active'], ['id' => 'a', 'status' => 'retired']];
        }];
        yield 'tier of another provider' => ['tier-provider-mismatch', static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'][0]['tier'] = 'anthropic:standard';
        }];
        yield 'effort levels out of order' => ['invalid-effort', self::effort(['high', 'low'], 'high')];
        yield 'effort levels repeated' => ['invalid-effort', self::effort(['low', 'low'], 'low')];
        yield 'effort level unknown' => ['invalid-effort', self::effort(['low', 'extreme'], 'low')];
        yield 'effort levels empty' => ['invalid-effort', self::effort([], null)];
        yield 'effort default unknown' => ['invalid-effort', self::effort(['low', 'high'], 'ultra')];
        yield 'effort default missing' => ['invalid-structure', static function (array &$c): void {
            $c['providers'][0]['models'][0]['effort'] = ['levels' => ['low'], 'provenance' => CatalogFactory::provenance()];
        }];
        yield 'two currencies' => ['mixed-currencies', static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'][0]['rates'][1]['currency'] = 'EUR';
        }];
        yield 'only unsupported entries' => ['offering-without-price', static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'][0]['rates'] = [[
                'component' => 'input',
                'disposition' => 'unsupported',
                'reason' => 'x',
                'provenance' => CatalogFactory::provenance(true),
            ]];
        }];
        yield 'the same component twice without windows' => ['windows-overlap', static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'][0]['rates'][] = $c['providers'][0]['models'][0]['offerings'][0]['rates'][0];
        }];
        yield 'windows overlapping by a second' => ['windows-overlap', self::windows(
            ['validUntil' => '2026-06-01T00:00:01Z'],
            ['validFrom' => '2026-06-01T00:00:00Z'],
        )];
        yield 'an open window overlaps a later one' => ['windows-overlap', self::windows(
            ['validFrom' => '2026-01-01T00:00:00Z'],
            ['validFrom' => '2027-01-01T00:00:00Z'],
        )];
        yield 'an earlier open window overlaps' => ['windows-overlap', self::windows(
            ['validUntil' => '2027-01-01T00:00:00Z'],
            ['validUntil' => '2026-01-01T00:00:00Z'],
        )];
    }

    /**
     * @param list<string> $levels
     */
    private static function effort(array $levels, ?string $default): Closure
    {
        return static function (array &$c) use ($levels, $default): void {
            $c['providers'][0]['models'][0]['effort'] = ['levels' => $levels, 'default' => $default, 'provenance' => CatalogFactory::provenance()];
        };
    }

    /**
     * Two entries for `input` with the given window members; the second replaces the catalog's `input`.
     *
     * @param array<string, string> $first
     * @param array<string, string> $second
     */
    private static function windows(array $first, array $second): Closure
    {
        return static function (array &$c) use ($first, $second): void {
            $rates = &$c['providers'][0]['models'][0]['offerings'][0]['rates'];
            $input = $rates[0];
            $rates[0] = [...$input, ...$first];
            $rates[] = [...$input, ...$second];
        };
    }

    #[DataProvider('breakages')]
    public function testReportsTheMostSpecificRule(string $code, Closure $break): void
    {
        $catalog = self::base();
        $break($catalog);
        try {
            Catalog::load(json_encode($catalog, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        } catch (LoadException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());

            return;
        }
        self::fail('the catalog loaded; expected ' . $code);
    }

    /**
     * @return iterable<string, array{Closure}>
     */
    public static function accepted(): iterable
    {
        yield 'schema 1.0.7' => [static function (array &$c): void {
            $c['schemaVersion'] = '1.0.7';
        }];
        yield 'adjacent windows' => [self::windows(
            ['validUntil' => '2026-06-01T00:00:00Z'],
            ['validFrom' => '2026-06-01T00:00:00Z'],
        )];
        yield 'windows with a gap' => [self::windows(
            ['validUntil' => '2026-06-01T00:00:00Z'],
            ['validFrom' => '2026-07-01T00:00:00Z'],
        )];
        yield 'amounts in any NUM-1 form' => [self::rate(['amount' => '0.100000000000'])];
        yield 'a retired alias equal to a model id' => [static function (array &$c): void {
            $model = $c['providers'][0]['models'][0];
            $other = [...$model, 'id' => 'other', 'aliases' => []];
            $c['providers'][0]['models'][0]['aliases'] = [['id' => 'other', 'status' => 'retired']];
            $c['providers'][0]['models'][] = $other;
        }];
        yield 'a model with no offerings' => [static function (array &$c): void {
            $c['providers'][0]['models'][0]['offerings'] = [];
        }];
        yield 'effort with a null default' => [self::effort(['none', 'low', 'max'], null)];
        yield 'retiresOn with status provenance' => [static function (array &$c): void {
            $c['providers'][0]['models'][0]['retiresOn'] = '2027-01-31';
            $c['providers'][0]['models'][0]['statusProvenance'] = $c['providers'][0]['models'][0]['provenance'];
        }];
    }

    #[DataProvider('accepted')]
    public function testAcceptsWhatTheRulesAllow(Closure $change): void
    {
        $catalog = self::base();
        $change($catalog);
        $loaded = Catalog::load(json_encode($catalog, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        self::assertNotSame([], $loaded->providers());
    }

    public function testAnOffsetBeyondAnIntegerIsStillAnOffset(): void
    {
        // The schema leaves `offset` unbounded; a literal too large for an int must neither crash nor round.
        $json = str_replace('"offset":0', '"offset":123456789012345678901234567890', CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        self::assertNotSame($json, CatalogFactory::json([CatalogFactory::rate('input', '1')]));
        self::assertNotSame([], Catalog::load($json)->providers());
    }

    public function testAConditionBoundBeyondTheLimitIsStructure(): void
    {
        foreach (['9007199254740992', '123456789012345678901234567890', '-1'] as $bound) {
            $json = CatalogFactory::json([CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => ['lte' => 5]]])], ['inputTokens' => ['input']]);
            $json = str_replace('"lte":5', '"lte":' . $bound, $json);
            try {
                Catalog::load($json);
                self::fail('loaded ' . $bound);
            } catch (LoadException $e) {
                self::assertSame('invalid-structure', $e->errorCode(), $bound);
            }
        }
    }

    /**
     * @return iterable<string, array{string, list<array<string, int>>, ?list<string>}>
     */
    public static function partitions(): iterable
    {
        yield 'two adjacent intervals load' => ['', [['lte' => 100], ['gt' => 100]], null];
        yield 'three adjacent intervals load' => ['', [['lte' => 10], ['gt' => 10, 'lte' => 20], ['gt' => 20]], null];
        yield 'out of order in the file still loads' => ['', [['gt' => 20], ['lte' => 10], ['gt' => 10, 'lte' => 20]], null];
        yield 'a single unbounded interval needs gt or lte, so it does not cover' => ['conditions-not-covering', [['gt' => 0]], null];
        yield 'first has a lower bound' => ['conditions-not-covering', [['gt' => 5, 'lte' => 10], ['gt' => 10]], null];
        yield 'last has an upper bound' => ['conditions-not-covering', [['lte' => 10], ['gt' => 10, 'lte' => 20]], null];
        yield 'last bound at 2^53 - 1 still has an upper bound' => ['conditions-not-covering', [['lte' => 10], ['gt' => 10, 'lte' => 9007199254740991]], null];
        yield 'a gap of one input' => ['conditions-not-covering', [['lte' => 10], ['gt' => 11]], null];
        yield 'overlap by one input' => ['conditions-not-exclusive', [['lte' => 10], ['gt' => 9]], null];
        yield 'two open below' => ['conditions-not-exclusive', [['lte' => 10], ['lte' => 20], ['gt' => 20]], null];
        yield 'two open above' => ['conditions-not-exclusive', [['lte' => 10], ['gt' => 10], ['gt' => 20]], null];
        yield 'open above then another' => ['conditions-not-exclusive', [['gt' => 10], ['gt' => 10, 'lte' => 20], ['lte' => 10]], null];
        yield 'gt equal to lte' => ['invalid-structure', [['gt' => 10, 'lte' => 10], ['gt' => 10]], null];
        yield 'gt above lte' => ['invalid-structure', [['gt' => 11, 'lte' => 10], ['gt' => 10]], null];
        yield 'empty bounds' => ['invalid-structure', [[], ['gt' => 10]], null];
        yield 'an unknown bound' => ['invalid-structure', [['lt' => 10], ['gt' => 10]], null];
        yield 'conditionInputs names an unlisted component' => ['condition-inputs-invalid', [['lte' => 10], ['gt' => 10]], ['input_cached']];
        yield 'conditionInputs names a non-token component' => ['condition-inputs-invalid', [['lte' => 10], ['gt' => 10]], ['web_search']];
        yield 'conditionInputs names an unknown component' => ['unknown-component', [['lte' => 10], ['gt' => 10]], ['nope']];
        yield 'conditionInputs listed twice is a structure error' => ['invalid-structure', [['lte' => 10], ['gt' => 10]], ['input', 'input']];
        yield 'conditionInputs empty is a structure error' => ['invalid-structure', [['lte' => 10], ['gt' => 10]], []];
    }

    /**
     * @param list<array<string, int>> $conditions
     * @param list<string>|null        $conditionInputs
     */
    #[DataProvider('partitions')]
    public function testConditions(string $code, array $conditions, ?array $conditionInputs): void
    {
        $rates = [];
        foreach ($conditions as $bounds) {
            $rates[] = CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => $bounds === [] ? new \stdClass() : $bounds]]);
        }
        $json = CatalogFactory::json($rates, ['inputTokens' => $conditionInputs ?? ['input']]);
        try {
            $catalog = Catalog::load($json);
        } catch (LoadException $e) {
            self::assertSame($code, $e->errorCode(), $e->getMessage());

            return;
        }
        self::assertSame('', $code, 'the catalog loaded');
        self::assertNotSame([], $catalog->providers());
    }

    public function testSchedulesMustListTheSameComponentsEvenWhenWindowsDiffer(): void
    {
        $rates = [
            CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => ['lte' => 10]]]),
            CatalogFactory::rate('output', '1', 1000000, ['condition' => ['inputTokens' => ['lte' => 10]]]),
            CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => ['gt' => 10]]]),
        ];
        try {
            Catalog::load(CatalogFactory::json($rates, ['inputTokens' => ['input']]));
            self::fail('loaded');
        } catch (LoadException $e) {
            self::assertSame('schedules-mismatch', $e->errorCode());
        }
    }

    public function testMixedConditionsAreReportedBeforeMissingConditionInputs(): void
    {
        $rates = [
            CatalogFactory::rate('input', '1', 1000000, ['condition' => ['inputTokens' => ['lte' => 10]]]),
            CatalogFactory::rate('output', '1'),
        ];
        try {
            Catalog::load(CatalogFactory::json($rates));
            self::fail('loaded');
        } catch (LoadException $e) {
            self::assertSame('conditions-mixed', $e->errorCode());
        }
    }
}
