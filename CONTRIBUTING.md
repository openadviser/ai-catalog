# Contributing

Thank you for helping keep AI prices correct. This project is small and the rules are short.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Questions go to
[Discussions](SUPPORT.md); the issue tracker is for work that can be acted on.

## Setup

You need the Node.js version in [`.nvmrc`](.nvmrc) (the current LTS, Node 26) and npm, which comes with it.

```sh
git clone https://github.com/openadviser/ai-catalog.git
cd ai-catalog
npm ci
npm run check
```

| Command                  | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run check`          | Everything CI runs: typecheck, lint, test, link check, coverage-table check |
| `npm run typecheck`      | TypeScript in strict mode, no output                                        |
| `npm run lint`           | Biome lint and format check                                                 |
| `npm run format`         | Biome: fix formatting and import order                                      |
| `npm test`               | Vitest                                                                      |
| `npm run links`          | Checks relative links and anchors in the Markdown files, offline            |
| `npm run coverage:table` | Regenerates the coverage table in the README from `data/`                   |

The PHP client has its own toolchain, which arrives with it (see [`clients/php/`](clients/php/)).

## Report a wrong or missing price

Open a _Wrong or missing price_ issue. The form asks for what we need to check it:

- the **URL of the provider's page** that shows the price, and
- the **date you read it** on that page.

Without both we cannot tell whether the catalog is wrong or the page changed since. Say which model,
tier and component you mean, what the page shows, and what the catalog shows. A screenshot helps.

If you think a price was changed or presented in a misleading way on purpose, do not open a public issue.
Follow [SECURITY.md](SECURITY.md).

## Add a source or a provider

Open a _New model or provider_ issue first, so we can agree it fits before you write code. The steps are
in [docs/adding-a-source.md](docs/adding-a-source.md). In short, the official page is the source of truth,
every price must carry its provenance, and a reader must fail closed.

## Pull requests

- Keep a pull request to one change.
- Run `npm run check` before you push.
- Fill in the pull request template: sources linked, fixtures updated, conformance vectors pass, and a
  [CHANGELOG](CHANGELOG.md) entry.
- A data change must link the provider page it comes from and say when you read it.

## Commit messages

- A plain imperative subject, at most 72 characters: `Add the OpenAI batch tier`.
- No type prefix (`feat:`, `fix:` and so on) and no trailing full stop.
- Use the body, wrapped at about 72 characters, to say why when the subject is not enough.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/), not a CLA. By signing
off you state that you wrote the change or have the right to submit it under the project's MIT licence.
Add the sign-off with `-s`:

```sh
git commit -s -m "Add the OpenAI batch tier"
```

That adds a `Signed-off-by: Your Name <you@example.com>` line, which must match the email of the commit's
author or committer. To fix commits you have already made, use `git rebase --signoff main`.

CI checks every commit in a pull request. Merge commits and Dependabot are exempt. When a pull request is
squash-merged, keep the `Signed-off-by` line in the squashed message.
