// The reconciler: the baseline catalog and one run's readings in, a plan out.
//
// Every tracked fact, model entry, effort list and lifecycle entry the catalog holds is
// matched with the official readings by its whole identity. A difference is a change and
// gets one class:
//
//   confirmed      every eligible cross-check agrees, at least `minIndependent` lineage
//                  clusters of them do, and the change is within the factor;
//   single-source  a comparable change no eligible cross-check confirms (every effort,
//                  lifecycle and unpriced-reason change is one);
//   conflict       an eligible cross-check disagrees;
//   needs-review   a reader finding in tracked scope, a fact the catalog tracks that no
//                  reading yields ("tracked, not read"), a structural change (zero, a new
//                  fact, unit, per, currency, disposition, condition inputs; a window or
//                  condition change shows as a new fact beside a tracked, not read one),
//                  a change beyond the factor, a failed excerpt check, official readings
//                  that disagree, or a change inside a dated window already in force.
//
// `unreadable` sources are listed apart: they open issues, and the facts they would have
// yielded show up as "tracked, not read".
//
// Changes are grouped so that dependent facts stay together: every component and schedule
// of one offering in one window, and one model's effort or lifecycle. A group goes to the
// confirmed partition only when every item in it is a confirmed change and nothing blocks
// it. Everything else goes to review.
import { createHash } from "node:crypto";
import type {
  FactValue,
  Instant,
  ObservationReading,
  ReadReport,
  Reason,
} from "@openadviser/ai-catalog-readers-kit";
import { type BodyLookup, excerptReasons } from "./excerpt.ts";
import {
  type Acknowledgement,
  type Catalog,
  type CatalogFact,
  type ChangeClass,
  type CrossCheckEvaluation,
  changeRatio,
  currentFacts,
  type EffortReading,
  effortGroup,
  entryValue,
  factKey,
  type Group,
  type Informational,
  type Item,
  type ItemKind,
  isZero,
  lifecycleGroup,
  type ModelReading,
  type Op,
  type Plan,
  type Policy,
  type RateReading,
  type Ratio,
  type Reading,
  type ReportSummary,
  rateGroup,
  readingWindow,
  type Subject,
  samePrice,
  sameValue,
  type UnreadableSource,
  type Window,
} from "./model.ts";

export interface PlanInput {
  catalog: Catalog;
  catalogSha256: string;
  reports: ReadReport[];
  policy: Policy;
  acknowledgements: Acknowledgement[];
  now: Instant;
  lookup: BodyLookup;
}

/**
 * A stable key for an observation: the hash of everything it says, without the
 * evidence sha, offsets or read time, which change on every fetch of the same page.
 * An acknowledgement names this key, so a changed observation is raised again.
 */
export function observationKey(source: string, r: Reading): string {
  const o = r as ObservationReading;
  const content = {
    provider: r.provider,
    source: o.source ?? source,
    kind: r.kind,
    outcome: r.outcome,
    modelId: o.modelId ?? null,
    tier: o.tier ?? null,
    component: o.component ?? null,
    reasons: r.reasons.map((x) => ({ code: x.code, message: x.message })),
    note: o.note ?? null,
    url: r.provenance?.url ?? null,
    excerpt: r.provenance?.location?.excerpt ?? null,
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Sources whose lineages share an upstream are one cluster; returns the cluster count. */
export function lineageClusters(lineages: string[][]): number {
  const parent = lineages.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] as number;
    return i;
  };
  for (let i = 0; i < lineages.length; i += 1) {
    for (let j = i + 1; j < lineages.length; j += 1) {
      const a = lineages[i] as string[];
      const b = lineages[j] as string[];
      if (a.some((x) => b.includes(x))) parent[find(i)] = find(j);
    }
  }
  return new Set(lineages.map((_, i) => find(i))).size;
}

interface CrossCheckCandidate {
  source: string;
  lineage: string[];
  reading: RateReading;
  excerpt: Reason[];
}

