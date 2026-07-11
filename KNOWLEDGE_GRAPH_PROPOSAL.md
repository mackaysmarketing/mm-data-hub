# Design note — Business knowledge graph (the agent context layer)

**Status:** design sketch (not a sprint — no acceptance criteria, no code). 2026-07-09.
**Relates to:** `DATA_HUB_AUDIT.md` §8 Tier 2 · CLAUDE.md schema-ownership + claim contract ·
mm-hub grower-access-claims sprint (the resolver chain) · `GROWER_MCP_PROPOSAL.md`.

## Goal
An **ever-evolving** model of the Mackays Marketing business — people, their **roles**, and the
entities they relate to — that agents traverse to **derive context from who's asking**, instead of
being handed IDs. The canonical example:

> *Jon* asks "what were **my growers'** farm dispatches last week?" → the system resolves *Jon → his
> role → the grower portfolio he manages* (from CRM records) → scopes the query. No hand-supplied list.

## The key insight: the core resolver already exists
mm-hub's grower-access-claims sprint already defines the canonical chain for *one* relationship:

```
user → module_access(module_id='grower-portal') → config.grower_group_id
     → farms(grower_group_id) [∩ grower_ids if a scoped role]
     → ft_entities.consignor_freshtrack_id  →  the consignor (grower) set
```

That **is** "who are Jon's growers." The knowledge graph **generalises this single resolved edge into
a queryable web of many** — roles, farms, customers, products — so any agent can ask relationship
questions, not just the RLS layer.

## Core model (kept deliberately small to start)
**Nodes:** Person (staff / portal user) · Role · Grower (= consignor) · GrowerGroup · Farm ·
Customer (= consignee) · Product / Crop · Site / Shed · Marketer · Carrier.

**Edges (examples):** Person —`hasRole`→ Role · Person —`manages`→ Grower | GrowerGroup ·
Grower —`memberOf`→ GrowerGroup · Grower —`owns`→ Farm · Farm —`isEntity`→ Consignor ·
Farm —`grows`→ Product · Customer —`buys`→ Product · Role —`mayAccess`→ Domain (dispatch / settlement / …).

## Sources (all already in reach)
- **mm-hub CRM** — `hub_users`, `farms`, `grower_groups`, `module_access`, `ft_entities`
  (the person / role / farm / grower-management relationships).
- **Hub conformed dims** — `dim_grower` (consignor), and the planned `dim_customer` / `dim_product`
  (the grower / customer / produce nodes; note these are gap §8 #10, "build once, share").
- **A small, version-controlled seed** for what CRM doesn't encode — org hierarchy, role → permitted
  domains, account-manager ↔ grower assignments if not already in the CRM.

## Two build options
**A. Relational-first MVP (recommended start).** Model edges as **relationship tables / views** in
`core` / `semantic` (e.g. `core.rel_person_grower`), materialised on a schedule from CRM + dims;
resolve context with plain joins / recursive SQL. **No new infrastructure** — stays in Supabase
Postgres, and covers the Jon case immediately by reusing the mm-hub chain.

**B. Property-graph engine (escalate only if needed).** Postgres **AGE** (openCypher on Postgres) or a
dedicated graph DB (Neo4j / Memgraph) — worth it only if multi-hop, arbitrary-relationship traversal
outgrows SQL. Don't start here.

## How agents consume it
- A `resolve_context(person)` function returns e.g. `{ roles, managed_consignor_set, permitted_domains }`.
- That feeds **two** things: (a) the **query filters / MCP identity** (the "my growers" set — see
  `GROWER_MCP_PROPOSAL.md`), and (b) **natural-language context** in the agent prompt ("you are acting
  for Jon, an account manager; his growers are …; he may see dispatch + settlement").
- End-to-end: *Jon → resolve_context → managed consignor set →* `query_metric(dispatched_boxes,
  filter consignor ∈ set, time = last week)` *→ MCP + RLS enforce → answer.*

## Governance — the critical distinction
- **The graph informs *relevance / context*; it is NOT the security boundary.** RLS + the
  `app_metadata` claim contract remain the *enforced* scope. A graph edge can **never widen** what a
  caller may actually read.
- For a **grower user**, RLS already restricts to their consignor set; the graph only adds role/context.
- For an **internal user** (Jon `is_internal` ⇒ RLS lets him see all rows), the graph **narrows** to
  "his growers" for **relevance/UX**, not access control. If genuine *need-to-know enforcement* for
  internal staff is required, that is a **separate policy layer** on top of the graph — an explicit
  decision, not assumed here.
- **Ever-evolving = derived, not hand-curated.** Materialise from CRM + dims on a schedule; the only
  hand-maintained part is the small version-controlled seed for org facts CRM lacks.

## Schema-ownership note (important — CLAUDE.md boundary)
The graph is **cross-repo by nature**: the person / role / grower-management edges live in mm-hub's
`public` CRM (which **this repo must never migrate**), while the grower / customer / product / dispatch
entities live in the warehouse (`core` / `semantic`). So decide **where the graph lives**: most likely
mm-hub owns the person↔grower resolver (it already stamps `app_metadata`), the warehouse owns the
entity dims, and a thin **shared contract** (a resolver API or a read-only consumption view) joins them —
rather than either repo reaching across the boundary. This repo would contribute only `core` / `semantic`
relationship objects over data it owns.

## Open questions (decide at sprint time)
- Which internal **roles / relationships** exist beyond grower-portal (account managers, field officers,
  finance, sales)? Where are they recorded — CRM, or is a new source of truth needed?
- Is internal **need-to-know narrowing** a hard requirement, or relevance-only?
- Refresh cadence + change tracking ("ever-evolving" implies history — do we keep it?).
- Where does the graph physically live, given the mm-hub / mm-data-hub schema boundary?

## Rough phasing
1. **Relational MVP** — person→grower resolver as a view reusing the mm-hub chain; prove the Jon case.
2. Add **role + domain-permission** nodes; feed the grower/internal MCP context.
3. Extend to **customer / product** relationships (needs `dim_customer` / `dim_product`, §8 #10).
4. Evaluate a **property-graph engine** only if traversal outgrows SQL.
