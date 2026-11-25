<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/** A model as the catalog lists it. It carries no money; prices come from {@see Catalog::price()}. */
final readonly class Model
{
    /**
     * @param list<Alias>  $aliases
     * @param list<string> $capabilities
     * @param list<string> $tiers        the tiers the model has an offering for
     * @param list<string>|null $inputModalities what the model accepts as input, in the order text, image, audio,
     *                                   video, pdf (MOD-1); null when the catalog states none, which is not
     *                                   "text only"
     */
    public function __construct(
        public string $provider,
        public string $id,
        public string $name,
        public array $aliases,
        public string $status,
        public array $capabilities,
        public ?string $retiresOn,
        public ?Effort $effort,
        public array $tiers,
        public ?array $inputModalities = null,
    ) {}
}
