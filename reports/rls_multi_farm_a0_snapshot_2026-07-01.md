# A0 snapshot — grower RLS before the single→set switch (2026-07-01)

Captured from the LIVE hub (`uqzfkhsdyeokwnkpcxui`) with `pg_get_functiondef` / `pg_policies`,
immediately before migration `0026_grower_rls_consignor_set.sql`. This is the backward-compat
baseline: after the switch a **legacy single-`consignor_id` token must reproduce these exact
row counts** (proof A4).

## Next free migration number
Highest applied/authored migration is `0025_semantic_order.sql` → **next free = `0026`** (confirmed).

## Test set (real multi-farm grower + unrelated third)
Real multi-farm grower **L & R Collins** (two farms; NOT the Mackays Growers `MG` umbrella):

| role | code  | org_name                | consignor_id                           |
|------|-------|-------------------------|----------------------------------------|
| A    | LRCLA | L & R Collins - Lakeland| `019439a6-fb95-f543-c2e0-40d9f9b719fa` |
| B    | LRCTU | L & R Collins - Tully   | `019439a8-7d01-187c-89ff-970d71bdba6c` |
| C    | ZONTA | Zonta's Bananas (unrelated) | `019439d4-6e3a-2339-88d1-85b11877ed6a` |

(`LRCTU`/`LRCLA` are the same grower under two farm codes — see CLAUDE.md NetSuite crosswalk note.)

## A0 baseline row counts — CURRENT single-value policies
Under `role authenticated` + `request.jwt.claims`; internal = `app_metadata.is_internal=true`,
each grower = legacy `app_metadata.consignor_id=<id>`.

| table                          | internal | A=LRCLA | B=LRCTU | C=ZONTA |
|--------------------------------|---------:|--------:|--------:|--------:|
| raw.ft_dispatch_load           |    22450 |     129 |     120 |     120 |
| raw.ft_pallet                  |   205246 |    1332 |    2542 |     872 |
| core.dim_grower                |      156 |       1 |       1 |       1 |
| core.fact_settlement_bill      |     1097 |      51 |      51 |      50 |
| core.fact_gp_settlement        |     1254 |      49 |      49 |      48 |
| core.fact_gp_settlement_load   |    17975 |     127 |     102 |     331 |

## Current function definitions (semantic)

```sql
CREATE OR REPLACE FUNCTION semantic.current_consignor_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare claims text; val text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return null; end if;
  val := nullif(claims::jsonb -> 'app_metadata' ->> 'consignor_id', '');
  if val is null then return null; end if;
  begin
    return val::uuid;
  exception when others then
    return null;
  end;
end $function$;

CREATE OR REPLACE FUNCTION semantic.is_internal_claim()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare claims text; val text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return false; end if;
  val := lower(nullif(claims::jsonb -> 'app_metadata' ->> 'is_internal', ''));
  return val in ('true', 't', '1', 'yes');
end $function$;
```

## Current grower_own_* policies (pg_policies)

```
core.dim_grower :: grower_own_dim  roles={authenticated} cmd=SELECT
  USING: ((consignor_id = semantic.current_consignor_id()) OR semantic.is_internal_claim())

core.fact_gp_settlement :: grower_own_gp_settlement  roles={authenticated} cmd=SELECT
  USING: ((consignor_id = semantic.current_consignor_id()) OR semantic.is_internal_claim())

core.fact_gp_settlement_load :: grower_own_gp_settlement_load  roles={authenticated} cmd=SELECT
  USING: ((consignor_id = semantic.current_consignor_id()) OR semantic.is_internal_claim())

core.fact_settlement_bill :: grower_own_settlement  roles={authenticated} cmd=SELECT
  USING: ((consignor_id = semantic.current_consignor_id()) OR semantic.is_internal_claim())

raw.ft_dispatch_load :: grower_own_loads  roles={authenticated} cmd=SELECT
  USING: ((consignor_id = semantic.current_consignor_id()) OR semantic.is_internal_claim())

raw.ft_pallet :: grower_own_pallets  roles={authenticated} cmd=SELECT
  USING: (semantic.is_internal_claim() OR (dispatch_load_id IN (
            SELECT ft_dispatch_load.id FROM raw.ft_dispatch_load
             WHERE (ft_dispatch_load.consignor_id = semantic.current_consignor_id()))))
```
