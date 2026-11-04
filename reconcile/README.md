# reconcile/

The reconciler and the steps of the update and release workflows. The rules it applies are in the
[update policy](../docs/update-policy.md); the release mechanics are in [versioning](../docs/versioning.md#releasing).

| File                | What it holds                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `policy.json`       | The factor (×1.5) and how many independent cross-checks must agree (1)                             |
| `acknowledged.json` | Standing provider-level observations a person accepted, each pinned by its observation key         |
| `src/model.ts`      | Whole facts, identity keys, current facts, exact ratios, the plan's types                          |
| `src/plan.ts`       | `reconcile()`: classes, cross-check eligibility and lineage, coverage, groups                      |
| `src/excerpt.ts`    | The excerpt check: the cited bytes contain the value they support                                  |
| `src/apply.ts`      | Building one partition's catalog, with TIME-6 and per-group validation                             |
| `src/tree.ts`       | Writing a tree: the catalog, its hash, the coverage table and exactly the evidence it cites        |
| `src/release.ts`    | The release restamp and its TIME-6 check, version numbers, release notes                           |
| `src/render.ts`     | The pull request and issue bodies                                                                  |
| `src/run.ts`        | A run directory: read every source, load a run, plan it                                            |
| `src/cli.ts`        | The commands the workflows run                                                                     |
| `src/github.ts`     | Branches, pull requests, statuses, issues and releases through `git` and `gh`; Node built-ins only |

## The commands

```
node reconcile/src/cli.ts read [--live] --run <dir>
node reconcile/src/cli.ts baseline
node reconcile/src/cli.ts plan --run <dir>
node reconcile/src/cli.ts build --run <dir> --partition confirmed|review [--commit]
node reconcile/src/cli.ts seal --run <dir> --partition confirmed|review
node reconcile/src/cli.ts issues --run <dir>
node reconcile/src/cli.ts release-prepare --dir <dir>
node reconcile/src/cli.ts release-seal --dir <dir>
node reconcile/src/github.ts propose|issues|release …
```

`update.yml` runs these in order:

1. `read`, `baseline`, `plan`, `build --partition confirmed --commit`, `npm run check`, `seal`;
2. `github.ts propose --partition confirmed`, then the release workflow;
3. `baseline`, `plan`, `build --partition review --commit`, `npm run check`, `seal`, `issues`;
4. `github.ts propose --partition review` and `github.ts issues`.

## A local dry run

```
npm run update:dry-run -- --out /tmp/catalog-dry-run          # on saved evidence
npm run update:dry-run -- --out /tmp/catalog-dry-run --live   # on today's public pages, no keys
```

The dry run runs the same sequence on a scratch copy of the repository's data: read, plan, build and
check the confirmed tree, restamp it as the release would, plan again on it, build and check the review
tree, and render the issues. It pushes, merges and files nothing. It writes:

- `confirmed-body.md` and `review-body.md`;
- `findings-issue.md` and one `unreadable-<source>.md` per unreadable source;
- `summary.txt`;
- the run directory.

The local check is the tree's data check; the workflow runs the full `npm run check`.

## The tests

- `test/reconcile.test.ts` — the reconciler on the saved pages, mutated and read by the real readers.
  Mutations change a price, remove a tracked row per provider, or change an acknowledged observation.
  - one scenario per class;
  - generic coverage;
  - acknowledgements;
  - lineage and eligibility;
  - the partition.
- `test/units.test.ts` — the factor's edge cases; structural changes; TIME-6 apply, and the tree with
  its evidence; the release restamp; the excerpt check; the JSON parser and both cross-check readers;
  the workflows' shape and command order; and the dry run on saved evidence.

All of them run on the seed: the frozen seed catalog and each URL's earliest saved body. They run inside
the update's own check, so they must not move with the data the update job changes.
