<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use OpenAdviser\AiCatalog\Exception\PriceException;
use Psr\Clock\ClockInterface;
use stdClass;

/**
 * A price request (PRICE-1). The fields are held as given and checked by `price`, in the order
 * PRICE-2 sets, so that the first refusal is the one the specification names.
 */
final readonly class PriceRequest
{
    public const string ESTIMATE = 'estimate';

    public const string BOOKED = 'booked';

    /**
     * Every field is accepted as given and judged by `price`, so that a wrong type is a specification
     * refusal (`invalid-request`, or `invalid-instant` for `at`; API-1) and never a language error.
     *
     * @param mixed $provider        a string
     * @param mixed $modelId         a string, the model id or an alias
     * @param mixed $tier            a string such as `openai:standard`
     * @param mixed $at              the instant to price at: RFC 3339 UTC, `Z`, up to three fractional digits (TIME-1)
     * @param mixed $usage           a {@see UsageReport}, or the PHP value of one (see {@see UsageReport::fromArray()})
     * @param mixed $settlement      {@see self::ESTIMATE} or {@see self::BOOKED} (ROUND-4)
     * @param mixed $conditionInputs null, or exactly `['inputTokens' => 'unknown']` (COND-7)
     */
    public function __construct(
        public mixed $provider,
        public mixed $modelId,
        public mixed $tier,
        public mixed $at,
        public mixed $usage,
        public mixed $settlement,
        public mixed $conditionInputs = null,
    ) {}

    /**
     * A request from the PHP value of a JSON request object, such as a decoded body. Missing members
     * are null, and `price` refuses them; a member the request does not have is `invalid-request`.
     *
     * @throws PriceException `invalid-request` when `$data` is not an object or has an unknown member
     */
    public static function fromArray(mixed $data): self
    {
        $members = $data instanceof stdClass ? get_object_vars($data) : $data;
        if (!is_array($members) || ($members !== [] && array_is_list($members))) {
            throw new PriceException(ErrorCode::InvalidRequest, 'a price request is an object');
        }
        foreach (array_keys($members) as $name) {
            if (!in_array($name, ['provider', 'modelId', 'tier', 'at', 'usage', 'settlement', 'conditionInputs'], true)) {
                throw new PriceException(ErrorCode::InvalidRequest, 'unknown member "' . $name . '"');
            }
        }

        return new self(
            $members['provider'] ?? null,
            $members['modelId'] ?? null,
            $members['tier'] ?? null,
            $members['at'] ?? null,
            $members['usage'] ?? null,
            $members['settlement'] ?? null,
            $members['conditionInputs'] ?? null,
        );
    }

    /**
     * A request priced at the clock's current instant.
     *
     * @param UsageReport|array<mixed>|stdClass $usage
     * @param array<mixed>|null                 $conditionInputs
     */
    public static function now(
        ClockInterface $clock,
        string $provider,
        string $modelId,
        string $tier,
        UsageReport|array|stdClass $usage,
        string $settlement,
        ?array $conditionInputs = null,
    ): self {
        return new self($provider, $modelId, $tier, self::formatInstant($clock->now()), $usage, $settlement, $conditionInputs);
    }

    /** An instant in the form `at` takes: UTC, millisecond precision. */
    public static function formatInstant(DateTimeInterface $instant): string
    {
        return DateTimeImmutable::createFromInterface($instant)
            ->setTimezone(new DateTimeZone('UTC'))
            ->format('Y-m-d\TH:i:s.v\Z');
    }
}
