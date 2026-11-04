<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use InvalidArgumentException;
use OpenAdviser\AiCatalog\ErrorCode;
use OpenAdviser\AiCatalog\Exception\BasisException;
use OpenAdviser\AiCatalog\Jcs;
use stdClass;

/**
 * BASIS-4: what `priceFromBasis` checks before it prices anything, in the specification's order.
 *
 * 1. the sha256 of the bytes against the stated one (`basis-hash-mismatch`);
 * 2. the bytes parse, and `basisVersion` is 1 (`unsupported-basis-version`);
 * 3. the document satisfies `schema/basis.schema.json` (`invalid-basis`);
 * 4. canonicalizing it again gives the same bytes (`invalid-basis`);
 * 5. it is a document `price` could have written (`invalid-basis`).
 *
 * A basis that cannot be parsed, repeats a member or holds a number that is not an integer literal
 * is not in canonical form, so it is `invalid-basis` as well (JSON-1, JSON-2, BASIS-4).
 *
 * @internal
 */
final class BasisChecker
{
    private const string SHA256 = '/\A[0-9a-f]{64}\z/';

    private const string VERSION = '/\A[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[1-9][0-9]*\z/';

    private const string MODEL_ID = '/\A[A-Za-z0-9][A-Za-z0-9._:-]*\z/';

    private const string INSTANT_SHAPE = '/\A(19[7-9][0-9]|[2-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z\z/';

    private readonly Shape $shape;

    private function __construct()
    {
        $this->shape = new Shape(BasisException::class, ErrorCode::InvalidBasis);
    }

    /**
     * @throws BasisException
     */
    public static function check(string $bytes, string $stated): ParsedBasis
    {
        return (new self())->run($bytes, $stated);
    }

    private function run(string $bytes, string $stated): ParsedBasis
    {
        // 1. The digest.
        if (!hash_equals(hash('sha256', $bytes), $stated)) {
            $this->shape->fail(ErrorCode::BasisHashMismatch, 'basis', 'the bytes do not hash to the stated sha256');
        }

        // 2. Parse, then the version.
        try {
            $document = StrictJson::decode($bytes);
        } catch (JsonFailure $e) {
            $this->shape->bad('basis', $e->getMessage());
        }
        if (!$document instanceof stdClass) {
            $this->shape->bad('$', 'must be an object');
        }
        if (property_exists($document, 'basisVersion') && $document->basisVersion !== 1) {
            $this->shape->fail(ErrorCode::UnsupportedBasisVersion, '$.basisVersion', 'this client reads basis version 1');
        }

        // 3. The schema.
        $parsed = $this->document($document);

        // 4. Canonical form.
        try {
            $canonical = Jcs::encode($document);
        } catch (InvalidArgumentException $e) {
            $this->shape->bad('$', $e->getMessage());
        }
        if ($canonical !== $bytes) {
            $this->shape->bad('$', 'is not in canonical form (RFC 8785)');
        }

        // 5. A document price could have written.
        return $this->semantics($parsed);
    }

    // ---------------------------------------------------------------- 3. the schema

