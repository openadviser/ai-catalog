<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use Brick\Math\BigRational;
use LogicException;
use OpenAdviser\AiCatalog\ErrorCode;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Exception\UsageIncompleteException;
use OpenAdviser\AiCatalog\UsageReport;

/**
 * Steps 5 to 10 of PRICE-2, shared by `price` and `priceFromBasis` (BASIS-3) so that the two cannot
 * drift apart: the same schedules, the same usage, the same code.
 *
 * @internal
 */
final class Engine
{
    private function __construct() {}

    /**
     * @param non-empty-list<Schedule> $schedules       the schedules as built at the instant, or read from a basis
     * @param list<string>             $conditionInputs the components `inputTokens` sums; empty without conditions
     * @param bool                     $unknown         COND-7: the input is not known, so every schedule is evaluated
     *
     * @throws PriceException
     */
    public static function price(array $schedules, array $conditionInputs, UsageReport $usage, bool $unknown, int $exponent): Figures
    {
        // Step 5: completeness (USAGE-1, USAGE-2).
        $missing = self::missing($schedules, $conditionInputs, $usage);
        if ($usage->completeness !== UsageReport::COMPLETE || $missing !== []) {
            throw new UsageIncompleteException($missing);
        }

        // Step 6: a positive quantity for a component the offering does not list (COMP-3).
        $offered = [];
        foreach ($schedules[0]->entries as $entry) {
            $offered[$entry->component] = true;
        }
        $positive = array_filter($usage->quantities, static fn(int $q): bool => $q > 0);
        ksort($positive, SORT_STRING);
        foreach (array_keys($positive) as $component) {
            if (!isset($offered[$component])) {
                throw new PriceException(ErrorCode::ComponentNotOffered, $component);
            }
        }

        // Step 7: the candidate schedules (COND-6, COND-7).
        $candidates = self::candidates($schedules, $conditionInputs, $usage, $unknown);

        // Step 8: refusals and the exact total of each candidate, in order.
        $totals = [];
        foreach ($candidates as $index => $schedule) {
            $totals[$index] = self::total($schedule, $positive);
        }

        // Step 9: the chosen schedule. With several candidates the greatest total wins, the lowest
        // interval on a tie (COND-7).
        $chosen = null;
        foreach ($totals as $index => $total) {
            if ($chosen === null || $total->compareTo($totals[$chosen]) > 0) {
                $chosen = $index;
            }
        }
        if ($chosen === null) {
            throw new LogicException('a priced offering has at least one schedule');
        }

        // Step 10: the roundings.
        return Figures::of($chosen, $totals[$chosen], $exponent);
    }

    /**
     * USAGE-2: the per-call components whose entry is priced, unsupported or "no rate" in at least one
     * schedule, plus every `conditionInputs` component, that the report does not state. Sorted by code
     * point.
     *
     * @param list<Schedule> $schedules
     * @param list<string>   $conditionInputs
     *
     * @return list<string>
     */
    private static function missing(array $schedules, array $conditionInputs, UsageReport $usage): array
    {
        $required = array_fill_keys($conditionInputs, true);
        foreach ($schedules as $schedule) {
            foreach ($schedule->entries as $entry) {
                if (Vocab::isPerCall($entry->component) && $entry->disposition !== 'inapplicable') {
                    $required[$entry->component] = true;
                }
            }
        }
        $missing = [];
        foreach (array_keys($required) as $component) {
            if (!array_key_exists($component, $usage->quantities)) {
                $missing[] = $component;
            }
        }
        sort($missing, SORT_STRING);

        return $missing;
    }

    /**
     * @param list<Schedule> $schedules
     * @param list<string>   $conditionInputs
     *
     * @return array<int, Schedule> candidate schedules keyed by their index in `$schedules`
     */
    private static function candidates(array $schedules, array $conditionInputs, UsageReport $usage, bool $unknown): array
    {
        if ($schedules[0]->condition === null || $unknown) {
            return $schedules;
        }
        $input = 0;
        foreach ($conditionInputs as $component) {
            $input += $usage->quantities[$component] ?? 0;
        }
        foreach ($schedules as $index => $schedule) {
            if ($schedule->condition !== null && $schedule->condition->holds($input)) {
                return [$index => $schedule];
            }
        }

        throw new LogicException('the schedules of a valid offering cover every input');
    }

    /**
     * @param array<string, int> $positive the positive quantities by component, in code-point order
     *
     * @throws PriceException
     */
    private static function total(Schedule $schedule, array $positive): BigRational
    {
        $entries = [];
        foreach ($schedule->entries as $entry) {
            $entries[$entry->component] = $entry;
        }
        $total = BigRational::zero();
        foreach ($positive as $component => $quantity) {
            $entry = $entries[$component];
            switch ($entry->disposition) {
                case 'unsupported':
                    throw new PriceException(ErrorCode::UnsupportedComponent, $component);
                case 'inapplicable':
                    throw new PriceException(ErrorCode::InapplicableComponentUsed, $component);
                case 'no-rate':
                    throw new PriceException(ErrorCode::NoRateInForce, $component);
            }
            if ($entry->isCompound()) {
                throw new PriceException(ErrorCode::UnsupportedUnit, $component);
            }
            $total = $total->plus($entry->cost($quantity));
        }

        return $total->simplified();
    }
}
