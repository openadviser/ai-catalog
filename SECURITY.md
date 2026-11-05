# Security policy

## Reporting a vulnerability

Please report it privately through GitHub:
[**Report a vulnerability**](https://github.com/openadviser/ai-catalog/security/advisories/new)
(the _Security_ tab, then _Report a vulnerability_).

Do not open a public issue or pull request for a vulnerability. Reports are read and handled as the
maintainers' time allows; there is no response-time promise. You are credited in the advisory if you wish.

## What counts as a security issue

Consumers use this catalog to enforce budgets, so a price that is wrong _because someone made it so_ is a
security issue, not only a data error. In scope:

- a tampered or misleading price, model, effort level or validity window in `data/` or in a release,
  including a change that bypasses review or the reconciliation policy;
- a release whose contents do not match its published sha256, or a way to alter a published version;
- a reader or the update workflow that can be made to write a price from an untrusted source, or that can
  leak a secret or run untrusted code;
- a client that accepts a catalog it should reject (wrong hash, unsupported schema version, malformed
  data), or that prices a call with a rounding or arithmetic flaw that can be exploited;
- a weakness in the CI or release workflows, or in this repository's dependencies, that could lead to any
  of the above.

Not in scope:

- an honest mistake in a price, or a price that is out of date. That is a normal bug: open a
  [_Wrong or missing price_](https://github.com/openadviser/ai-catalog/issues/new/choose) issue.
- differences between the catalog and a provider's invoice, which is authoritative.
- plan discounts, credits, free tiers and regional prices, which the catalog does not model.

## Supported versions

Security fixes go to:

| What                              | Supported                                                                 |
| --------------------------------- | ------------------------------------------------------------------------- |
| The latest data release           | Yes                                                                       |
| Older data releases               | No. Releases are immutable, so a bad one is superseded rather than edited |
| The latest schema major version   | Yes                                                                       |
| The latest release of each client | Yes                                                                       |