    /**
     * @return array{provider: string, tier: string, currency: string, exponent: int, conditionInputs: ?list<string>, schedules: list<array{condition: ?array{gt: ?int, lte: ?int}, entries: list<Entry>}>}
     */
    private function document(stdClass $document): array
    {
        $root = $this->shape->object(
            $document,
            '$',
            ['basisVersion', 'origin', 'provider', 'model', 'tier', 'currency', 'rounding', 'conditionInputs', 'schedules'],
        );
        $this->origin($root['origin']);
        $provider = $this->enum($root['provider'], '$.provider', ['anthropic', 'openai', 'google-gemini', 'elevenlabs']);
        $model = $this->shape->object($root['model'], '$.model', ['id', 'requested']);
        $this->shape->matching($model['id'], '$.model.id', self::MODEL_ID);
        $this->shape->matching($model['requested'], '$.model.requested', self::MODEL_ID);
        $tier = $this->enum($root['tier'], '$.tier', [
            'anthropic:standard',
            'anthropic:batch',
            'openai:standard',
            'google-gemini:standard',
            'elevenlabs:pay-as-you-go',
        ]);
        $currency = $this->enum($root['currency'], '$.currency', ['USD', 'EUR', 'GBP']);
        $rounding = $this->shape->object($root['rounding'], '$.rounding', ['rule', 'exponent', 'settlement']);
        if ($rounding['rule'] !== 'half-up-once-on-total') {
            $this->shape->bad('$.rounding.rule', 'must be "half-up-once-on-total"');
        }
        $exponent = $rounding['exponent'];
        if (!is_int($exponent) || $exponent < 0 || $exponent > 4) {
            $this->shape->bad('$.rounding.exponent', 'must be an integer from 0 to 4');
        }
        $this->enum($rounding['settlement'], '$.rounding.settlement', ['estimate', 'booked']);

        $inputs = $this->shape->object($root['conditionInputs'], '$.conditionInputs', [], ['inputTokens']);
        $conditionInputs = null;
        if (array_key_exists('inputTokens', $inputs)) {
            $this->shape->unique($inputs['inputTokens'], '$.conditionInputs.inputTokens');
            $conditionInputs = [];
            foreach ($this->shape->list($inputs['inputTokens'], '$.conditionInputs.inputTokens', 1) as $i => $component) {
                $conditionInputs[] = $this->component($component, '$.conditionInputs.inputTokens[' . $i . ']');
            }
        }

        $schedules = [];
        foreach ($this->shape->list($root['schedules'], '$.schedules', 1) as $i => $schedule) {
            $schedules[] = $this->schedule($schedule, '$.schedules[' . $i . ']');
        }

        return ['provider' => $provider, 'tier' => $tier, 'currency' => $currency, 'exponent' => $exponent, 'conditionInputs' => $conditionInputs, 'schedules' => $schedules];
    }

    private function origin(mixed $value): void
    {
        $origin = $value instanceof stdClass ? get_object_vars($value) : null;
        if ($origin !== null && ($origin['kind'] ?? null) === 'override') {
            $o = $this->shape->object($value, '$.origin', ['kind', 'revision']);
            $this->shape->string($o['revision'], '$.origin.revision', 1);

            return;
        }
        $o = $this->shape->object($value, '$.origin', ['kind', 'version', 'sha256']);
        if ($o['kind'] !== 'catalog') {
            $this->shape->bad('$.origin.kind', 'must be "catalog" or "override"');
        }
        $this->shape->matching($o['version'], '$.origin.version', self::VERSION);
        $this->shape->matching($o['sha256'], '$.origin.sha256', self::SHA256);
    }

    /**
     * @param list<string> $allowed
     */
    private function enum(mixed $value, string $path, array $allowed): string
    {
        $text = $this->shape->string($value, $path);
        if (!in_array($text, $allowed, true)) {
            $this->shape->bad($path, 'is not one of ' . implode(', ', $allowed));
        }

        return $text;
    }

    private function component(mixed $value, string $path): string
    {
        $component = $this->shape->string($value, $path);
        if (!Vocab::isComponent($component)) {
            $this->shape->bad($path, '"' . $component . '" is not a component');
        }

        return $component;
    }

    /**
     * @return array{condition: ?array{gt: ?int, lte: ?int}, entries: list<Entry>}
     */
    private function schedule(mixed $value, string $path): array
    {
        $m = $this->shape->object($value, $path, ['condition', 'components']);
        $condition = null;
        if ($m['condition'] !== null) {
            $c = $this->shape->object($m['condition'], $path . '.condition', ['inputTokens']);
            $bounds = $this->shape->object($c['inputTokens'], $path . '.condition.inputTokens', [], ['gt', 'lte']);
            if ($bounds === []) {
                $this->shape->bad($path . '.condition.inputTokens', 'needs "gt" or "lte"');
            }
            $condition = [
                'gt' => array_key_exists('gt', $bounds) ? $this->shape->nonNegativeInteger($bounds['gt'], $path . '.condition.inputTokens.gt', Vocab::BOUND) : null,
                'lte' => array_key_exists('lte', $bounds) ? $this->shape->nonNegativeInteger($bounds['lte'], $path . '.condition.inputTokens.lte', Vocab::BOUND) : null,
            ];
        }
        $entries = [];
        foreach ($this->shape->list($m['components'], $path . '.components', 1) as $i => $entry) {
            $entries[] = $this->entry($entry, $path . '.components[' . $i . ']');
        }

        return ['condition' => $condition, 'entries' => $entries];
    }

