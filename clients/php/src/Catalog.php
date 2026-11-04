<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use OpenAdviser\AiCatalog\Exception\LoadException;
use OpenAdviser\AiCatalog\Exception\PriceException;
use OpenAdviser\AiCatalog\Exception\SourceException;
use OpenAdviser\AiCatalog\Internal\BasisWriter;
use OpenAdviser\AiCatalog\Internal\CatalogValidator;
use OpenAdviser\AiCatalog\Internal\Engine;
use OpenAdviser\AiCatalog\Internal\Instant;
use OpenAdviser\AiCatalog\Internal\JsonFailure;
use OpenAdviser\AiCatalog\Internal\ModelEntry;
use OpenAdviser\AiCatalog\Internal\Offering;
use OpenAdviser\AiCatalog\Internal\ProviderEntry;
use OpenAdviser\AiCatalog\Internal\StrictJson;
use OpenAdviser\AiCatalog\Internal\Vocab;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use stdClass;

/**
 * A validated catalog. Instances exist only for bytes that passed every check of Section 14, so a
 * `Catalog` in hand is always a "last good" candidate: validation is all or nothing (VAL-1).
 *
 * ```php
 * $catalog = Catalog::loadFile('catalog.json', expectedSha256: $sha);
 * $price = $catalog->price(new PriceRequest('openai', 'gpt-6.1-sol', 'openai:standard', '2026-11-04T12:00:00Z', $usage, PriceRequest::BOOKED));
 * ```
 */
final class Catalog
{
    /**
     * @param list<ProviderEntry> $providers
     */
    private function __construct(
        public readonly string $schemaVersion,
        public readonly string $version,
        public readonly string $publishedAt,
        public readonly string $sha256,
        private readonly array $providers,
    ) {}

    /**
     * Loads catalog bytes. The checks run in this order, and the first failure rejects the whole
     * candidate:
     *
     * 1. the expected sha256, when given, against the bytes, before they are parsed (VAL-2);
     * 2. the raw text: well-formed JSON, no repeated member (JSON-1), integer literals only (JSON-2);
     * 3. the structure and the semantic rules (Section 14), each with the code of its own rule.
     *
     * @param string      $bytes          the catalog exactly as published; never re-serialize them, the digest names them
     * @param string|null $expectedSha256 for example the contents of `catalog.json.sha256`
     *
     * @throws LoadException
     */
    public static function load(string $bytes, ?string $expectedSha256 = null): self
    {
        $sha256 = hash('sha256', $bytes);
        if ($expectedSha256 !== null && !hash_equals($sha256, strtolower($expectedSha256))) {
            throw new LoadException(ErrorCode::HashMismatch, 'the bytes hash to ' . $sha256);
        }
        try {
            $document = StrictJson::decode($bytes);
        } catch (JsonFailure $e) {
            throw new LoadException(ErrorCode::InvalidJson, $e->getMessage());
        }
        $validated = CatalogValidator::validate($document);

        return new self($validated['schemaVersion'], $validated['version'], $validated['publishedAt'], $sha256, $validated['providers']);
    }

    /**
     * @throws LoadException   when the file's bytes are not an acceptable catalog
     * @throws SourceException when the file cannot be read
     */
    public static function loadFile(string $path, ?string $expectedSha256 = null): self
    {
        $bytes = @file_get_contents($path);
        if ($bytes === false) {
            throw new SourceException('cannot read ' . $path);
        }

        return self::load($bytes, $expectedSha256);
    }

    /**
     * Fetches a catalog with the caller's PSR-18 client and PSR-17 request factory. Only HTTP 200 is
     * accepted. The client owns redirects, timeouts and TLS; the digest is what makes the bytes
     * trustworthy, so pass `$expectedSha256` from a source you trust.
     *
     * @throws LoadException   when the response body is not an acceptable catalog
     * @throws SourceException when the request fails or the status is not 200
     */
    public static function loadUrl(ClientInterface $client, RequestFactoryInterface $requests, string $url, ?string $expectedSha256 = null): self
    {
        try {
            $response = $client->sendRequest($requests->createRequest('GET', $url));
        } catch (ClientExceptionInterface $e) {
            throw new SourceException('cannot fetch ' . $url . ': ' . $e->getMessage(), 0, $e);
        }
        if ($response->getStatusCode() !== 200) {
            throw new SourceException('fetching ' . $url . ' returned HTTP ' . $response->getStatusCode());
        }

        return self::load((string) $response->getBody(), $expectedSha256);
    }

    /** @return list<string> the ids of the providers in the catalog */
    public function providers(): array
    {
        return array_map(static fn(ProviderEntry $p): string => $p->id, $this->providers);
    }

    /**
     * The models of a provider, in catalog order.
     *
     * @return list<Model>
     *
     * @throws PriceException `unknown-provider`
     */
    public function models(string $provider): array
    {
        return array_map(static fn(ModelEntry $m): Model => $m->model, $this->provider($provider)->models);
    }

