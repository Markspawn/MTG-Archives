# Exact set selection in Inventory

Issue [#1046](https://github.com/sefaction/MTG-Archives/issues/1046) reports that selecting Marvel Universe (`MAR`) also shows unrelated sets. The Inventory predicate accepted either the exact code or any set name containing `mar`, which also admits March of the Machine, Aftermath and other Marvel sets.

Private and public Inventory now match a selected set against its code or full name exactly, ignoring case. Multiple selected sets form a union. Autocomplete still accepts partial names/codes to find the intended set; the general text search still accepts partial text. The Set input now says “Search set names or codes...” instead of suggesting that a partial name is a final selection.

The same predicates feed the server-rendered results, paged API results, totals and private filtered export/selection. Existing owner, visibility and other filter constraints remain in place. This changes no schema, catalog data, Inventory quantities or saved filters.

## Database regression

`tests/inventory-set-filter-postgres.ts` is an explicit disposable-PostgreSQL qualification. It refuses to run without `MTG_SET_FILTER_DATABASE_TEST=1` and the exact fixture database `review_set_filter` at `mtg-set-filter-db`. Apply the ordinary Prisma migrations to that isolated database, then run:

```sh
MTG_SET_FILTER_DATABASE_TEST=1 node_modules/.bin/tsx tests/inventory-set-filter-postgres.ts
```

The fixture checks both private and public predicates against actual PostgreSQL:

- Mixed-case exact codes and names exclude unrelated substring/prefix matches.
- Multiple selected sets form a union, with duplicate selections normalized.
- Other card filters still intersect the selected sets.
- Unknown sets match nothing; null set names still permit an exact code match.
- General text search remains partial.
- Private ownership and public visibility exclude the private peer's copies; result counts and quantities agree.

Every fixture write is inside one transaction that is rolled back, including when a regression assertion fails. The runner verifies that Inventory/card counts return to their baseline and that its temporary accounts are absent.

On the unchanged source, ten of the sixteen checks fail with the reported extra sets, while the six unaffected controls pass. After the fix, all sixteen pass. This is a controlled reproduction of the predicate defect; it does not infer anything about unrelated historical performance or connection incidents.

## Delivery checks

Local review uses a separately owned synthetic database and a production build. Desktop and phone checks cover selecting the suggested set, reload persistence, private/public list APIs, result and selection totals, filtered export and preserved source rows. The exact source/build identities and artifacts are retained in the owning checkpoint and PR. CI, source merge, production deployment and reporter acceptance are separate steps.

Author qualification passes the sixteen database cases, 44 focused existing controls, full typecheck/production build and actual 1366px/390px browser workflow. All 1,491 installed build-manifest inputs match. The browser run preserves every fixture Inventory/card row fingerprint and verifies selection/export counts and private/public boundaries. Initial browser-startup, locator and fixture-quoting harness failures are retained with their limits; the final unchanged-product run passes. The current review is isolated from existing previews and production.
