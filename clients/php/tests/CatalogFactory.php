<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

/**
 * Builds small valid catalogs for tests that need a shape the conformance fixtures do not have.
 * Everything is invented test data, as in the fixtures.
 */
final class CatalogFactory
{
    private function __construct() {}

    /**
     * @return array<string, mixed>
     */
    public static function provenance(bool $withDateRule = false): array
    {
        $provenance = [
            'source' => 'fixture',
            'url' => 'https://example.com/fixture',
            'readAt' => '2026-11-04T00:00:00Z',
            'reader' => 'manual',
            'evidence' => str_repeat('0', 64),
            'location' => ['path' => 'test fixture', 'offset' => 0, 'excerpt' => 'fixture'],
        ];
        if ($withDateRule) {
            $provenance['dateRule'] = 'undated';
        }

        return $provenance;
    }

    /**
     * A priced token rate, `$amount` per `$per` tokens.
     *
     * @param array<string, mixed> $more extra members, such as `condition`, `validFrom`, `validUntil`
     *
     * @return array<string, mixed>
     */
    public static function rate(string $component, string $amount, int $per = 1000000, array $more = []): array
    {
        return [
            'component' => $component,
            'disposition' => 'priced',
            'unit' => 'token',
            'per' => $per,
            'amount' => $amount,
            'currency' => 'USD',
            ...$more,
            'provenance' => self::provenance(true),
        ];
    }

    /**
     * @param list<array<string, mixed>> $rates
     * @param array<string, mixed>|null  $conditionInputs
     * @param array<string, mixed>       $modelMore       extra model members
     */
    public static function json(array $rates, ?array $conditionInputs = null, string $version = '2026.11.04.1', array $modelMore = []): string
    {
        $offering = ['tier' => 'openai:standard', 'rates' => $rates];
        if ($conditionInputs !== null) {
            $offering['conditionInputs'] = $conditionInputs;
        }
        $catalog = [
            'schemaVersion' => '1.0.0',
            'version' => $version,
            'publishedAt' => '2026-11-04T00:00:00Z',
            'providers' => [[
                'id' => 'openai',
                'name' => 'OpenAI (test)',
                'pricingUrls' => ['https://example.com/fixture'],
                'models' => [[
                    'id' => 'test-model',
                    'name' => 'Test model',
                    'aliases' => [['id' => 'test-alias', 'status' => 'active']],
                    'status' => 'available',
                    'capabilities' => ['text-generation'],
                    'offerings' => [$offering],
                    'provenance' => self::provenance(),
                    ...$modelMore,
                ]],
            ]],
        ];

        return json_encode($catalog, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }
}
