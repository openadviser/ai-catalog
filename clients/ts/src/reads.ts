// Section 12, "Other reads": a provider's models, a model's aliases and effort levels. They carry no
// money. Each model is resolved by ID-1, ID-2 and ID-4.

import { type Catalog, dataOf } from "./catalog.ts";
import { fail } from "./errors.ts";
import type { Model, Provider } from "./model.ts";
import type { EffortLevel } from "./vocab.ts";

export interface ModelAlias {
  readonly id: string;
  readonly status: "active" | "retired";
}

export interface ModelEffort {
  /** Ascending, from `none` to `max` (EFF-1). */
  readonly levels: readonly EffortLevel[];
  readonly default: EffortLevel | null;
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly ModelAlias[];
  readonly status: "preview" | "available" | "deprecated" | "retired";
  /** `YYYY-MM-DD`, or `null`. */
  readonly retiresOn: string | null;
  readonly capabilities: readonly string[];
  /** The tiers the model has an offering for. */
  readonly tiers: readonly string[];
  /** `null` when the catalog states no effort levels for the model. */
  readonly effort: ModelEffort | null;
}

function providerOf(catalog: Catalog, id: string): Provider {
  const provider = dataOf(catalog).providers.get(id);
  if (provider === undefined) return fail("unknown-provider", `no provider "${id}"`);
  return provider;
}

function view(provider: Provider, model: Model): ModelInfo {
  return Object.freeze({
    provider: provider.id,
    id: model.id,
    name: model.name,
    aliases: Object.freeze(model.aliases.map((a) => Object.freeze({ id: a.id, status: a.status }))),
    status: model.status,
    retiresOn: model.retiresOn,
    capabilities: Object.freeze([...model.capabilities]),
    tiers: Object.freeze([...model.offerings.keys()]),
    effort:
      model.effort === null
        ? null
        : Object.freeze({
            levels: Object.freeze([...model.effort.levels]),
            default: model.effort.default,
          }),
  });
}

/** The ids of the providers in the catalog. */
export function providers(catalog: Catalog): string[] {
  return [...dataOf(catalog).providers.keys()];
}

/** A provider's models, in the catalog's order. Refuses an unknown provider (`unknown-provider`). */
export function models(catalog: Catalog, provider: string): readonly ModelInfo[] {
  const p = providerOf(catalog, provider);
  return Object.freeze(p.models.map((m) => view(p, m)));
}

/**
 * Resolves a model by id or alias (ID-1, ID-2, ID-4). A retired alias still resolves. Refuses with
 * `unknown-provider` or `unknown-model`.
 */
export function resolveModel(catalog: Catalog, provider: string, modelId: string): ModelInfo {
  const p = providerOf(catalog, provider);
  const model = p.modelsById.get(modelId) ?? p.modelsByAlias.get(modelId);
  if (model === undefined) return fail("unknown-model", `no model or alias "${modelId}"`);
  return view(p, model);
}

/** A model's effort levels, or `null` when the catalog states none. */
export function effort(catalog: Catalog, provider: string, modelId: string): ModelEffort | null {
  return resolveModel(catalog, provider, modelId).effort;
}
