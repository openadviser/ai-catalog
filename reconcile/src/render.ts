// The bodies people read: the two pull requests, the findings issue and one issue per
// unreadable source. Each change shows its class, the catalog's value and the official
// reading with their evidence links, every cross-check with its revision and eligibility,
// the ratio against the factor, and the reason. Plain GitHub Markdown.
import type { FactValue, Provenance, Reading } from "@openadviser/ai-catalog-readers-kit";
import type { BuiltPartition } from "./apply.ts";
import type {
  CrossCheckEvaluation,
  Group,
  Item,
  Plan,
  Subject,
  UnreadableSource,
} from "./model.ts";
import { findingsWithoutChange } from "./plan.ts";

/** GitHub refuses bodies over 65536 characters; this leaves room for the footer. */
const LIMIT = 60000;

export interface RenderContext {
  /** `owner/name`. */
  repo: string;
  /** The run's page, where its artifact is listed. */
  runUrl: string;
  /** The ref that holds the partition's evidence (the PR branch), and the baseline's. */
  ref: string;
  baseRef: string;
  dryRun: boolean;
}

export interface CheckResult {
  passed: boolean;
  /** The tree sha the check ran on. */
  tree: string;
  commit?: string;
  log?: string;
}

const MARK = {
  confirmed: "✅ confirmed",
  "single-source": "🟡 single-source",
  conflict: "🛑 conflict",
  "needs-review": "🔍 needs-review",
} as const;

function code(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const short = clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
  const ticks = short.includes("`") ? "``" : "`";
  return `${ticks}${short.replace(/\|/g, "\\|")}${ticks}`;
}

export function subjectLine(s: Subject): string {
  const parts = [s.provider, s.modelId, s.tier, s.component].filter((x) => x !== undefined);
  let out = parts.join(" / ");
  if (s.condition !== undefined) {
    const c = s.condition.inputTokens;
    out += ` [input tokens ${c.gt !== undefined ? `> ${c.gt}` : ""}${c.gt !== undefined && c.lte !== undefined ? " and " : ""}${c.lte !== undefined ? `≤ ${c.lte}` : ""}]`;
  }
  if (s.window !== undefined && (s.window.from !== undefined || s.window.until !== undefined))
    out += ` [${s.window.from ?? "…"} → ${s.window.until ?? "…"})`;
  return out;
}

export function valueText(v: unknown): string {
  if (v === undefined || v === null) return "—";
  const f = v as FactValue;
  if (typeof f === "object" && "disposition" in f) {
    return f.disposition === "priced"
      ? `${f.amount} ${f.currency} per ${f.per} ${f.unit}`
      : `${f.disposition}: ${f.reason}`;
  }
  return code(JSON.stringify(v));
}

function evidenceLink(ctx: RenderContext, ref: string, sha: string): string {
  return `[evidence/${sha.slice(0, 12)}…](https://github.com/${ctx.repo}/blob/${ref}/evidence/${sha})`;
}

/** A provenance line: page, read time, evidence link and the cited excerpt. */
function provenanceText(
  ctx: RenderContext,
  p: Provenance | undefined,
  ref: string | undefined,
): string {
  if (p === undefined) return "";
  const where =
    ref === undefined
      ? `evidence ${p.evidence.slice(0, 12)}… (run artifact)`
      : evidenceLink(ctx, ref, p.evidence);
  const loc =
    p.location !== undefined
      ? ` · ${code(p.location.path)} · excerpt ${code(p.location.excerpt)}`
      : "";
  const der = p.derivation !== undefined ? ` · derived: ${code(p.derivation.formula)}` : "";
  return `[${p.source}](${p.url}), read ${p.readAt} · ${where}${loc}${der}`;
}

function crossCheckText(e: CrossCheckEvaluation): string {
  const verdict = e.eligible
    ? e.agrees
      ? "eligible, **agrees**"
      : "eligible, **disagrees**"
    : `not eligible: ${e.why}`;
  const p = e.reading.provenance;
  const value = valueText(e.reading.fact);
  return `${e.source} (lineage ${e.lineage.join(", ")}): ${value}, revised ${e.reading.revisedAt ?? "—"} · [source](${p.url}) · excerpt ${code(p.location?.excerpt ?? "")} — ${verdict}`;
}

function readingRef(item: Item, ctx: RenderContext, committed: boolean): string | undefined {
  return item.op !== undefined && committed ? ctx.ref : undefined;
}

