<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use OpenAdviser\AiCatalog\Alias;
use OpenAdviser\AiCatalog\Effort;
use OpenAdviser\AiCatalog\ErrorCode;
use OpenAdviser\AiCatalog\Exception\LoadException;
use OpenAdviser\AiCatalog\Model;

/**
 * Load-time validation (Section 14): `schema/catalog.schema.json` and the semantic checks no schema
 * can express, hand-written so that no JSON Schema validator is needed at runtime (Section 2). Every
 * violation is reported with the code of the most specific rule it breaks (VAL-4), and the whole
 * candidate is refused on the first one (VAL-1).
 *
 * The checks run in two phases. First the structure of the whole document, so a malformed member
 * anywhere is reported before a cross-reference is judged. Then the semantic rules, per provider and
 * per offering. Each rejecting conformance vector breaks exactly one rule. A catalog that breaks
 * several may be rejected with the code of any of them (VAL-1), so the order below is not a contract,
 * except that the schema version is judged first (VAL-3).
 *
 * @internal
 */
final class CatalogValidator
{
    private const string SHA256 = '/\A[0-9a-f]{64}\z/';

    private const string HTTPS = '/\Ahttps:\/\//';

    private const string MODEL_ID = '/\A[A-Za-z0-9][A-Za-z0-9._:-]*\z/';

    private const array STATUSES = ['preview', 'available', 'deprecated', 'retired'];

    private const array CAPABILITIES = ['text-generation', 'speech-synthesis', 'music-generation', 'sound-effects-generation'];

    private readonly Shape $shape;

    /** Whether the document being read declares 1.0.x, and so uses the 1.0.0 component vocabulary (COMP-1). */
    private bool $legacyVocabulary = false;

    private function __construct()
    {
        $this->shape = new Shape(LoadException::class, ErrorCode::InvalidStructure);
    }

    /**
     * @return array{schemaVersion: string, version: string, publishedAt: string, providers: list<ProviderEntry>}
     *
     * @throws LoadException
     */
    public static function validate(mixed $document): array
    {
        return (new self())->catalog($document);
    }

    /**
     * @return array{schemaVersion: string, version: string, publishedAt: string, providers: list<ProviderEntry>}
     */
    private function catalog(mixed $document): array
    {
        // VAL-3 first: a document of another schema version may be shaped differently, with members
        // and vocabulary this client cannot know (VAL-3 says why), so its structure is not judged.
        if (!$document instanceof \stdClass || !property_exists($document, 'schemaVersion')) {
            $this->shape->bad('$', 'must be an object with a schemaVersion');
        }
        $schemaVersion = $this->shape->string($document->schemaVersion, '$.schemaVersion');
        if (preg_match('/\A1\.[01]\.(0|[1-9][0-9]*)\z/', $schemaVersion) !== 1) {
            $this->shape->fail(ErrorCode::UnsupportedSchemaVersion, '$.schemaVersion', 'this client reads schema 1.0.x and 1.1.x');
        }
        $this->legacyVocabulary = str_starts_with($schemaVersion, '1.0.');
        $root = $this->shape->object($document, '$', ['schemaVersion', 'version', 'publishedAt', 'providers']);
        $version = $this->version($root['version'], '$.version');
        $publishedAt = $this->instant($root['publishedAt'], '$.publishedAt')[0];

        $providers = [];
        foreach ($this->shape->list($root['providers'], '$.providers') as $i => $provider) {
            $providers[] = $this->provider($provider, '$.providers[' . $i . ']');
        }

        return ['schemaVersion' => $schemaVersion, 'version' => $version, 'publishedAt' => $publishedAt, 'providers' => $this->semantics($providers)];
    }

    // ---------------------------------------------------------------- structure

    private function version(mixed $value, string $path): string
    {
        $text = $this->shape->string($value, $path);
        if (preg_match('/\A([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.[1-9][0-9]*\z/', $text, $m) !== 1 || !Instant::validDay((int) $m[1], (int) $m[2], (int) $m[3])) {
            $this->shape->fail(ErrorCode::InvalidVersion, $path, 'must be YYYY.MM.DD.N with a real date');
        }

        return $text;
    }

