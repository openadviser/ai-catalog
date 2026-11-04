<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * The closed 1.0.0 vocabularies of the specification: components (COMP-1), units (UNIT-1), tiers
 * (TIER-1), currencies (ROUND-1) and effort levels (EFF-1).
 *
 * @internal
 */
final class Vocab
{
    /** Component => [dimension, per call]. */
    private const array COMPONENTS = [
        'input' => ['tokens', true],
        'input_cached' => ['tokens', true],
        'cache_write_5m' => ['tokens', true],
        'cache_write_1h' => ['tokens', true],
        'cache_write_30m' => ['tokens', true],
        'cache_write_12h' => ['tokens', true],
        'output' => ['tokens', true],
        'output_audio' => ['tokens', true],
        'characters' => ['characters', true],
        'output_audio_duration' => ['duration', true],
        'web_search' => ['requests', true],
        'file_search' => ['requests', true],
        'grounding_search' => ['requests', true],
        'grounding_maps' => ['requests', true],
        'code_execution' => ['duration', true],
        'containers' => ['duration', true],
        'cache_storage' => ['token-time', false],
        'file_search_storage' => ['storage', false],
    ];

    /** Unit => [dimension, meter, factor]; a compound unit has no meter and no factor. */
    private const array UNITS = [
        'token' => ['tokens', 'token', 1],
        'character' => ['characters', 'character', 1],
        'request' => ['requests', 'request', 1],
        'millisecond' => ['duration', 'millisecond', 1],
        'second' => ['duration', 'millisecond', 1000],
        'minute' => ['duration', 'millisecond', 60000],
        'hour' => ['duration', 'millisecond', 3600000],
        'token-hour' => ['token-time', null, null],
    ];

    private const array PROVIDER_TIERS = [
        'anthropic' => ['anthropic:standard', 'anthropic:batch'],
        'openai' => ['openai:standard'],
        'google-gemini' => ['google-gemini:standard'],
        'elevenlabs' => ['elevenlabs:pay-as-you-go'],
    ];

    /** Currency => minor-unit exponent. */
    private const array CURRENCIES = ['USD' => 2, 'EUR' => 2, 'GBP' => 2];

    public const array EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    public const array PERS = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];

    /** 2^53, the exclusive bound of quantities and condition bounds (NUM-3, COND-1). */
    public const int BOUND = 9007199254740992;

    private function __construct() {}

    public static function isComponent(string $component): bool
    {
        return isset(self::COMPONENTS[$component]);
    }

    /** @return list<string> */
    public static function components(): array
    {
        return array_keys(self::COMPONENTS);
    }

    public static function isPerCall(string $component): bool
    {
        return (self::COMPONENTS[$component] ?? [null, false])[1];
    }

    public static function isTokenComponent(string $component): bool
    {
        return (self::COMPONENTS[$component] ?? [null])[0] === 'tokens';
    }

    public static function componentDimension(string $component): ?string
    {
        return (self::COMPONENTS[$component] ?? [null])[0];
    }

    public static function isUnit(string $unit): bool
    {
        return isset(self::UNITS[$unit]);
    }

    public static function unitDimension(string $unit): ?string
    {
        return (self::UNITS[$unit] ?? [null])[0];
    }

    /** The meter of a unit; null for a compound unit or an unknown unit. */
    public static function meter(string $unit): ?string
    {
        return (self::UNITS[$unit] ?? [null, null])[1];
    }

    /** Meter units per unit; null for a compound unit or an unknown unit. */
    public static function factor(string $unit): ?int
    {
        return (self::UNITS[$unit] ?? [null, null, null])[2];
    }

    public static function isCompound(string $unit): bool
    {
        return isset(self::UNITS[$unit]) && self::UNITS[$unit][2] === null;
    }

    /** Whether a priced rate of `$component` may carry `$unit` (UNIT-1). */
    public static function unitFitsComponent(string $unit, string $component): bool
    {
        $unitDimension = self::unitDimension($unit);

        return $unitDimension !== null && $unitDimension === self::componentDimension($component);
    }

    public static function isTier(string $tier): bool
    {
        foreach (self::PROVIDER_TIERS as $tiers) {
            if (in_array($tier, $tiers, true)) {
                return true;
            }
        }

        return false;
    }

    public static function isProvider(string $provider): bool
    {
        return isset(self::PROVIDER_TIERS[$provider]);
    }

    /** TIER-1: whether `$tier` is `<provider>:<name>` for the given provider id. */
    public static function tierBelongsTo(string $tier, string $provider): bool
    {
        return str_starts_with($tier, $provider . ':');
    }

    public static function exponent(string $currency): ?int
    {
        return self::CURRENCIES[$currency] ?? null;
    }
}