export function itemSection(item: Item, ctx: RenderContext, committed: boolean): string {
  const lines: string[] = [];
  lines.push(`#### ${MARK[item.class]} · ${item.kind} · ${subjectLine(item.subject)}`);
  if (item.before !== undefined)
    lines.push(
      `- **Catalog:** ${valueText(item.before.value)}${item.before.provenance !== undefined ? ` — ${provenanceText(ctx, item.before.provenance, ctx.baseRef)}` : ""}`,
    );
  if (item.after !== undefined)
    lines.push(
      `- **Read:** ${valueText(item.after.value)}${item.after.provenance !== undefined ? ` — ${provenanceText(ctx, item.after.provenance, readingRef(item, ctx, committed))}` : ""}`,
    );
  else if (item.official.length > 0)
    for (const r of item.official.slice(0, 3))
      lines.push(`- **Official reading:** ${officialText(ctx, r)}`);
  if (item.ratio !== undefined)
    lines.push(
      `- **Ratio:** ${item.ratio.fraction} (${item.ratio.decimal}), ${item.ratio.within ? "within" : "**beyond**"} the factor`,
    );
  if (item.crossChecks.length === 0 && item.after !== undefined)
    lines.push("- **Cross-checks:** none covers this fact");
  for (const e of item.crossChecks) lines.push(`- **Cross-check:** ${crossCheckText(e)}`);
  if (item.reasons.length > 0)
    lines.push(
      `- **Reason:** ${item.reasons.map((r) => `${r.message} (\`${r.code}\`)`).join("; ")}`,
    );
  else if (item.class === "confirmed")
    lines.push("- **Reason:** an eligible independent cross-check agrees, within the factor");
  else if (item.class === "single-source")
    lines.push("- **Reason:** no eligible independent cross-check confirms it");
  if (item.op === undefined)
    lines.push(
      "- **Not applied:** nothing in this change can be written to the catalog; a person decides",
    );
  return lines.join("\n");
}

function officialText(ctx: RenderContext, r: Reading): string {
  const p = (r as { provenance?: Provenance }).provenance;
  const what =
    r.kind === "rate"
      ? valueText(r.fact)
      : r.kind === "effort"
        ? code(JSON.stringify({ levels: r.levels, default: r.default }))
        : r.kind === "model"
          ? code(JSON.stringify({ status: r.status, retiresOn: r.retiresOn }))
          : `${r.outcome}: ${r.reasons.map((x) => x.message).join("; ")}`;
  return `${what}${p !== undefined ? ` — ${provenanceText(ctx, p, undefined)}` : ""}`;
}

function cap(body: string, runUrl: string): string {
  if (body.length <= LIMIT) return body;
  return `${body.slice(0, LIMIT)}\n\n…the body is cut here. The full text is \`body.md\` in the [run's artifact](${runUrl}).\n`;
}

function checkText(check: CheckResult | undefined, ctx: RenderContext): string {
  if (check === undefined) return "- **Check:** not run (no tree change).";
  const where = check.commit !== undefined ? ` on commit \`${check.commit}\`` : "";
  const tail =
    check.log !== undefined && !check.passed
      ? `\n\n<details><summary>Check log (tail)</summary>\n\n\`\`\`text\n${check.log.slice(-6000)}\n\`\`\`\n</details>`
      : "";
  return `- **Check:** \`npm ci && npm run check\` **${check.passed ? "passed" : "failed"}**${where}, tree \`${check.tree}\`, in [this run](${ctx.runUrl}). Pull requests opened with \`GITHUB_TOKEN\` start no CI, so the update workflow runs the full check on the exact tree it proposes.${tail}`;
}

function groupTitle(g: Group): string {
  const parts = g.id.split("|");
  if (g.kind === "rate") {
    const window = parts[4] === ".." ? "undated" : `window ${parts[4]}`;
    return `${g.provider} / ${g.modelId} / ${parts[3]} (${window})`;
  }
  return `${g.provider} / ${g.modelId} / ${g.kind}`;
}

function tableRow(i: Item): string {
  const before = i.before !== undefined ? valueText(i.before.value) : "—";
  const after = i.after !== undefined ? valueText(i.after.value) : "—";
  return `| ${MARK[i.class]} | ${subjectLine(i.subject).replace(/\|/g, "\\|")} | ${before.replace(/\|/g, "\\|")} | ${after.replace(/\|/g, "\\|")} |`;
}