    /**
     * TIME-1: an instant of whole seconds. A string that is not one is `invalid-instant`.
     *
     * @return array{string, int} the text and its milliseconds
     */
    private function instant(mixed $value, string $path): array
    {
        $text = $this->shape->string($value, $path);
        $ms = Instant::parse($text);
        if ($ms === null) {
            $this->shape->fail(ErrorCode::InvalidInstant, $path, 'is not a valid UTC instant of whole seconds');
        }

        return [$text, $ms];
    }

    private function provider(mixed $value, string $path): ProviderEntry
    {
        $m = $this->shape->object($value, $path, ['id', 'name', 'pricingUrls', 'models']);
        $id = $this->shape->string($m['id'], $path . '.id');
        if (!Vocab::isProvider($id)) {
            $this->shape->bad($path . '.id', 'is not a provider of schema 1.0.0');
        }
        $name = $this->shape->string($m['name'], $path . '.name', 1);
        foreach ($this->shape->list($m['pricingUrls'], $path . '.pricingUrls', 1) as $i => $url) {
            $this->shape->matching($url, $path . '.pricingUrls[' . $i . ']', self::HTTPS);
        }
        $models = [];
        foreach ($this->shape->list($m['models'], $path . '.models') as $i => $model) {
            $models[] = $this->model($model, $path . '.models[' . $i . ']', $id);
        }

        return new ProviderEntry($id, $name, $models);
    }

    private function model(mixed $value, string $path, string $provider): ModelEntry
    {
        $m = $this->shape->object(
            $value,
            $path,
            ['id', 'name', 'aliases', 'status', 'capabilities', 'offerings', 'provenance'],
            ['retiresOn', 'effort', 'statusProvenance'],
        );
        $id = $this->modelId($m['id'], $path . '.id');
        $name = $this->shape->string($m['name'], $path . '.name', 1);
        $aliases = [];
        foreach ($this->shape->list($m['aliases'], $path . '.aliases') as $i => $alias) {
            $am = $this->shape->object($alias, $path . '.aliases[' . $i . ']', ['id', 'status']);
            $aliasStatus = $this->enum($am['status'], $path . '.aliases[' . $i . '].status', ['active', 'retired']);
            $aliases[] = new Alias($this->modelId($am['id'], $path . '.aliases[' . $i . '].id'), $aliasStatus === 'active' ? 'active' : 'retired');
        }
        $status = $this->enum($m['status'], $path . '.status', self::STATUSES);
        $capabilities = [];
        $this->shape->unique($m['capabilities'], $path . '.capabilities');
        foreach ($this->shape->list($m['capabilities'], $path . '.capabilities') as $i => $capability) {
            $capabilities[] = $this->enum($capability, $path . '.capabilities[' . $i . ']', self::CAPABILITIES);
        }
        $retiresOn = null;
        if (array_key_exists('retiresOn', $m)) {
            $retiresOn = $this->shape->string($m['retiresOn'], $path . '.retiresOn');
            if (!Instant::isDate($retiresOn)) {
                $this->shape->fail(ErrorCode::InvalidInstant, $path . '.retiresOn', 'is not a real date YYYY-MM-DD');
            }
        }
        $effort = array_key_exists('effort', $m) ? $this->effort($m['effort'], $path . '.effort') : null;
        $this->provenance($m['provenance'], $path . '.provenance', false);
        $needsStatusProvenance = $retiresOn !== null || $status !== 'available';
        if (array_key_exists('statusProvenance', $m)) {
            $this->provenance($m['statusProvenance'], $path . '.statusProvenance', false);
        } elseif ($needsStatusProvenance) {
            $this->shape->bad($path, 'missing member "statusProvenance"');
        }

        $offerings = [];
        foreach ($this->shape->list($m['offerings'], $path . '.offerings') as $i => $offering) {
            $offerings[] = $this->offering($offering, $path . '.offerings[' . $i . ']');
        }
        $tiers = array_map(static fn(Offering $o): string => $o->tier, $offerings);

        return new ModelEntry(new Model($provider, $id, $name, $aliases, $status, $capabilities, $retiresOn, $effort, $tiers), $offerings);
    }

