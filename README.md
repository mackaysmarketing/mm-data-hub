# mm-data-hub

Ingestion + modelling for the **Mackays Data Hub**. Lands source data into the shared
Supabase hub project `data_hub` and shapes it `raw → core → semantic`. FreshTrack
(packhouse) is the first and only source in v1.

> This repo owns the `raw` / `core` / `semantic` schemas **only**. The `public` schema
> belongs to mm-hub and must never be migrated from here. See `CLAUDE.md`.

## Layout

```
supabase/migrations/   DDL for raw/core/semantic (Supabase CLI layout)
src/
  lib/                 env, FreshTrack GraphQL client, pg pool, windows, parsers
  loaders/             entities, dispatch, pallets, backfill orchestrator
  reconcile.ts         per-load box reconciliation report
  schemaDiff.ts        FreshTrack schema-diff watcher
references/            grading rubric, stored FreshTrack schema snapshot
sql/                   RLS two-context proof, ad-hoc evidence queries
tests/                 unit tests (windows, parsers, test-consignor filter)
reports/               generated reconciliation / backfill reports (gitignored)
```

## Setup

```bash
cp .env.example .env      # fill in FreshTrack + DATABASE_URL
npm install
npm run typecheck
npm test
```

## Migrations

Files in `supabase/migrations/` are the source of truth. Apply with the Supabase CLI
(`supabase db push`) or the management API. They are additive and only create
`raw` / `core` / `semantic` objects.

## Backfill (FY25-26)

```bash
npm run load:entities      # entity master → raw.ft_entity (derives is_test)
npm run backfill           # walks BACKFILL_START→today in WINDOW_DAYS windows,
                           # loads dispatch_load + pallets, idempotent, resumable
npm run reconcile          # writes reports/reconciliation_<date>.md
```

The loader excludes the test consignors at pull, upserts on `id`, and records each
window in `raw.sync_window` so an interrupted backfill resumes where it stopped.

## Grower access (RLS)

`semantic.grower_dispatch_detail` is grower-scoped via the JWT claim `consignor_id`
(set by mm-hub). See `sql/rls_two_context_proof.sql` for the isolation proof.