function header(plan: Plan, ctx: RenderContext): string[] {
  return [
    `- **Baseline:** \`${plan.baseline.version}\` (published ${plan.baseline.publishedAt}, sha256 \`${plan.baseline.sha256.slice(0, 16)}…\`), the latest release.`,
    `- **Reconciled at:** ${plan.now}, [run](${ctx.runUrl}) — every source's bytes and readings are in the run's artifact (kept 90 days).`,
    `- **Policy:** factor ×${plan.policy.factor}; at least ${plan.policy.crossChecks.minIndependent} independent cross-check (lineage cluster) must agree.`,
  ];
}

export function partitionBody(
  plan: Plan,
  built: BuiltPartition,
  check: CheckResult | undefined,
  ctx: RenderContext,
): string {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const groups = plan.groups.filter((g) => g.partition === built.partition);
  const applied = new Set(built.applied);
  const lines: string[] = [];
  if (built.partition === "confirmed") {
    lines.push(
      "Changes the source of truth and at least one eligible independent cross-check agree on, within the factor. The update workflow merges this pull request when its check passes.",
    );
  } else {
    lines.push(
      "Changes that wait for a person: single-source, conflicting, structural, beyond the factor, or blocked by a finding in the same offering. The update workflow never merges this pull request.",
    );
  }
  if (ctx.dryRun) lines.push("", "> **Dry run.** Nothing was pushed, merged or filed.");
  lines.push("", ...header(plan, ctx));
  lines.push(
    `- **Stamp:** provisional \`version\` \`${built.version}\`, \`publishedAt\` ${built.stamp}. The release workflow restamps both, and every bound equal to this \`publishedAt\`, when it publishes.`,
  );
  lines.push(checkText(check, ctx));
  lines.push("", `### Groups (${groups.length})`);
  for (const g of groups) {
    const status = applied.has(g.id)
      ? "applied"
      : built.skipped.find((s) => s.group === g.id) !== undefined
        ? `**not applied**: ${built.skipped.find((s) => s.group === g.id)?.error}`
        : "no tree change";
    lines.push("", `<details open><summary><b>${groupTitle(g)}</b> — ${status}</summary>`, "");
    if (g.blockers.length > 0)
      lines.push(
        `Blocked by: ${g.blockers
          .map((b) =>
            code(
              byId
                .get(b)
                ?.reasons.map((r) => r.message)
                .join("; ") ?? b,
            ),
          )
          .join(", ")}`,
        "",
      );
    lines.push("| Class | Fact | Catalog | Read |", "| --- | --- | --- | --- |");
    for (const id of g.items) lines.push(tableRow(byId.get(id) as Item));
    lines.push("");
    for (const id of g.items)
      lines.push(itemSection(byId.get(id) as Item, ctx, applied.has(g.id)), "");
    lines.push("</details>");
  }
  if (built.partition === "review") {
    const loose = plan.items.filter((i) => i.group === undefined);
    if (loose.length > 0) {
      lines.push("", `### Findings that block a provider or model (${loose.length})`, "");
      for (const i of loose) lines.push(itemSection(i, ctx, false), "");
    }
  }
  lines.push(...footer(plan, ctx));
  return cap(lines.join("\n"), ctx.runUrl);
}

