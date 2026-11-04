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
    ) {}
}
