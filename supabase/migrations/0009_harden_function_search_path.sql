-- 0009_harden_function_search_path — pin search_path on our functions.
-- current_consignor_id() / is_internal_claim() are used inside RLS policies, so a mutable
-- search_path is a privilege-escalation vector. All three reference only pg_catalog builtins
-- and fully-qualified objects, so an empty search_path is safe. (Advisor lint 0011.)

alter function semantic.current_consignor_id() set search_path = '';
alter function semantic.is_internal_claim()    set search_path = '';
alter function core.refresh_dim_grower()       set search_path = '';
