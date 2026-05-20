# Migrations

Each `NNN_name.sql` runs once, in filename order, inside a transaction. Names of applied migrations are recorded in `_migrations`.

## Rule: expand-only, never rename or drop in the same release

Migrations only ADD columns/tables/indexes; never RENAME or DROP in the same release as the code that needs the change. When a column rename is needed:

- release N adds the new column + writes both
- release N+1 reads from the new column
- release N+2 stops writing the old column
- release N+3 drops the old column

This keeps rolling deploys (and downgrades) safe.
