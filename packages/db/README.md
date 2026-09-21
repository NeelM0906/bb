# @bb/db

## Migration Workflow

Schema changes must be checked in as generated SQL migrations:

```sh
pnpm exec turbo run db:generate --filter=@bb/db
```

Review the generated SQL before committing it. `db:push` is intentionally not
exposed for this package because it mutates the target database directly and can
hide migration drift in persistent BB data directories.

## September 2026 fork integration

Both shipped `0115_workspace_safety` and upstream `0115_ui_preferences`
remain in the journal with their original timestamps and SQL hashes. Journal
positions follow timestamp order; migration identity is the timestamp and hash,
not the numerical filename prefix. Before Drizzle advances an existing database,
the migrator applies either missing divergent migration that falls below its
current migration timestamp. Fresh installations execute both in journal order.

The active snapshot chain follows upstream. The original fork snapshot is
preserved byte-for-byte in `drizzle/fork-history/`. Drizzle generated the
`0129` snapshot from the merged schema; its SQL is deliberately `SELECT 1`
because `0115_workspace_safety` already supplies that schema. This joins the
snapshot histories without replaying table or column creation or rewriting any
shipped SQL. Run `fork-upstream-upgrade.test.ts` for fresh, fork, and upstream
upgrade coverage, including repeated startup, ledger identity, retained project
protection, lease audit history, and UI preferences.
