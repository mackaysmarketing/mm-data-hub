# mm-hub: public-schema REST follow-up (post-Auth0 audit, 2026-07-17)

Hand this file to the mm-hub repo/session — it is self-contained. Written by mm-data-hub after a
fresh read-only audit of the live `data_hub` project (`uqzfkhsdyeokwnkpcxui`), prompted by the
grower-portal fix list (its FIX 3: "public schema is exposed to the REST API: sweep or unexpose").
Follow-up to `mm-hub-public-hardening-checklist.md` (2026-07-16) — most of that checklist is now
verified DONE; two items remain. Everything here is mm-hub's territory: mm-data-hub does not touch
`public` and has made no changes.

## Verified fixed since the 2026-07-16 checklist (audit trail, no action)
- Every `public` table now has **RLS enabled** (38/38; the P0 no-RLS set is gone — the gr_*
  register surfaces are now security_invoker views over the hub's gated tables).
- `quotes`, `quote_daily_prices`, `file_uploads` are now **`private.portal_is_internal()`-gated**
  (the P1 `using(true)`/`with check(true)` review) — including the INSERT policies.
- Identity-scoped policies **fail closed for Auth0 (grower-portal) tokens**, verified
  behaviorally: `private.portal_group_id()` calls `auth.uid()`, whose uuid cast 22P02-errors on an
  `auth0|…` sub → the query aborts, zero rows. (Optional robustness, not security: a null-safe
  sub handling would turn those errors into empty results.)
- `pm_price_snapshots` / `pm_run_log`: RLS on, no policies → fail-closed (grants are dead).
- `anon` has **zero policies** on every public table → fail-closed everywhere today.

## REMAINING ITEM 1 — decide (or confirm) the five open reference tables
These carry a `using (true)` SELECT policy for `authenticated` — readable by EVERY logged-in
token, which since Auth0 enablement includes every grower-portal grower:

| table | rows today | note |
|---|---|---|
| `retailers` | 3 | retailer names |
| `distribution_centres` | 15 | DC list |
| `products` | 0 | will expose rows whenever populated |
| `ft_products` | 0 | ditto |
| `product_retailer_mappings` | 0 | ditto |

The 2026-07-16 checklist said "reference data probably yes" — if that acceptance stands, record
it (a comment on each policy is enough) and tell grower-portal these five are expected to return
rows to a grower token (their FIX 3 acceptance says "zero rows or errors for EVERY public
table" — it currently fails on `retailers` and `distribution_centres` only). If NOT accepted,
gate them, e.g.:

```sql
alter policy "Authenticated can read retailers" on public.retailers
  using (private.portal_is_internal());
-- …and the same for the other four (policy names from pg_policies).
```

Remember the empty three: the decision applies the moment someone loads rows into them.

## REMAINING ITEM 2 — strip the dead anon grants (hygiene / defense in depth)
Every public table still carries the Supabase-default **full grant set to `anon`**
(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/…). With zero anon policies they are inert today, but any
future `to public`/`to anon` policy or RLS toggle would go live instantly. mm-data-hub stripped
the equivalent from raw/core/semantic in its migration 0051. Suggested (verify first that nothing
anon-facing legitimately reads `public` over REST — e.g. any pre-login screen):

```sql
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
```

(Leave `authenticated` grants alone — mm-hub's app and the gr_* invoker views depend on them;
RLS is the row gate.)

## Acceptance (grower-portal will re-run their probes)
1. With a grower token (mm-hub email login or Auth0), a REST read of EVERY public table returns
   zero rows or an error — except any table mm-hub explicitly accepts as shared reference
   (communicate that list to grower-portal so their probe whitelists it).
2. `select count(*) from pg_policies where schemaname='public' and roles::text like '%anon%'` → 0
   and `select count(*) from information_schema.table_privileges where table_schema='public' and
   grantee='anon'` → 0.
3. Nothing about the mm-hub app itself changes (it authenticates; `authenticated` grants + RLS
   are untouched).

## Audit queries used (re-runnable)
```sql
select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;
select tablename, policyname, cmd, roles::text, qual, with_check
  from pg_policies where schemaname='public' order by 1, 2;
select table_name, grantee, privilege_type
  from information_schema.table_privileges
 where table_schema='public' and grantee in ('anon','authenticated');
```