    /** The schema's two shapes of component: priced (all nine members) or not (two). Nothing is derived yet. */
    private function entry(mixed $value, string $path): Entry
    {
        $probe = $value instanceof stdClass ? get_object_vars($value) : [];
        if (($probe['disposition'] ?? null) !== 'priced') {
            $m = $this->shape->object($value, $path, ['component', 'disposition']);
            $component = $this->component($m['component'], $path . '.component');
            $disposition = match ($this->enum($m['disposition'], $path . '.disposition', ['inapplicable', 'unsupported', 'no-rate'])) {
                'inapplicable' => 'inapplicable',
                'unsupported' => 'unsupported',
                default => 'no-rate',
            };

            return new Entry($component, $disposition);
        }
        $m = $this->shape->object(
            $value,
            $path,
            ['component', 'disposition', 'unit', 'per', 'amount', 'meter', 'factor', 'validFrom', 'validUntil'],
        );
        $component = $this->component($m['component'], $path . '.component');
        $unit = $this->enum($m['unit'], $path . '.unit', ['token', 'character', 'request', 'millisecond', 'second', 'minute', 'hour', 'token-hour']);
        $per = $m['per'];
        if (!is_int($per) || !in_array($per, Vocab::PERS, true)) {
            $this->shape->bad($path . '.per', 'must be a power of ten from 1 to 10^9');
        }
        $amount = $m['amount'];
        if (!is_string($amount) || !Amount::isValid($amount)) {
            $this->shape->bad($path . '.amount', 'must be a decimal string of NUM-1');
        }
        $meter = $m['meter'] === null ? null : $this->enum($m['meter'], $path . '.meter', ['token', 'character', 'request', 'millisecond']);
        $factor = $m['factor'];
        if ($factor !== null && (!is_int($factor) || !in_array($factor, [1, 1000, 60000, 3600000], true))) {
            $this->shape->bad($path . '.factor', 'must be 1, 1000, 60000, 3600000 or null');
        }
        $window = [];
        foreach (['validFrom', 'validUntil'] as $name) {
            $window[$name] = $m[$name] === null ? null : $this->shape->matching($m[$name], $path . '.' . $name, self::INSTANT_SHAPE);
        }

        return new Entry($component, 'priced', $unit, $per, $amount, $factor, $meter, $window['validFrom'], $window['validUntil']);
    }

    // ---------------------------------------------------------------- 5. a document price could have written

    /**
     * @param array{provider: string, tier: string, currency: string, exponent: int, conditionInputs: ?list<string>, schedules: list<array{condition: ?array{gt: ?int, lte: ?int}, entries: list<Entry>}>} $doc
     */
    private function semantics(array $doc): ParsedBasis
    {
        if ($doc['exponent'] !== Vocab::exponent($doc['currency'])) {
            $this->shape->bad('$.rounding.exponent', 'is not the exponent of ' . $doc['currency']);
        }
        if (!Vocab::tierBelongsTo($doc['tier'], $doc['provider'])) {
            $this->shape->bad('$.tier', 'is not a tier of ' . $doc['provider']);
        }

        $schedules = [];
        $componentLists = [];
        foreach ($doc['schedules'] as $i => $schedule) {
            $path = '$.schedules[' . $i . ']';
            $entries = [];
            $names = [];
            $previous = null;
            foreach ($schedule['entries'] as $j => $entry) {
                $entryPath = $path . '.components[' . $j . ']';
                if ($previous !== null && strcmp($previous, $entry->component) >= 0) {
                    $this->shape->bad($entryPath, 'components must be in strictly ascending code-point order');
                }
                $previous = $entry->component;
                $names[] = $entry->component;
                $this->checkPriced($entry, $entryPath);
                $entries[] = $entry;
            }
            $componentLists[] = $names;
            $schedules[] = new Schedule(
                $schedule['condition'] === null ? null : new Condition($schedule['condition']['gt'], $schedule['condition']['lte']),
                $entries,
            );
        }
        $this->sharedInstant($schedules);
        foreach ($componentLists as $names) {
            if ($names !== $componentLists[0]) {
                $this->shape->bad('$.schedules', 'every schedule must list the same components');
            }
        }

        $inputs = $doc['conditionInputs'];
        if (count($schedules) === 1) {
            if ($schedules[0]->condition !== null || $inputs !== null) {
                $this->shape->bad('$.schedules', 'a single schedule has condition null and conditionInputs {}');
            }

            return new ParsedBasis($doc['currency'], $doc['exponent'], [], $schedules);
        }
        $this->partition($schedules);
        if ($inputs === null) {
            $this->shape->bad('$.conditionInputs', 'schedules with conditions need conditionInputs.inputTokens');
        }
        $sorted = $inputs;
        sort($sorted, SORT_STRING);
        if ($sorted !== $inputs) {
            $this->shape->bad('$.conditionInputs.inputTokens', 'must be sorted by code point');
        }
        foreach ($inputs as $component) {
            if (!Vocab::isTokenComponent($component) || !in_array($component, $componentLists[0], true)) {
                $this->shape->bad('$.conditionInputs.inputTokens', $component . ' must be a listed token component');
            }
        }

        /** @var non-empty-list<Schedule> $schedules */
        return new ParsedBasis($doc['currency'], $doc['exponent'], $inputs, $schedules);
    }

