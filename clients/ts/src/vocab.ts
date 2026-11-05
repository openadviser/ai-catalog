// The closed vocabularies of schema 1.1.0 (specification Sections 4 to 8).

export const COMPONENTS = [
  "input",
  "input_cached",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_30m",
  "cache_write_12h",
  "output",
  "output_audio",
  "characters",
  "output_audio_duration",
  "web_search",
  "file_search",
  "grounding_search",
  "grounding_maps",
  "generation",
  "code_execution",
  "containers",
  "cache_storage",
  "file_search_storage",
] as const;
export type Component = (typeof COMPONENTS)[number];

export type Dimension =
  | "tokens"
  | "characters"
  | "requests"
  | "duration"
  | "token-time"
  | "storage";

/** COMP-1: each component's dimension, and whether a single call reports it. */
const COMPONENT_TABLE: Record<Component, { dimension: Dimension; perCall: boolean }> = {
  input: { dimension: "tokens", perCall: true },
  input_cached: { dimension: "tokens", perCall: true },
  cache_write_5m: { dimension: "tokens", perCall: true },
  cache_write_1h: { dimension: "tokens", perCall: true },
  cache_write_30m: { dimension: "tokens", perCall: true },
  cache_write_12h: { dimension: "tokens", perCall: true },
  output: { dimension: "tokens", perCall: true },
  output_audio: { dimension: "tokens", perCall: true },
  characters: { dimension: "characters", perCall: true },
  output_audio_duration: { dimension: "duration", perCall: true },
  web_search: { dimension: "requests", perCall: true },
  file_search: { dimension: "requests", perCall: true },
  grounding_search: { dimension: "requests", perCall: true },
  grounding_maps: { dimension: "requests", perCall: true },
  generation: { dimension: "requests", perCall: true },
  code_execution: { dimension: "duration", perCall: true },
  containers: { dimension: "duration", perCall: true },
  cache_storage: { dimension: "token-time", perCall: false },
  file_search_storage: { dimension: "storage", perCall: false },
};

/** COMP-1: the components added after 1.0.0, which a document declaring 1.0.x does not know. */
export const ADDED_AFTER_1_0: readonly Component[] = ["generation"];

export function isComponent(value: unknown): value is Component {
  return typeof value === "string" && Object.hasOwn(COMPONENT_TABLE, value);
}
export function dimensionOfComponent(component: Component): Dimension {
  return COMPONENT_TABLE[component].dimension;
}
export function isPerCall(component: Component): boolean {
  return COMPONENT_TABLE[component].perCall;
}

export const METERS = ["token", "character", "request", "millisecond"] as const;
export type Meter = (typeof METERS)[number];

/** UNIT-1: the dimension, the meter and the factor (meter units per unit) of each unit. */
const UNIT_TABLE = {
  token: { dimension: "tokens", meter: "token", factor: 1 },
  character: { dimension: "characters", meter: "character", factor: 1 },
  request: { dimension: "requests", meter: "request", factor: 1 },
  millisecond: { dimension: "duration", meter: "millisecond", factor: 1 },
  second: { dimension: "duration", meter: "millisecond", factor: 1000 },
  minute: { dimension: "duration", meter: "millisecond", factor: 60000 },
  hour: { dimension: "duration", meter: "millisecond", factor: 3600000 },
  "token-hour": { dimension: "token-time", meter: null, factor: null },
} as const satisfies Record<
  string,
  { dimension: Dimension; meter: Meter | null; factor: number | null }
>;
export type Unit = keyof typeof UNIT_TABLE;

export function isUnit(value: unknown): value is Unit {
  return typeof value === "string" && Object.hasOwn(UNIT_TABLE, value);
}
export function unitInfo(unit: Unit): {
  dimension: Dimension;
  meter: Meter | null;
  factor: number | null;
} {
  return UNIT_TABLE[unit];
}
export const FACTORS = [1, 1000, 60000, 3600000] as const;

/** NUM-2. */
export const PER_VALUES = [
  1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000,
] as const;
export function isPer(value: unknown): value is number {
  return typeof value === "number" && (PER_VALUES as readonly number[]).includes(value);
}

/** ROUND-1: currency to minor-unit exponent. */
const CURRENCY_TABLE = { USD: 2, EUR: 2, GBP: 2 } as const;
export type Currency = keyof typeof CURRENCY_TABLE;
export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && Object.hasOwn(CURRENCY_TABLE, value);
}
export function exponentOf(currency: Currency): number {
  return CURRENCY_TABLE[currency];
}

export const PROVIDER_IDS = ["anthropic", "openai", "google-gemini", "elevenlabs"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** TIER-1. */
export const TIERS = [
  "anthropic:standard",
  "anthropic:batch",
  "openai:standard",
  "google-gemini:standard",
  "elevenlabs:pay-as-you-go",
] as const;
export type Tier = (typeof TIERS)[number];
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** EFF-1, in ascending order. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const CAPABILITIES = [
  "text-generation",
  "speech-synthesis",
  "music-generation",
  "sound-effects-generation",
] as const;

/** 2^53, the exclusive bound of quantities and condition bounds (NUM-3, COND-1). */
export const TWO_53 = 9007199254740992n;
export const MAX_SAFE = 9007199254740991;