function informationalOf(source: string, r: Reading, note?: string): Informational {
  const o = r as ObservationReading;
  const out: Informational = {
    source: o.source ?? source,
    provider: r.provider,
    kind: r.kind,
    outcome: r.outcome,
    reasons: r.reasons,
  };
  if (o.modelId !== undefined) out.modelId = o.modelId;
  if (o.tier !== undefined) out.tier = o.tier;
  if (o.component !== undefined) out.component = o.component;
  const n = note ?? o.note;
  if (n !== undefined) out.note = n;
  return out;
}

function describe(v: FactValue): string {
  return v.disposition === "priced"
    ? `${v.amount} ${v.currency} per ${v.per} ${v.unit}`
    : `${v.disposition} (${v.reason})`;
}

export function reconcile(input: PlanInput): Plan {
  const { catalog, policy, lookup } = input;
  // History and in-force windows are judged at the later of the readings' instant and the
  // baseline's publishedAt: an entry the baseline's own release closed (TIME-6 ends it at
  // that publishedAt) is history even when the release came after the readings, as when the
  // review tree is planned on main right after the confirmed merge was released.
  const now = [input.now, catalog.publishedAt].sort().at(-1) as Instant;
  const items: Item[] = [];
  const informational: Informational[] = [];
  const unreadable: UnreadableSource[] = [];
  const acknowledged: Plan["acknowledged"] = [];
  const unchanged: Record<string, number> = {};
  const ackByKey = new Map(input.acknowledgements.map((a) => [a.key, a]));

  const reports: ReportSummary[] = input.reports.map((r) => ({
    source: r.provider,
    role: r.role ?? "source-of-truth",
    lineage: r.lineage ?? [r.provider],
    mode: r.mode,
    readings: r.readings.length,
    sources: r.sources,
  }));

  // ---- cross-checks: indexed by whole fact identity ----
  const crossByKey = new Map<string, CrossCheckCandidate[]>();
  for (const report of input.reports.filter((r) => r.role === "cross-check")) {
    for (const r of report.readings) {
      if (r.kind === "observation" && r.outcome === "unreadable") {
        unreadable.push({
          source: r.source ?? report.provider,
          provider: report.provider,
          reasons: r.reasons,
        });
        continue;
      }
      if (r.kind !== "rate" || r.outcome !== "ok") {
        informational.push(informationalOf(report.provider, r));
        continue;
      }
      const key = factKey({ ...r, window: readingWindow(r) });
      const list = crossByKey.get(key) ?? [];
      list.push({
        source: report.provider,
        lineage: report.lineage ?? [report.provider],
        reading: r,
        excerpt: excerptReasons(r, lookup),
      });
      crossByKey.set(key, list);
    }
  }

  const evaluate = (
    key: string,
    after: FactValue,
    baselineReadAt: Instant | undefined,
    officialLineage: string[],
    /** The official definition of a conditional fact's input: which tokens are summed. */
    officialInputs: string[] | undefined,
  ): CrossCheckEvaluation[] =>
    (crossByKey.get(key) ?? []).map((c) => {
      let why: string | undefined;
      // A schedule is defined by its bound and by what the bound counts. A tracker that sums
      // other tokens selects other schedules for real requests, so it confirms nothing.
      const sameInputs =
        c.reading.condition === undefined ||
        (officialInputs !== undefined &&
          c.reading.conditionInputs !== undefined &&
          JSON.stringify([...c.reading.conditionInputs].sort()) ===
            JSON.stringify([...officialInputs].sort()));
      if (c.excerpt.length > 0)
        why = `excerpt check failed: ${c.excerpt.map((x) => x.message).join("; ")}`;
      else if (!sameInputs)
        why =
          c.reading.conditionInputs === undefined
            ? "a conditional price whose condition inputs the tracker does not state"
            : `its condition counts ${c.reading.conditionInputs.join(", ")}, not the official ${officialInputs?.join(", ") ?? "(unstated)"}`;
      else if (c.reading.revisedAt === undefined)
        why = "the tracker states no revision date for this entry";
      else if (baselineReadAt !== undefined && c.reading.revisedAt <= baselineReadAt)
        why = `revised ${c.reading.revisedAt}, not after the catalog's observation of the old value at ${baselineReadAt}`;
      else if (c.lineage.some((l) => officialLineage.includes(l)))
        why = "it shares the source of truth's lineage";
      const evaluation: CrossCheckEvaluation = {
        source: c.source,
        lineage: c.lineage,
        reading: c.reading,
        eligible: why === undefined,
        agrees: samePrice(after, c.reading.fact),
      };
      if (why !== undefined) evaluation.why = why;
      return evaluation;
    });

  const classOf = (
    reasons: Reason[],
    evaluations: CrossCheckEvaluation[],
    comparable: boolean,
  ): ChangeClass => {
    const eligible = evaluations.filter((e) => e.eligible);
    if (eligible.some((e) => !e.agrees)) return "conflict";
    if (reasons.length > 0) return "needs-review";
    const agreeing = eligible.filter((e) => e.agrees).map((e) => e.lineage);
    if (
      comparable &&
      agreeing.length > 0 &&
      lineageClusters(agreeing) >= policy.crossChecks.minIndependent
    )
      return "confirmed";
    return "single-source";
  };

  const facts = currentFacts(catalog, now);

  for (const provider of catalog.providers) {
    const report = input.reports.find(
      (r) => (r.role ?? "source-of-truth") === "source-of-truth" && r.provider === provider.id,
    );
    if (report === undefined) {
      unreadable.push({
        source: provider.id,
        provider: provider.id,
        reasons: [{ code: "no-report", message: "the reader produced no report in this run" }],
      });
    }
    const readings = report?.readings ?? [];
    const officialLineage = report?.lineage ?? [provider.id];
    const models = new Map(provider.models.map((m) => [m.id, m]));
    const trackedOffering = (modelId: string | undefined, tier: string | undefined) =>
      modelId !== undefined &&
      tier !== undefined &&
      (models.get(modelId)?.offerings.some((o) => o.tier === tier) ?? false);
    const offeringInputs = (modelId: string, tier: string): string[] | undefined =>
      models.get(modelId)?.offerings.find((o) => o.tier === tier)?.conditionInputs?.inputTokens;
    let same = 0;

    // ---- rates ----
    const official = new Map<string, RateReading[]>();
    const untracked = new Map<string, number>();
    for (const r of readings) {
      if (r.kind !== "rate") continue;
      if (!trackedOffering(r.modelId, r.tier)) {
        if (r.outcome === "ok") {
          const k = `${r.modelId} ${r.tier}`;
          untracked.set(k, (untracked.get(k) ?? 0) + 1);
        } else {
          informational.push(informationalOf(provider.id, r));
        }
        continue;
      }
      if (r.validUntil !== undefined && r.validUntil <= now) {
        informational.push(informationalOf(provider.id, r, "a window that has already ended"));
        continue;
      }
      const key = factKey({ ...r, window: readingWindow(r) });
      const list = official.get(key) ?? [];
      list.push(r);
      official.set(key, list);
    }
    for (const [k, n] of untracked) {
      const [modelId, tier] = k.split(" ");
      informational.push({
        source: provider.id,
        provider: provider.id,
        kind: "rate",
        outcome: "ok",
        ...(modelId !== undefined ? { modelId } : {}),
        ...(tier !== undefined ? { tier } : {}),
        reasons: [],
        note: `${n} rate(s) read; the catalog does not track this ${models.has(modelId ?? "") ? "offering" : "model"}`,
      });
    }

    const byKey = new Map<string, CatalogFact>();
    for (const f of facts) if (f.provider === provider.id) byKey.set(f.key, f);
    const keys = [...new Set([...byKey.keys(), ...official.keys()])].sort();
    for (const key of keys) {
      const fact = byKey.get(key);
      const rs = official.get(key) ?? [];
      const first = rs[0];
      const window: Window = fact?.window ?? (first !== undefined ? readingWindow(first) : {});
      const modelId = fact?.modelId ?? (first?.modelId as string);
      const tier = fact?.tier ?? (first?.tier as string);
      const component = fact?.component ?? (first?.component as string);
      const condition = fact?.condition ?? first?.condition;
      const subject: Subject = { provider: provider.id, modelId, tier, component, window };
      if (condition !== undefined) subject.condition = condition;
      const group = rateGroup(provider.id, modelId, tier, window);
      const before =
        fact !== undefined
          ? { value: entryValue(fact.entry), provenance: fact.entry.provenance }
          : undefined;
      const base = (kind: ItemKind, reasons: Reason[], official_: Reading[]): Item => {
        const item: Item = {
          id: `${kind}|${key}`,
          kind,
          class: "needs-review",
          reasons,
          subject,
          group,
          official: official_,
          crossChecks: [],
        };
        if (before !== undefined) item.before = before;
        return item;
      };

      const bad = rs.filter((r) => r.outcome !== "ok");
      if (bad.length > 0) {
        items.push(
          base(
            "reader",
            bad.flatMap((r) => r.reasons),
            bad,
          ),
        );
        continue;
      }
      if (rs.length === 0) {
        items.push(
          base(
            "tracked-not-read",
            [
              {
                code: "tracked-not-read",
                message: "the catalog holds this fact, and no official reading yields it",
              },
            ],
            [],
          ),
        );
        continue;
      }
      const excerpt = rs.flatMap((r) => excerptReasons(r, lookup));
      if (excerpt.length > 0) {
        items.push(base("excerpt", excerpt, rs));
        continue;
      }
      const reading = rs[0] as RateReading;
      if (rs.some((r) => !sameValue(r.fact, reading.fact))) {
        items.push(
          base(
            "official-disagree",
            [
              {
                code: "official-disagree",
                message: `official readings disagree: ${rs.map((r) => describe(r.fact)).join(" / ")}`,
              },
            ],
            rs,
          ),
        );
        continue;
      }
      const after = { value: reading.fact, provenance: reading.provenance };
      if (fact === undefined) {
        const item = base(
          "new-fact",
          [{ code: "new-fact", message: "a fact the catalog does not hold yet" }],
          rs,
        );
        item.after = after;
        item.crossChecks = evaluate(
          key,
          reading.fact,
          undefined,
          officialLineage,
          reading.conditionInputs ?? offeringInputs(modelId, tier),
        );
        item.class = classOf(item.reasons, item.crossChecks, false);
        item.op = { type: "rate-add", provider: provider.id, modelId, tier, reading };
        items.push(item);
        continue;
      }
      const old = entryValue(fact.entry);
      if (sameValue(old, reading.fact)) {
        same += 1;
        continue;
      }
      const reasons: Reason[] = [];
      let kind: ItemKind;
      let ratio: Ratio | undefined;
      if (old.disposition === "priced" && reading.fact.disposition === "priced") {
        const now_ = reading.fact;
        if (old.unit !== now_.unit || old.per !== now_.per || old.currency !== now_.currency) {
          kind = "structural";
          reasons.push({
            code: "structural",
            message: `a change of unit, per or currency: ${describe(old)} → ${describe(now_)}`,
          });
        } else if (isZero(old.amount) || isZero(now_.amount)) {
          kind = "structural";
          reasons.push({
            code: "zero",
            message: `a change to or from zero: ${old.amount} → ${now_.amount}`,
          });
        } else {
          kind = "amount";
          ratio = changeRatio(old.amount, now_.amount, policy.factor);
          if (!ratio.within)
            reasons.push({
              code: "beyond-factor",
              message: `the ratio ${ratio.fraction} (${ratio.decimal}) is beyond the factor ×${policy.factor}`,
            });
        }
      } else if (old.disposition !== reading.fact.disposition) {
        kind = "structural";
        reasons.push({
          code: "disposition",
          message: `a change of disposition: ${describe(old)} → ${describe(reading.fact)}`,
        });
      } else {
        kind = "unpriced-reason";
      }
      let op: Op | undefined;
      if (window.from === undefined && window.until === undefined) {
        op = { type: "rate-split", index: fact.index, entry: fact.entry, reading };
      } else if (window.from !== undefined && window.from > now) {
        op = { type: "rate-replace", index: fact.index, entry: fact.entry, reading };
      } else {
        reasons.push({
          code: "in-force-window",
          message:
            "a change inside a dated window already in force: the schema cannot record an undated change there, so a person decides",
        });
      }
      const item = base(kind, reasons, rs);
      item.after = after;
      item.crossChecks = evaluate(
        key,
        reading.fact,
        fact.entry.provenance.readAt,
        officialLineage,
        reading.conditionInputs ?? offeringInputs(modelId, tier),
      );
      item.class = classOf(reasons, item.crossChecks, kind === "amount");
      if (ratio !== undefined) item.ratio = ratio;
      if (op !== undefined) item.op = op;
      items.push(item);
    }

    // ---- condition inputs, where the source states them ----
    for (const m of provider.models) {
      for (const o of m.offerings) {
        const stated = new Set(
          readings
            .filter(
              (r): r is RateReading =>
                r.kind === "rate" &&
                r.modelId === m.id &&
                r.tier === o.tier &&
                r.conditionInputs !== undefined,
            )
            .map((r) => JSON.stringify(r.conditionInputs)),
        );
        if (stated.size === 0) {
          // Generic coverage: the catalog defines which tokens select the schedule, and no
          // official reading states that definition any more. Every window of the offering
          // waits, because every conditional price depends on it.
          if (o.conditionInputs !== undefined) {
            items.push({
              id: `tracked-not-read|condition-inputs|${provider.id}|${m.id}|${o.tier}`,
              kind: "tracked-not-read",
              class: "needs-review",
              reasons: [
                {
                  code: "tracked-not-read",
                  message:
                    "the catalog holds this offering's condition inputs, and no official reading states them",
                },
              ],
              subject: {
                provider: provider.id,
                modelId: m.id,
                tier: o.tier,
                component: "conditionInputs",
              },
              group: rateGroup(provider.id, m.id, o.tier, {}),
              blocks: { provider: provider.id, modelId: m.id, tier: o.tier },
              before: { value: o.conditionInputs },
              official: [],
              crossChecks: [],
            });
          }
          continue;
        }
        const current =
          o.conditionInputs === undefined
            ? undefined
            : JSON.stringify(o.conditionInputs.inputTokens);
        if (stated.size === 1 && current !== undefined && stated.has(current)) continue;
        const subject: Subject = {
          provider: provider.id,
          modelId: m.id,
          tier: o.tier,
          component: "conditionInputs",
        };
        const inputs = JSON.parse([...stated][0] as string) as string[];
        const item: Item = {
          id: `condition-inputs|${provider.id}|${m.id}|${o.tier}`,
          kind: "condition-inputs",
          class: "needs-review",
          reasons: [
            {
              code: "condition-inputs",
              message:
                stated.size > 1
                  ? `the official readings state ${stated.size} different condition inputs`
                  : `the condition inputs change: ${current ?? "none"} → ${[...stated][0]}`,
            },
          ],
          subject,
          group: rateGroup(provider.id, m.id, o.tier, {}),
          // The condition inputs belong to the whole offering: every window's prices depend on
          // them, so the change holds every group of the offering for a person.
          blocks: { provider: provider.id, modelId: m.id, tier: o.tier },
          official: [],
          crossChecks: [],
        };
        if (current !== undefined) item.before = { value: o.conditionInputs };
        if (stated.size === 1) {
          item.after = { value: { inputTokens: inputs } };
          item.op = {
            type: "condition-inputs",
            provider: provider.id,
            modelId: m.id,
            tier: o.tier,
            inputs,
          };
        }
        items.push(item);
      }
    }

    // ---- effort and lifecycle ----
    for (const m of provider.models) {
      const efforts = readings.filter(
        (r): r is EffortReading => r.kind === "effort" && r.modelId === m.id,
      );
      const eg = effortGroup(provider.id, m.id);
      const subject: Subject = { provider: provider.id, modelId: m.id, component: "effort" };
      const effortItem = (kind: ItemKind, reasons: Reason[], rs: Reading[]): Item => {
        const item: Item = {
          id: `${kind}|${eg}`,
          kind,
          class: "needs-review",
          reasons,
          subject,
          group: eg,
          official: rs,
          crossChecks: [],
        };
        if (m.effort !== undefined)
          item.before = {
            value: { levels: m.effort.levels, default: m.effort.default },
            provenance: m.effort.provenance,
          };
        return item;
      };
      const badEffort = efforts.filter((r) => r.outcome !== "ok");
      const okEffort = efforts.filter((r) => r.outcome === "ok");
      if (badEffort.length > 0)
        items.push(
          effortItem(
            "reader",
            badEffort.flatMap((r) => r.reasons),
            badEffort,
          ),
        );
      else if (okEffort.length === 0) {
        if (m.effort !== undefined)
          items.push(
            effortItem(
              "tracked-not-read",
              [
                {
                  code: "tracked-not-read",
                  message: "the catalog holds an effort list, and no official reading yields it",
                },
              ],
              [],
            ),
          );
      } else {
        const excerpt = okEffort.flatMap((r) => excerptReasons(r, lookup));
        const value = (r: EffortReading) =>
          JSON.stringify({ levels: r.levels, default: r.default });
        const values = new Set(okEffort.map(value));
        const reading = okEffort[0] as EffortReading;
        if (excerpt.length > 0) items.push(effortItem("excerpt", excerpt, okEffort));
        else if (values.size > 1)
          items.push(
            effortItem(
              "official-disagree",
              [
                {
                  code: "official-disagree",
                  message: `official effort readings disagree: ${[...values].join(" / ")}`,
                },
              ],
              okEffort,
            ),
          );
        else if (
          m.effort === undefined ||
          value(reading) !== JSON.stringify({ levels: m.effort.levels, default: m.effort.default })
        ) {
          const reasons: Reason[] =
            m.effort === undefined
              ? [{ code: "new-fact", message: "an effort list the catalog does not hold yet" }]
              : [];
          const item = effortItem("effort", reasons, okEffort);
          item.after = {
            value: { levels: reading.levels, default: reading.default },
            provenance: reading.provenance,
          };
          // Effort levels have no independent cross-check: a change is single-source at best.
          item.class = reasons.length > 0 ? "needs-review" : "single-source";
          item.op = { type: "effort", provider: provider.id, modelId: m.id, reading };
          items.push(item);
        } else {
          same += 1;
        }
      }

      const lg = lifecycleGroup(provider.id, m.id);
      const modelReadings = readings.filter(
        (r): r is ModelReading => r.kind === "model" && r.modelId === m.id,
      );
      const lsubject: Subject = { provider: provider.id, modelId: m.id, component: "lifecycle" };
      const lifeItem = (
        kind: ItemKind,
        reasons: Reason[],
        rs: Reading[],
        before?: unknown,
      ): Item => {
        const item: Item = {
          id: `${kind}|${lg}`,
          kind,
          class: "needs-review",
          reasons,
          subject: lsubject,
          group: lg,
          official: rs,
          crossChecks: [],
        };
        if (before !== undefined)
          item.before = {
            value: before,
            ...(m.statusProvenance !== undefined ? { provenance: m.statusProvenance } : {}),
          };
        return item;
      };
      const badModel = modelReadings.filter((r) => r.outcome !== "ok");
      const okModel = modelReadings.filter((r) => r.outcome === "ok");
      if (badModel.length > 0) {
        items.push(
          lifeItem(
            "reader",
            badModel.flatMap((r) => r.reasons),
            badModel,
          ),
        );
        continue;
      }
      if (okModel.length === 0) {
        items.push(
          lifeItem(
            "tracked-not-read",
            [
              {
                code: "tracked-not-read",
                message: "the catalog lists this model, and no official reading names it",
              },
            ],
            [],
            { status: m.status },
          ),
        );
        continue;
      }
      const excerpt = okModel.flatMap((r) => excerptReasons(r, lookup));
      if (excerpt.length > 0) {
        items.push(lifeItem("excerpt", excerpt, okModel));
        continue;
      }
      const withStatus = okModel.filter((r) => r.status !== undefined);
      const statuses = new Set(withStatus.map((r) => r.status));
      if (withStatus.length === 0) {
        items.push(
          lifeItem(
            "tracked-not-read",
            [
              {
                code: "tracked-not-read",
                message: "no official reading states this model's status",
              },
            ],
            okModel,
            { status: m.status },
          ),
        );
      } else if (statuses.size > 1) {
        items.push(
          lifeItem(
            "official-disagree",
            [
              {
                code: "official-disagree",
                message: `official readings disagree on the status: ${[...statuses].join(" / ")}`,
              },
            ],
            withStatus,
            { status: m.status },
          ),
        );
      } else {
        const r = withStatus[0] as ModelReading;
        if (r.status !== m.status) {
          const reasons: Reason[] = [];
          if (r.status === "retired" && (r.notice === undefined || r.notice === ""))
            reasons.push({
              code: "no-notice",
              message: "a retirement needs the provider's deprecation notice",
            });
          const item = lifeItem("status", reasons, [r], { status: m.status });
          item.after = {
            value: { status: r.status },
            provenance: r.statusProvenance ?? r.provenance,
          };
          item.class = reasons.length > 0 ? "needs-review" : "single-source";
          item.op = {
            type: "lifecycle",
            provider: provider.id,
            modelId: m.id,
            status: r.status as string,
            provenance: r.statusProvenance ?? r.provenance,
          };
          item.id = `status|${lg}`;
          items.push(item);
        } else {
          same += 1;
        }
      }
      const dates = new Set(
        okModel.filter((r) => r.retiresOn !== undefined).map((r) => r.retiresOn),
      );
      if (dates.size > 1) {
        items.push({
          ...lifeItem(
            "official-disagree",
            [
              {
                code: "official-disagree",
                message: `official readings disagree on the retirement date: ${[...dates].join(" / ")}`,
              },
            ],
            okModel,
            { retiresOn: m.retiresOn },
          ),
          id: `official-disagree|retires-on|${lg}`,
        });
      } else if (dates.size === 0) {
        if (m.retiresOn !== undefined)
          items.push({
            ...lifeItem(
              "tracked-not-read",
              [
                {
                  code: "tracked-not-read",
                  message: "the catalog holds a retirement date, and no official reading states it",
                },
              ],
              [],
              { retiresOn: m.retiresOn },
            ),
            id: `tracked-not-read|retires-on|${lg}`,
          });
      } else {
        const date = [...dates][0] as string;
        const r = okModel.find((x) => x.retiresOn === date) as ModelReading;
        if (date !== m.retiresOn) {
          const item = lifeItem("retires-on", [], [r], { retiresOn: m.retiresOn ?? null });
          item.id = `retires-on|${lg}`;
          item.after = {
            value: { retiresOn: date },
            provenance: r.statusProvenance ?? r.provenance,
          };
          item.class = "single-source";
          item.op = {
            type: "lifecycle",
            provider: provider.id,
            modelId: m.id,
            retiresOn: date,
            provenance: r.statusProvenance ?? r.provenance,
          };
          items.push(item);
        }
      }
    }

    // ---- observations, and model and effort readings outside tracked scope ----
    for (const r of readings) {
      if (r.kind === "rate") continue;
      const tracked = r.modelId !== undefined && models.has(r.modelId);
      if ((r.kind === "effort" || r.kind === "model") && tracked) continue;
      if (r.kind !== "observation") {
        if (r.outcome !== "ok" || r.kind === "effort")
          informational.push(informationalOf(provider.id, r));
        continue;
      }
      if (r.outcome === "unreadable") {
        const u: UnreadableSource = {
          source: r.source ?? provider.id,
          provider: provider.id,
          reasons: r.reasons,
        };
        if (r.modelId !== undefined) u.modelId = r.modelId;
        unreadable.push(u);
        continue;
      }
      const info = informationalOf(provider.id, r);
      if (r.outcome === "ok") {
        informational.push(info);
        continue;
      }
      if (r.modelId === undefined) {
        const key = observationKey(provider.id, r);
        const ack = ackByKey.get(key);
        if (ack !== undefined) {
          acknowledged.push({ acknowledgement: ack, observation: info });
          continue;
        }
        items.push({
          id: `reader|${key}`,
          kind: "reader",
          class: "needs-review",
          reasons: r.reasons,
          subject: {
            provider: provider.id,
            ...(r.component !== undefined ? { component: r.component } : {}),
          },
          blocks: { provider: provider.id },
          official: [r],
          crossChecks: [],
        });
        continue;
      }
      if (tracked && (r.tier === undefined || trackedOffering(r.modelId, r.tier))) {
        const blocks: { provider: string; modelId?: string; tier?: string } = {
          provider: provider.id,
          modelId: r.modelId,
        };
        if (r.tier !== undefined) blocks.tier = r.tier;
        items.push({
          id: `reader|${observationKey(provider.id, r)}`,
          kind: "reader",
          class: "needs-review",
          reasons: r.reasons,
          subject: {
            provider: provider.id,
            modelId: r.modelId,
            ...(r.tier !== undefined ? { tier: r.tier } : {}),
            ...(r.component !== undefined ? { component: r.component } : {}),
          },
          blocks,
          official: [r],
          crossChecks: [],
        });
        continue;
      }
      informational.push(info);
    }
    unchanged[provider.id] = same;
  }

  // ---- groups ----
  const groups = new Map<string, Group>();
  for (const item of items) {
    if (item.group === undefined) continue;
    let g = groups.get(item.group);
    if (g === undefined) {
      const [kind, provider, modelId] = item.group.split("|") as [Group["kind"], string, string];
      g = { id: item.group, provider, modelId, kind, partition: "review", items: [], blockers: [] };
      groups.set(item.group, g);
    }
    g.items.push(item.id);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const g of groups.values()) {
    const tier = g.kind === "rate" ? g.id.split("|")[3] : undefined;
    for (const b of items) {
      if (b.blocks === undefined || b.blocks.provider !== g.provider) continue;
      if (b.blocks.modelId !== undefined && b.blocks.modelId !== g.modelId) continue;
      if (b.blocks.tier !== undefined && b.blocks.tier !== tier) continue;
      g.blockers.push(b.id);
    }
    const own = g.items.map((id) => byId.get(id) as Item);
    const allConfirmed = own.every((i) => i.class === "confirmed" && i.op !== undefined);
    g.partition = allConfirmed && g.blockers.length === 0 ? "confirmed" : "review";
  }

  return {
    now,
    baseline: {
      version: catalog.version,
      publishedAt: catalog.publishedAt,
      sha256: input.catalogSha256,
    },
    policy,
    reports,
    items,
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unreadable,
    acknowledged,
    informational,
    unchanged,
  };
}

/** The items of a plan that a person must look at although no tree change carries them. */
export function findingsWithoutChange(plan: Plan): Item[] {
  const reviewGroups = new Set(
    plan.groups.filter((g) => g.partition === "review").map((g) => g.id),
  );
  return plan.items.filter(
    (i) => i.op === undefined && (i.group === undefined || reviewGroups.has(i.group)),
  );
}
