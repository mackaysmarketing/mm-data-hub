-- 0001_schemas — stand up the hub schemas owned by mm-data-hub.
-- This repo owns raw/core/semantic ONLY. public belongs to mm-hub; never touched here.

create schema if not exists raw;
create schema if not exists core;
create schema if not exists semantic;

comment on schema raw is 'mm-data-hub: per-source landing (source-faithful). Owner: mm-data-hub.';
comment on schema core is 'mm-data-hub: conformed dimensions & facts (cleaned, cast). Owner: mm-data-hub.';
comment on schema semantic is 'mm-data-hub: the only layer apps/BI/agents read (RLS-scoped). Owner: mm-data-hub.';

-- authenticated (grower / hub-staff JWTs) needs schema usage; RLS does the row filtering.
-- service_role bypasses RLS for ingestion and Cube/Steep reads.
grant usage on schema raw, core, semantic to authenticated;