function footer(plan: Plan, ctx: RenderContext): string[] {
  const lines: string[] = [""];
  if (plan.unreadable.length > 0) {
    lines.push(`### Unreadable sources (${plan.unreadable.length})`, "");
    for (const u of plan.unreadable)
      lines.push(
        `- \`${u.source}\` (${u.provider}${u.modelId !== undefined ? `, ${u.modelId}` : ""}): ${u.reasons.map((r) => r.message).join("; ")}`,
      );
    lines.push(
      "",
      "Each has its own issue, closed when the source reads again or is no longer configured.",
      "",
    );
  }
  if (plan.acknowledged.length > 0) {
    lines.push(
      `<details><summary>Acknowledged standing observations (${plan.acknowledged.length})</summary>`,
      "",
    );
    for (const a of plan.acknowledged)
      lines.push(
        `- ${a.observation.provider} ${a.observation.component ?? ""}: ${a.observation.reasons.map((r) => r.message).join("; ")} — ${a.acknowledgement.reason} (acknowledged ${a.acknowledgement.acknowledgedOn})`,
      );
    lines.push("", "</details>", "");
  }
  if (plan.informational.length > 0) {
    lines.push(`<details><summary>Read, not tracked (${plan.informational.length})</summary>`, "");
    lines.push(
      "Readings outside the catalog's tracked models and offerings. They never open a pull request; adding a model or an offering is a person's pull request.",
      "",
    );
    for (const i of plan.informational.slice(0, 200))
      lines.push(
        `- ${i.provider} ${[i.modelId, i.tier, i.component].filter((x) => x !== undefined).join(" / ")}: ${i.note ?? i.reasons.map((r) => r.message).join("; ")}`,
      );
    if (plan.informational.length > 200)
      lines.push(`- …and ${plan.informational.length - 200} more in the run's artifact`);
    lines.push("", "</details>", "");
  }
  lines.push(
    `Unchanged facts: ${Object.entries(plan.unchanged)
      .map(([p, n]) => `${p} ${n}`)
      .join(", ")}.`,
    "",
    `<sub>Run ${ctx.runUrl}</sub>`,
  );
  return lines;
}

export const FINDINGS_TITLE = "Catalog review: findings without a change";
export const FINDINGS_MARKER = "<!-- ai-catalog:findings -->";

/** The body of the one findings issue: every item a person must see that no tree change carries. */
export function findingsBody(
  plan: Plan,
  ctx: RenderContext,
  notApplied: { group: string; error: string }[],
): string {
  const items = findingsWithoutChange(plan);
  const lines = [
    FINDINGS_MARKER,
    "Findings the catalog cannot carry as a change: facts the catalog holds that the source of truth no longer yields (tracked, not read), reader findings, failed excerpt checks, official readings that disagree, and changes inside a dated window already in force. A pull request cannot exist without a diff, so they are listed here. This issue is refreshed on every run and closed when the list is empty.",
    "",
    ...header(plan, ctx),
    "",
  ];
  if (notApplied.length > 0) {
    lines.push(`### Changes that could not be applied (${notApplied.length})`, "");
    for (const n of notApplied) lines.push(`- ${n.group}: ${n.error}`);
    lines.push("");
  }
  lines.push(`### Findings (${items.length})`, "");
  for (const i of items) lines.push(itemSection(i, ctx, false), "");
  lines.push(`<sub>Run ${ctx.runUrl}</sub>`);
  return cap(lines.join("\n"), ctx.runUrl);
}

export function unreadableTitle(source: string): string {
  return `Source unreadable: ${source}`;
}

export function unreadableMarker(source: string): string {
  return `<!-- ai-catalog:unreadable:${source} -->`;
}

export function unreadableBody(u: UnreadableSource[], ctx: RenderContext): string {
  const first = u[0] as UnreadableSource;
  return [
    unreadableMarker(first.source),
    `The source \`${first.source}\` (${first.provider}) could not be read in the latest run. The catalog keeps its last version of every value this source supplies; those facts show as "tracked, not read" in the findings. This issue is closed when the source reads again or is no longer configured.`,
    "",
    ...u.map(
      (x) =>
        `- ${x.modelId !== undefined ? `${x.modelId}: ` : ""}${x.reasons.map((r) => `${r.message} (\`${r.code}\`)`).join("; ")}`,
    ),
    "",
    `Latest run: ${ctx.runUrl} (the run's artifact holds the readings).`,
  ].join("\n");
}

/** The run's one-screen summary, for the workflow's step summary and the console. */
export function summary(plan: Plan): string {
  const count = (p: "confirmed" | "review") => plan.groups.filter((g) => g.partition === p).length;
  const byClass = new Map<string, number>();
  for (const i of plan.items) byClass.set(i.class, (byClass.get(i.class) ?? 0) + 1);
  return [
    `Baseline ${plan.baseline.version}, reconciled at ${plan.now}.`,
    `Items: ${plan.items.length} (${[...byClass].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`,
    `Groups: ${count("confirmed")} confirmed, ${count("review")} review.`,
    `Unreadable sources: ${plan.unreadable.length}. Acknowledged: ${plan.acknowledged.length}. Not tracked: ${plan.informational.length}.`,
    ...(plan.notConfigured ?? []).map(
      (n) => `${n.source}: not configured${n.env !== undefined ? ` (${n.env} not set)` : ""}`,
    ),
  ].join("\n");
}