    private function modelId(mixed $value, string $path): string
    {
        $id = $this->shape->matching($value, $path, self::MODEL_ID);
        if (strlen($id) > 200) {
            $this->shape->bad($path, 'is longer than 200 characters');
        }

        return $id;
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

    /** EFF-1. A wrongly typed member is a structure error; a wrong list or default is `invalid-effort`. */
    private function effort(mixed $value, string $path): Effort
    {
        $m = $this->shape->object($value, $path, ['levels', 'default', 'provenance']);
        $items = $this->shape->list($m['levels'], $path . '.levels');
        $levels = [];
        foreach ($items as $i => $level) {
            $levels[] = $this->shape->string($level, $path . '.levels[' . $i . ']');
        }
        $default = $m['default'];
        if ($default !== null) {
            $default = $this->shape->string($default, $path . '.default');
        }
        $this->provenance($m['provenance'], $path . '.provenance', false);

        $previous = -1;
        foreach ($levels as $level) {
            $rank = array_search($level, Vocab::EFFORT_LEVELS, true);
            if ($rank === false || $rank <= $previous) {
                $this->shape->fail(ErrorCode::InvalidEffort, $path . '.levels', 'must be distinct levels in ascending order');
            }
            $previous = $rank;
        }
        if ($levels === []) {
            $this->shape->fail(ErrorCode::InvalidEffort, $path . '.levels', 'must not be empty');
        }
        if ($default !== null && !in_array($default, $levels, true)) {
            $this->shape->fail(ErrorCode::InvalidEffort, $path . '.default', 'must be one of the levels, or null');
        }

        return new Effort($levels, $default);
    }

    private function provenance(mixed $value, string $path, bool $requireDateRule): void
    {
        $m = $this->shape->object(
            $value,
            $path,
            ['source', 'url', 'readAt', 'reader', 'evidence'],
            ['location', 'derivation', 'dateRule', 'note'],
        );
        $this->shape->matching($m['source'], $path . '.source', '/\A[a-z0-9]+(-[a-z0-9]+)*\z/');
        $this->shape->matching($m['url'], $path . '.url', self::HTTPS);
        $this->instant($m['readAt'], $path . '.readAt');
        $this->shape->matching($m['reader'], $path . '.reader', '/\A(manual|[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+)\z/');
        $this->shape->matching($m['evidence'], $path . '.evidence', self::SHA256);
        if (array_key_exists('location', $m) === array_key_exists('derivation', $m)) {
            $this->shape->bad($path, 'needs exactly one of "location" and "derivation"');
        }
        if (array_key_exists('location', $m)) {
            $this->location($m['location'], $path . '.location');
        }
        if (array_key_exists('derivation', $m)) {
            $this->derivation($m['derivation'], $path . '.derivation');
        }
        if (array_key_exists('dateRule', $m)) {
            $this->enum($m['dateRule'], $path . '.dateRule', ['undated', 'date-only-utc', 'date-only-zoned', 'stated-instant']);
        } elseif ($requireDateRule) {
            $this->shape->bad($path, 'missing member "dateRule"');
        }
        if (array_key_exists('note', $m)) {
            $this->shape->string($m['note'], $path . '.note', 1);
        }
    }

    private function location(mixed $value, string $path): void
    {
        $m = $this->shape->object($value, $path, ['path', 'offset', 'excerpt'], ['anchors']);
        $this->shape->string($m['path'], $path . '.path', 1);
        $this->shape->unboundedInteger($m['offset'], $path . '.offset');
        $this->excerpt($m['excerpt'], $path . '.excerpt');
        if (array_key_exists('anchors', $m)) {
            foreach ($this->shape->list($m['anchors'], $path . '.anchors', 1) as $i => $anchor) {
                $a = $this->shape->object($anchor, $path . '.anchors[' . $i . ']', ['offset', 'excerpt']);
                $this->shape->unboundedInteger($a['offset'], $path . '.anchors[' . $i . '].offset');
                $this->excerpt($a['excerpt'], $path . '.anchors[' . $i . '].excerpt');
            }
        }
    }

    private function derivation(mixed $value, string $path): void
    {
        $m = $this->shape->object($value, $path, ['formula', 'inputs']);
        $this->shape->string($m['formula'], $path . '.formula', 1);
        foreach ($this->shape->list($m['inputs'], $path . '.inputs', 2) as $i => $input) {
            $p = $path . '.inputs[' . $i . ']';
            $n = $this->shape->object($input, $p, ['evidence', 'url', 'path', 'offset', 'excerpt']);
            $this->shape->matching($n['evidence'], $p . '.evidence', self::SHA256);
            $this->shape->matching($n['url'], $p . '.url', self::HTTPS);
            $this->shape->string($n['path'], $p . '.path', 1);
            $this->shape->unboundedInteger($n['offset'], $p . '.offset');
            $this->excerpt($n['excerpt'], $p . '.excerpt');
        }
    }

    private function excerpt(mixed $value, string $path): void
    {
        $this->shape->maxChars($this->shape->string($value, $path, 1), $path, 600);
    }

    private function offering(mixed $value, string $path): Offering
    {
        $m = $this->shape->object($value, $path, ['tier', 'rates'], ['conditionInputs']);
        $tier = $this->shape->string($m['tier'], $path . '.tier');
        if (!Vocab::isTier($tier)) {
            $this->shape->fail(ErrorCode::UnknownTier, $path . '.tier', 'is not a tier of schema 1.0.0');
        }
        $conditionInputs = null;
        if (array_key_exists('conditionInputs', $m)) {
            $ci = $this->shape->object($m['conditionInputs'], $path . '.conditionInputs', ['inputTokens']);
            $this->shape->unique($ci['inputTokens'], $path . '.conditionInputs.inputTokens');
            $conditionInputs = [];
            foreach ($this->shape->list($ci['inputTokens'], $path . '.conditionInputs.inputTokens', 1) as $i => $component) {
                $conditionInputs[] = $this->component($component, $path . '.conditionInputs.inputTokens[' . $i . ']');
            }
        }
        $rates = [];
        foreach ($this->shape->list($m['rates'], $path . '.rates', 1) as $i => $rate) {
            $rates[] = $this->rate($rate, $path . '.rates[' . $i . ']');
        }

        return $this->offeringSemantics($path, $tier, $conditionInputs, $rates);
    }

    private function component(mixed $value, string $path): string
    {
        $component = $this->shape->string($value, $path);
        if (!Vocab::isComponent($component) || ($this->legacyVocabulary && in_array($component, Vocab::ADDED_AFTER_1_0, true))) {
            $this->shape->fail(ErrorCode::UnknownComponent, $path, '"' . $component . '" is not a component of the declared schema');
        }

        return $component;
    }

    private function rate(mixed $value, string $path): Rate
    {
        $m = $this->shape->object(
            $value,
            $path,
            ['component', 'disposition', 'provenance'],
            ['unit', 'per', 'amount', 'currency', 'condition', 'validFrom', 'validUntil', 'reason'],
        );
        $component = $this->component($m['component'], $path . '.component');
        $dispositionName = $this->enum($m['disposition'], $path . '.disposition', ['priced', 'inapplicable', 'unsupported']);
        $disposition = match ($dispositionName) {
            'priced' => 'priced',
            'inapplicable' => 'inapplicable',
            default => 'unsupported',
        };

        $unit = $per = $amount = $currency = null;
        if ($disposition === 'priced') {
            foreach (['unit', 'per', 'amount', 'currency'] as $name) {
                if (!array_key_exists($name, $m)) {
                    $this->shape->bad($path, 'a priced rate needs "' . $name . '"');
                }
            }
            if (array_key_exists('reason', $m)) {
                $this->shape->bad($path, 'a priced rate has no "reason"');
            }
            $amountText = $m['amount'];
            if (!is_string($amountText) || !Amount::isValid($amountText)) {
                $this->shape->fail(ErrorCode::InvalidAmount, $path . '.amount', 'must be a decimal string of NUM-1');
            }
            $amount = Amount::canonical($amountText);
            $per = $m['per'];
            if (!is_int($per) || !in_array($per, Vocab::PERS, true)) {
                $this->shape->fail(ErrorCode::InvalidPer, $path . '.per', 'must be a power of ten from 1 to 10^9');
            }
            $currency = $this->shape->string($m['currency'], $path . '.currency');
            if (Vocab::exponent($currency) === null) {
                $this->shape->fail(ErrorCode::UnknownCurrency, $path . '.currency', '"' . $currency . '" is not a currency of schema 1.0.0');
            }
            $unit = $this->shape->string($m['unit'], $path . '.unit');
            if (!Vocab::isUnit($unit)) {
                $this->shape->fail(ErrorCode::UnknownUnit, $path . '.unit', '"' . $unit . '" is not a unit of schema 1.0.0');
            }
            if (!Vocab::unitFitsComponent($unit, $component)) {
                $this->shape->fail(ErrorCode::UnitMismatch, $path . '.unit', $unit . ' is not a unit of the dimension of ' . $component);
            }
        } else {
            foreach (['unit', 'per', 'amount', 'currency'] as $name) {
                if (array_key_exists($name, $m)) {
                    $this->shape->bad($path, 'a ' . $disposition . ' rate has no "' . $name . '"');
                }
            }
            if (!array_key_exists('reason', $m)) {
                $this->shape->bad($path, 'a ' . $disposition . ' rate needs "reason"');
            }
            $this->shape->string($m['reason'], $path . '.reason', 1);
        }

        $condition = array_key_exists('condition', $m) ? $this->condition($m['condition'], $path . '.condition') : null;
        $validFrom = $fromMs = $validUntil = $untilMs = null;
        if (array_key_exists('validFrom', $m)) {
            [$validFrom, $fromMs] = $this->instant($m['validFrom'], $path . '.validFrom');
        }
        if (array_key_exists('validUntil', $m)) {
            [$validUntil, $untilMs] = $this->instant($m['validUntil'], $path . '.validUntil');
        }
        $this->provenance($m['provenance'], $path . '.provenance', true);

        return new Rate($component, $disposition, $unit, $per, $amount, $currency, $condition, $validFrom, $validUntil, $fromMs, $untilMs);
    }

    /** COND-1: `{ "inputTokens": { "gt"?, "lte"? } }` with at least one bound, and `gt < lte` when both. */
    private function condition(mixed $value, string $path): Condition
    {
        $m = $this->shape->object($value, $path, ['inputTokens']);
        $bounds = $this->shape->object($m['inputTokens'], $path . '.inputTokens', [], ['gt', 'lte']);
        if ($bounds === []) {
            $this->shape->bad($path . '.inputTokens', 'needs "gt" or "lte"');
        }
        $gt = array_key_exists('gt', $bounds) ? $this->shape->nonNegativeInteger($bounds['gt'], $path . '.inputTokens.gt', Vocab::BOUND) : null;
        $lte = array_key_exists('lte', $bounds) ? $this->shape->nonNegativeInteger($bounds['lte'], $path . '.inputTokens.lte', Vocab::BOUND) : null;
        if ($gt !== null && $lte !== null && $gt >= $lte) {
            $this->shape->bad($path . '.inputTokens', '"gt" must be below "lte"');
        }

        return new Condition($gt, $lte);
    }

    // ---------------------------------------------------------------- semantics of one offering

    /**
     * VAL-5, VAL-6, COND-2 to COND-5 and TIME-3 for one offering, in that order of rules.
     *
     * @param list<string>|null $conditionInputs
     * @param list<Rate>        $rates
     */
    private function offeringSemantics(string $path, string $tier, ?array $conditionInputs, array $rates): Offering
    {
        // TIME-3: a window runs forward.
        foreach ($rates as $i => $rate) {
            if ($rate->fromMs !== null && $rate->untilMs !== null && $rate->fromMs >= $rate->untilMs) {
                $this->shape->fail(ErrorCode::InvalidWindow, $path . '.rates[' . $i . ']', 'validFrom must be earlier than validUntil');
            }
        }

        // VAL-5, VAL-6: one currency; at least one priced entry.
        $currencies = [];
        foreach ($rates as $rate) {
            if ($rate->currency !== null) {
                $currencies[$rate->currency] = true;
            }
        }
        if ($currencies === []) {
            $this->shape->fail(ErrorCode::OfferingWithoutPrice, $path, 'has no priced rate');
        }
        if (count($currencies) > 1) {
            $this->shape->fail(ErrorCode::MixedCurrencies, $path, 'prices in more than one currency');
        }
        $currency = array_key_first($currencies);

        // COND-3: all or none.
        $conditioned = count(array_filter($rates, static fn(Rate $r): bool => $r->condition !== null));
        if ($conditioned !== 0 && $conditioned !== count($rates)) {
            $this->shape->fail(ErrorCode::ConditionsMixed, $path, 'some rates have a condition and some do not');
        }
        $hasConditions = $conditioned !== 0;

        // COND-2: conditionInputs go with conditions, name listed token components.
        if ($hasConditions !== ($conditionInputs !== null)) {
            $this->shape->fail(ErrorCode::ConditionInputsInvalid, $path, 'conditions and conditionInputs go together');
        }
        $listed = [];
        foreach ($rates as $rate) {
            $listed[$rate->component] = true;
        }
        if ($conditionInputs !== null) {
            foreach ($conditionInputs as $component) {
                if (!isset($listed[$component]) || !Vocab::isTokenComponent($component)) {
                    $this->shape->fail(ErrorCode::ConditionInputsInvalid, $path . '.conditionInputs', $component . ' must be a listed token component');
                }
            }
            sort($conditionInputs, SORT_STRING);
        }

        // COND-4 and COND-5: the distinct conditions partition [0, 2^53), with the same components.
        $conditions = $hasConditions ? $this->partition($path, $rates) : [null];
        foreach ($conditions as $condition) {
            $set = [];
            foreach ($rates as $rate) {
                if ($condition === null ? $rate->condition === null : ($rate->condition !== null && $rate->condition->sameAs($condition))) {
                    $set[$rate->component] = true;
                }
            }
            if (array_diff_key($listed, $set) !== []) {
                $this->shape->fail(ErrorCode::SchedulesMismatch, $path, 'every schedule must list the same components');
            }
        }

        // TIME-3: no two entries of one schedule and component are in force together.
        $this->windows($path, $rates);

        return new Offering($tier, $currency, $rates, $conditionInputs, $conditions);
    }

    /**
     * COND-4. The schedules sorted by lower bound must start open below, each next `gt` must equal
     * the previous `lte`, and the last must be open above. Overlap is reported before a gap.
     *
     * @param list<Rate> $rates
     *
     * @return non-empty-list<Condition>
     */
    private function partition(string $path, array $rates): array
    {
        $distinct = [];
        foreach ($rates as $rate) {
            if ($rate->condition === null) {
                continue;
            }
            $key = ($rate->condition->gt ?? 'n') . '/' . ($rate->condition->lte ?? 'n');
            $distinct[$key] = $rate->condition;
        }
        $schedules = array_values($distinct);
        usort($schedules, static fn(Condition $a, Condition $b): int => [$a->lowerKey(), $a->lte ?? PHP_INT_MAX] <=> [$b->lowerKey(), $b->lte ?? PHP_INT_MAX]);
        if ($schedules === []) {
            $this->shape->bad($path, 'no condition');
        }

        $gap = $schedules[0]->gt !== null;
        $n = count($schedules);
        for ($i = 1; $i < $n; ++$i) {
            $previous = $schedules[$i - 1];
            $next = $schedules[$i];
            if ($previous->lte === null || $next->gt === null || $next->gt < $previous->lte) {
                $this->shape->fail(ErrorCode::ConditionsNotExclusive, $path, 'the conditions overlap');
            }
            if ($next->gt > $previous->lte) {
                $gap = true;
            }
        }
        if ($schedules[$n - 1]->lte !== null) {
            $gap = true;
        }
        if ($gap) {
            $this->shape->fail(ErrorCode::ConditionsNotCovering, $path, 'the conditions leave inputs uncovered');
        }

        return $schedules;
    }

    /**
     * @param list<Rate> $rates
     */
    private function windows(string $path, array $rates): void
    {
        $groups = [];
        foreach ($rates as $rate) {
            $key = ($rate->condition === null ? '-' : ($rate->condition->gt ?? 'n') . '/' . ($rate->condition->lte ?? 'n')) . '|' . $rate->component;
            $groups[$key][] = $rate;
        }
        foreach ($groups as $group) {
            foreach ($group as $i => $a) {
                foreach (array_slice($group, $i + 1) as $b) {
                    $aStartsBeforeBEnds = $a->fromMs === null || $b->untilMs === null || $a->fromMs < $b->untilMs;
                    $bStartsBeforeAEnds = $b->fromMs === null || $a->untilMs === null || $b->fromMs < $a->untilMs;
                    if ($aStartsBeforeBEnds && $bStartsBeforeAEnds) {
                        $this->shape->fail(ErrorCode::WindowsOverlap, $path, 'two entries of ' . $a->component . ' are in force together');
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- cross-references

    /**
     * ID-3 and ID-4, and TIER-1's provider prefix.
     *
     * @param list<ProviderEntry> $providers
     *
     * @return list<ProviderEntry>
     */
    private function semantics(array $providers): array
    {
        $seenProviders = [];
        foreach ($providers as $provider) {
            if (isset($seenProviders[$provider->id])) {
                $this->shape->fail(ErrorCode::DuplicateProvider, '$.providers', $provider->id . ' appears twice');
            }
            $seenProviders[$provider->id] = true;

            $modelIds = [];
            foreach ($provider->models as $entry) {
                if (isset($modelIds[$entry->model->id])) {
                    $this->shape->fail(ErrorCode::DuplicateModel, $provider->id, $entry->model->id . ' appears twice');
                }
                $modelIds[$entry->model->id] = true;
            }
            $aliasIds = [];
            foreach ($provider->models as $entry) {
                foreach ($entry->model->aliases as $alias) {
                    if (isset($aliasIds[$alias->id])) {
                        $this->shape->fail(ErrorCode::DuplicateAlias, $provider->id, $alias->id . ' appears twice');
                    }
                    $aliasIds[$alias->id] = true;
                    if ($alias->status === 'active' && isset($modelIds[$alias->id])) {
                        $this->shape->fail(ErrorCode::AliasCollision, $provider->id, 'the active alias ' . $alias->id . ' is also a model id');
                    }
                }
                $tiers = [];
                foreach ($entry->offerings as $offering) {
                    if (isset($tiers[$offering->tier])) {
                        $this->shape->fail(ErrorCode::DuplicateOffering, $provider->id . '/' . $entry->model->id, $offering->tier . ' appears twice');
                    }
                    $tiers[$offering->tier] = true;
                    if (!Vocab::tierBelongsTo($offering->tier, $provider->id)) {
                        $this->shape->fail(ErrorCode::TierProviderMismatch, $provider->id . '/' . $entry->model->id, $offering->tier . ' is not a tier of ' . $provider->id);
                    }
                }
            }
        }

        return $providers;
    }
}
