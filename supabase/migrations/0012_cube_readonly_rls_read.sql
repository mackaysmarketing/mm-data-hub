-- 0012_cube_readonly_rls_read — let the Cube data-source role read ALL rows on the
-- RLS-enabled base tables.
--
-- Cube enforces tenant scope ITSELF (cube/cube.js queryRewrite on app_metadata.consignor_id),
-- so its database role must see every row. RLS on raw.ft_dispatch_load / raw.ft_pallet /
-- core.dim_grower (migrations 0008 + 0010) targets the `authenticated` role, so a plain
-- read-only role returns 0 rows. We add SURGICAL permissive SELECT policies for cube_readonly
-- (scoped to exactly the three RLS tables this repo owns) rather than a global BYPASSRLS
-- attribute — narrower blast radius, and a future RLS table won't be silently exposed.
--
-- This does NOT widen the GROWER path: the `authenticated` policies are unchanged, so a grower
-- JWT is still scoped by consignor_id. Only the cube_readonly service role sees all rows, and
-- it is reachable only by Cube Cloud (which re-applies tenant scope per query).

drop policy if exists cube_readonly_read_all on raw.ft_dispatch_load;
create policy cube_readonly_read_all on raw.ft_dispatch_load
  for select to cube_readonly using (true);

drop policy if exists cube_readonly_read_all on raw.ft_pallet;
create policy cube_readonly_read_all on raw.ft_pallet
  for select to cube_readonly using (true);

drop policy if exists cube_readonly_read_all on core.dim_grower;
create policy cube_readonly_read_all on core.dim_grower
  for select to cube_readonly using (true);
