// The readings sink: how a reader emits what it read.
//
// `Readings` collects rate/model/effort/observation readings, stamps the outcome and
// holds the reasons. Helpers keep the emitting code declarative: a reader builds the
// fact, passes the provenance, and the sink records it whole.
import type {
  EffortReading,
  ModelReading,
  ObservationReading,
  Provenance,
  RateReading,
  Reading,
  Reason,
} from "./reading.ts";

export class Readings {
  readonly provider: string;
  private readonly items: Reading[] = [];

  constructor(provider: string) {
    this.provider = provider;
  }

  get all(): Reading[] {
    return [...this.items];
  }

  push(reading: Reading): void {
    this.items.push(reading);
  }

  rate(
    args: Omit<RateReading, "kind" | "outcome" | "reasons" | "provider"> & {
      outcome?: RateReading["outcome"];
      reasons?: Reason[];
    },
  ): void {
    this.items.push({
      kind: "rate",
      provider: this.provider,
      outcome: args.outcome ?? "ok",
      reasons: args.reasons ?? [],
      ...args,
    });
  }

  model(
    args: Omit<ModelReading, "kind" | "outcome" | "reasons" | "provider"> & {
      outcome?: ModelReading["outcome"];
      reasons?: Reason[];
    },
  ): void {
    this.items.push({
      kind: "model",
      provider: this.provider,
      outcome: args.outcome ?? "ok",
      reasons: args.reasons ?? [],
      ...args,
    });
  }

  effort(
    args: Omit<EffortReading, "kind" | "outcome" | "reasons" | "provider"> & {
      outcome?: EffortReading["outcome"];
      reasons?: Reason[];
    },
  ): void {
    this.items.push({
      kind: "effort",
      provider: this.provider,
      outcome: args.outcome ?? "ok",
      reasons: args.reasons ?? [],
      ...args,
    });
  }

  /** A `needs-review`, `unreadable` or `not-configured` observation in scope the reader can name. */
  observe(args: Omit<ObservationReading, "kind" | "provider"> & { provenance?: Provenance }): void {
    this.items.push({ kind: "observation", provider: this.provider, ...args });
  }

  /** A `needs-review` for `subject` — shorthand for the common case. */
  review(
    subject: { modelId?: string; tier?: string; component?: string },
    reasons: Reason[],
    note?: string,
    provenance?: Provenance,
  ): void {
    const out: Omit<ObservationReading, "kind" | "provider"> = {
      outcome: "needs-review",
      reasons,
      ...subject,
    };
    if (note !== undefined) out.note = note;
    if (provenance !== undefined) out.provenance = provenance;
    this.observe(out);
  }
}
