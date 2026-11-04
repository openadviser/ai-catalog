<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * A validated offering: one way of buying a model, identified by its tier.
 *
 * @internal
 */
final readonly class Offering
{
    /**
     * @param list<Rate>        $rates
     * @param list<string>|null $conditionInputs sorted by code point; null for an offering without conditions
     * @param non-empty-list<?Condition> $conditions the distinct schedules in ascending order; `[null]` without conditions
     */
    public function __construct(
        public string $tier,
        public string $currency,
        public array $rates,
        public ?array $conditionInputs,
        public array $conditions,
    ) {}

    /**
     * PRICE-2 step 4: each schedule built at `$ms`. For each component the offering lists, the entry
     * is the one in force, or "no rate" when none is.
     *
     * @return non-empty-list<Schedule>
     */
    public function schedulesAt(int $ms): array
    {
        $components = [];
        foreach ($this->rates as $rate) {
            $components[$rate->component] = true;
        }
        $names = array_map(strval(...), array_keys($components));
        sort($names, SORT_STRING);
        /** @var list<string> $names */

        return array_map(
            fn(?Condition $condition): Schedule => new Schedule(
                $condition,
                array_map(fn(string $name): Entry => $this->entryAt($name, $condition, $ms), $names),
            ),
            $this->conditions,
        );
    }

    private function entryAt(string $component, ?Condition $condition, int $ms): Entry
    {
        foreach ($this->rates as $rate) {
            if ($rate->component !== $component || !self::sameCondition($rate->condition, $condition) || !$rate->inForceAt($ms)) {
                continue;
            }
            if ($rate->disposition !== 'priced') {
                return new Entry($component, $rate->disposition);
            }
            $unit = (string) $rate->unit;

            return new Entry(
                $component,
                'priced',
                $unit,
                $rate->per,
                $rate->amount,
                Vocab::factor($unit),
                Vocab::meter($unit),
                $rate->validFrom,
                $rate->validUntil,
            );
        }

        return new Entry($component, 'no-rate');
    }

    private static function sameCondition(?Condition $a, ?Condition $b): bool
    {
        if ($a === null || $b === null) {
            return $a === $b;
        }

        return $a->sameAs($b);
    }
}