    /**
     * BASIS-4 step 5 for one priced component: the meter and factor are the unit's, the unit fits
     * the component, the amount is canonical, and the window is real and runs forward.
     */
    private function checkPriced(Entry $entry, string $path): void
    {
        if ($entry->disposition !== 'priced') {
            return;
        }
        $unit = (string) $entry->unit;
        if ($entry->meter !== Vocab::meter($unit) || $entry->factor !== Vocab::factor($unit)) {
            $this->shape->bad($path, 'meter and factor are not those of the unit ' . $unit);
        }
        if (!Vocab::unitFitsComponent($unit, $entry->component)) {
            $this->shape->bad($path . '.unit', $unit . ' is not a unit of the dimension of ' . $entry->component);
        }
        if ($entry->amount === null || Amount::canonical($entry->amount) !== $entry->amount) {
            $this->shape->bad($path . '.amount', 'is not in canonical form (NUM-4)');
        }
        $from = $this->instantMs($entry->validFrom, $path . '.validFrom');
        $until = $this->instantMs($entry->validUntil, $path . '.validUntil');
        if ($from !== null && $until !== null && $from >= $until) {
            $this->shape->bad($path, 'validFrom must be before validUntil');
        }
    }

    /**
     * BASIS-4 step 5: the priced entries of a basis were all in force at the one instant it was priced
     * at, so some instant must lie in every window: the latest `validFrom` is before the earliest
     * `validUntil`.
     *
     * @param list<Schedule> $schedules
     */
    private function sharedInstant(array $schedules): void
    {
        $latestFrom = $earliestUntil = null;
        foreach ($schedules as $schedule) {
            foreach ($schedule->entries as $entry) {
                $from = $this->instantMs($entry->validFrom, '$.schedules');
                $until = $this->instantMs($entry->validUntil, '$.schedules');
                $latestFrom = $from !== null && ($latestFrom === null || $from > $latestFrom) ? $from : $latestFrom;
                $earliestUntil = $until !== null && ($earliestUntil === null || $until < $earliestUntil) ? $until : $earliestUntil;
            }
        }
        if ($latestFrom !== null && $earliestUntil !== null && $latestFrom >= $earliestUntil) {
            $this->shape->bad('$.schedules', 'the priced entries share no instant: the latest validFrom is not before the earliest validUntil');
        }
    }

    private function instantMs(?string $value, string $path): ?int
    {
        if ($value === null) {
            return null;
        }
        $ms = Instant::parse($value);
        if ($ms === null) {
            $this->shape->bad($path, 'is not a valid UTC instant of whole seconds');
        }

        return $ms;
    }

    /**
     * COND-1 and COND-4 on the schedules of a basis: every condition is a proper interval, they
     * ascend by lower bound, and they partition [0, 2^53).
     *
     * @param list<Schedule> $schedules
     */
    private function partition(array $schedules): void
    {
        $previous = null;
        foreach ($schedules as $i => $schedule) {
            $c = $schedule->condition;
            $path = '$.schedules[' . $i . '].condition';
            if ($c === null) {
                $this->shape->bad($path, 'schedules of a basis with several schedules each have a condition');
            }
            if ($c->gt !== null && $c->lte !== null && $c->gt >= $c->lte) {
                $this->shape->bad($path, '"gt" must be below "lte"');
            }
            if ($previous === null ? $c->gt !== null : $previous->lte === null || $c->gt !== $previous->lte) {
                $this->shape->bad($path, 'the conditions must partition the inputs in ascending order');
            }
            $previous = $c;
        }
        if ($previous === null || $previous->lte !== null) {
            $this->shape->bad('$.schedules', 'the last condition must have no "lte"');
        }
    }
}