    /**
     * A model by id or alias (ID-1, ID-2, ID-4). A retired alias still resolves.
     *
     * @throws PriceException `unknown-provider` or `unknown-model`
     */
    public function model(string $provider, string $modelId): Model
    {
        return $this->resolve($provider, $modelId)->model;
    }

    /**
     * A model's effort levels and default, or null when the catalog lists none for it.
     *
     * @throws PriceException `unknown-provider` or `unknown-model`
     */
    public function effort(string $provider, string $modelId): ?Effort
    {
        return $this->resolve($provider, $modelId)->model->effort;
    }

    /**
     * Prices a call (PRICE-2). The steps run, and refuse, in the order the specification gives.
     * Nothing is returned for a call that cannot be priced exactly: there is no fallback tier, no
     * guessed quantity and no rounding of a component.
     *
     * @param PriceRequest|array<mixed>|stdClass|mixed $request a request, or the PHP value of a JSON request object
     *
     * @throws PriceException with the code of the first refusal; {@see Exception\UsageIncompleteException} adds `missing`
     */
    public function price(mixed $request): Price
    {
        // 1. The request and the instant. Anything that is not a request object, and every field of
        // the wrong type, is a specification refusal (API-1), never a language error.
        $request = $request instanceof PriceRequest ? $request : PriceRequest::fromArray($request);
        $provider = $request->provider;
        $modelId = $request->modelId;
        $tier = $request->tier;
        if (!is_string($provider) || !is_string($modelId) || !is_string($tier)) {
            throw new PriceException(ErrorCode::InvalidRequest, 'provider, modelId and tier must be strings');
        }
        $settlement = $request->settlement;
        if ($settlement !== PriceRequest::ESTIMATE && $settlement !== PriceRequest::BOOKED) {
            throw new PriceException(ErrorCode::InvalidRequest, 'settlement must be "estimate" or "booked"');
        }
        $unknown = false;
        if ($request->conditionInputs !== null) {
            if ($request->conditionInputs !== ['inputTokens' => 'unknown']) {
                throw new PriceException(ErrorCode::InvalidRequest, 'conditionInputs must be exactly {"inputTokens": "unknown"}');
            }
            $unknown = true;
        }
        $at = is_string($request->at) ? Instant::parse($request->at, true) : null;
        if ($at === null) {
            throw new PriceException(ErrorCode::InvalidInstant, '"at" must be a UTC instant with up to three fractional digits');
        }

        // 2. The model, then the offering. There is no fallback to another tier (TIER-2).
        $entry = $this->resolve($provider, $modelId);
        $offering = null;
        foreach ($entry->offerings as $candidate) {
            if ($candidate->tier === $tier) {
                $offering = $candidate;
                break;
            }
        }
        if (!$offering instanceof Offering) {
            throw new PriceException(ErrorCode::UnknownOffering, $entry->model->id . ' has no offering for ' . $tier);
        }

        // 3. The usage report: shape, then bound.
        $usage = $request->usage instanceof UsageReport ? $request->usage : UsageReport::fromArray($request->usage);

        // 4 to 10. The schedules at the instant, then the shared engine.
        $schedules = $offering->schedulesAt($at);
        $exponent = (int) Vocab::exponent($offering->currency);
        $figures = Engine::price($schedules, $offering->conditionInputs ?? [], $usage, $unknown, $exponent);

        // 11. The basis.
        $basis = BasisWriter::write(
            $this->version,
            $this->sha256,
            $provider,
            $entry->model->id,
            $modelId,
            $offering->tier,
            $offering->currency,
            $exponent,
            $settlement,
            $offering->conditionInputs,
            $schedules,
        );

        return new Price(
            $provider,
            $entry->model->id,
            $offering->tier,
            $offering->currency,
            $figures->schedule,
            $figures->exact,
            $figures->estimate,
            $figures->booked,
            $basis,
            hash('sha256', $basis),
        );
    }

    private function provider(string $provider): ProviderEntry
    {
        foreach ($this->providers as $entry) {
            if ($entry->id === $provider) {
                return $entry;
            }
        }

        throw new PriceException(ErrorCode::UnknownProvider, $provider);
    }

    /** ID-1, ID-2, ID-4: an exact model id wins over an alias, and an alias resolves whatever its status. */
    private function resolve(string $provider, string $modelId): ModelEntry
    {
        $entries = $this->provider($provider)->models;
        foreach ($entries as $entry) {
            if ($entry->model->id === $modelId) {
                return $entry;
            }
        }
        foreach ($entries as $entry) {
            foreach ($entry->model->aliases as $alias) {
                if ($alias->id === $modelId) {
                    return $entry;
                }
            }
        }

        throw new PriceException(ErrorCode::UnknownModel, $provider . '/' . $modelId);
    }
}
