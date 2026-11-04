<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use OpenAdviser\AiCatalog\Jcs;
use stdClass;

/**
 * Builds the basis of BASIS-1 and writes its canonical bytes (BASIS-2).
 *
 * @internal
 */
final class BasisWriter
{
    private function __construct() {}

    /**
     * @param list<Schedule>    $schedules
     * @param list<string>|null $conditionInputs sorted; null without conditions
     */
    public static function write(
        string $catalogVersion,
        string $catalogSha256,
        string $provider,
        string $resolvedModelId,
        string $requestedModelId,
        string $tier,
        string $currency,
        int $exponent,
        string $settlement,
        ?array $conditionInputs,
        array $schedules,
    ): string {
        $document = [
            'basisVersion' => 1,
            'origin' => ['kind' => 'catalog', 'version' => $catalogVersion, 'sha256' => $catalogSha256],
            'provider' => $provider,
            'model' => ['id' => $resolvedModelId, 'requested' => $requestedModelId],
            'tier' => $tier,
            'currency' => $currency,
            'rounding' => ['rule' => 'half-up-once-on-total', 'exponent' => $exponent, 'settlement' => $settlement],
            'conditionInputs' => $conditionInputs === null ? new stdClass() : ['inputTokens' => $conditionInputs],
            'schedules' => array_map(self::schedule(...), $schedules),
        ];

        return Jcs::encode($document);
    }

    /** @return array<string, mixed> */
    private static function schedule(Schedule $schedule): array
    {
        $condition = null;
        if ($schedule->condition !== null) {
            $bounds = [];
            if ($schedule->condition->gt !== null) {
                $bounds['gt'] = $schedule->condition->gt;
            }
            if ($schedule->condition->lte !== null) {
                $bounds['lte'] = $schedule->condition->lte;
            }
            $condition = ['inputTokens' => $bounds];
        }

        return ['condition' => $condition, 'components' => array_map(self::entry(...), $schedule->entries)];
    }

    /** @return array<string, mixed> */
    private static function entry(Entry $entry): array
    {
        if ($entry->disposition !== 'priced') {
            return ['component' => $entry->component, 'disposition' => $entry->disposition];
        }

        return [
            'component' => $entry->component,
            'disposition' => 'priced',
            'unit' => $entry->unit,
            'per' => $entry->per,
            'amount' => $entry->amount,
            'meter' => $entry->meter,
            'factor' => $entry->factor,
            'validFrom' => $entry->validFrom,
            'validUntil' => $entry->validUntil,
        ];
    }
}
