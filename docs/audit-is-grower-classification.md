# is_grower audit (2026-07-21)

Multi-agent audit. 13 agents, 4 died on connection errors (the whole buyloads track + 2 verifiers) — findings below each survived >=1 independent verifier re-running the SQL.

# is_grower audit — synthesis for Tim

## 1. Your assumption: PARTLY RIGHT on the concept, WRONG on the data

**The single most important number: 2,197 of 3,501 Buy loads (62.8%) are consigned by an entity flagged `is_grower = true` — versus only 8,186 of 19,610 Sell loads (41.7%).** Buy loads are *more* grower-sourced than Sell loads, not less.

```sql
select d.order_type, coalesce(g.is_grower::text,'(no dim)'), count(*)
from raw.ft_dispatch_load d left join core.dim_grower g on g.consignor_id=d.consignor_id
where coalesce(g.is_test,false)=false group by 1,2;
-- B/true 2197 · B/false 1304 · B/(no dim) 24 · S/true 8186 · S/false 11424 · S/(no dim) 2
```

Three independent findings say `order_type` is a **leg type** (stock moving inbound), not a commercial-terms flag:

- **73.0% of Buy loads are consigned to a Mackays site** (MMTRU 1,813 · MMANN 440 · MMLAR 317). B = fruit arriving at our own DC.
- **Buy loads settle on the commission mechanism.** The 1,043 GP settlement-load rows whose *origin* load is Buy carry gross $4,749,172.82 → net $4,043,914.26 after deductions −$661,305.65 and GST −$43,953.22. A purchase has no deduction ledger against the supplier. (Verifier note: two of three verifications reproduced 1,043/$4.75m/$4.04m exactly via `origin_dispatch_load_id`; a third could not reproduce it on a different join. Treat the $4.04m as *net*, not gross, and as origin-grain.)
- **The heaviest Buy consignors are also the heaviest Sell consignors** — MACBO 1,801 S / 29 B, MACSD 1,489 S / 4 B, MACRR 1,174 S / 48 B. They are not a separate supplier class.

**What IS real is the margin book you're describing — but it does not correspond to Buy loads.** There are **41 `is_grower=true` entities with zero GP settlement, ever**: buy-only, mostly avocado/mango, invoiced to customers, never settled to a grower. FERRA $498,621.81 customer invoice · AVCOL $380,765.69 · HAPVA $243,848.44 · DELROY $237,917.57 · COSAV $190,125.54 · SIMPS $140,902.02 · ALTIT $125,397.44. **None of them appears anywhere in the settlement ledger.** That is the margin cohort — and it is sitting *inside* the grower flag.

**Unverified / needs you:** nothing in the hub proves these 41 are paid on margin. They have no GP schedule and are absent from NetSuite vendor category 110. We can prove they don't settle on commission; we cannot prove how they *are* paid (AP purchase invoices are not landed here).

## 2. `is_grower` is NOT reliable

It is a verbatim, unvalidated copy of a FreshTrack checkbox — `EntityNode.isGrower` → `raw.ft_entity.is_grower` → `core.dim_grower.is_grower`, no transform, no validation (`src/lib/specs.ts:96`, `0004_raw_ft_entity.sql:13`, `0058_grower_directory_hierarchy.sql:48`). Snapshot is **10 days stale** (all 320 entity rows stamped 2026-07-11 13:32:08Z). 0 nulls. Of 100 flagged growers, **57 are corroborated by nothing** — no GP settlement, no NetSuite grower vendor.

FreshTrack's own `tags` field contradicts the flag on 12 rows. Every one of these is `is_grower=true`, active, non-test, and in the staff activation picker today:

| code | org_name | tags | flag now | should be | evidence |
|---|---|---|---|---|---|
| **AGSCU** | Sculli - Agent | `{Agent}` | true | **false** | Only 1 of 11 AG* entities flagged true; 0 S / 1 B load; 1 GP schedule $19,600 gross / $16,000 net; not a NetSuite grower |
| **QPIWA** | QPI | `{Customer,Wholesale}` | true | **false** | Wholesaler; zero loads, zero settlement; its own agent AGQPI is correctly `false` and settles $33,619 |
| **SIMPS** | Simpson Farms | `{Customer,Services,3PL}` | true | **false** | 0 S / 106 B, 0 settlement, not NS-110 |
| **COSAV** | Costa Avocado | `{Customer,Services}` | true | **false** | 0 S / 100 B, 0 settlement |
| **AVCOL** | The Avocado Collective | `{Customer,Services}` | true | **false** | 0 S / 85 B, 0 settlement |
| **HAPVA** | Happy Valley | `{Customer,Services}` | true | **false** | 0 S / 56 B, 0 settlement |
| **ROMEO** | Romeo's Best | `{Customer,Services}` | true | **false** | 0 S / 45 B, 0 settlement |
| **AVOCO** | Avoco | `{Customer,Services}` | true | **false** | 0 S / 40 B, 0 settlement |
| **PINAT** | Pinata Farms | `{Customer,Services}` | true | **false** | 1 S / 12 B, 0 settlement |
| **STAHM** | Stahmann Webster | `{Customer,Services}` | true | **false** | zero activity |
| **MAJES** | Majestic Fruit Company | `{Customer,Services}` | true | **false** | zero activity |
| **AVOLU** | Avolution | `{Vendor}` | true | **your call** | Tagged Vendor, BUT is a NetSuite cat-110 grower with 1 GP schedule $134,880 — genuinely ambiguous |
| **MG** | Mackays Growers | `{}` | true | **false** | The umbrella holding org (parent of ~20 farms), not a farm. Zero activity |

That is 13 rows (12 tag-contradicted + MG). All are in `semantic.grower_directory` today; all have `portal_enabled = false`.

**No false negatives on the farm side.** All 56 `is_grower=false` rows were inspected: MM's own sites, 3PLs, supermarket DCs, wholesalers, the 3 `*TEST` entities, and the six trading agents. **Not one `is_grower=false` entity outside those six agents has a single GP schedule or NetSuite RCTI** — so tightening the flag would lock nobody out.

The six agents settle $1,946,988.56 gross / $1,798,968.37 net through GP (AGDBM $1,421,136.47 net · AGRRF $153,566.09 · AGPER $75,703.85 · AGSQB $63,256.00 · AGPFM $54,120.00 · AGQPI $31,185.96) and are **correctly flagged false** — leave them.

**Uncomfortable finding on the agents:** they are charged your standard commission rate card. Median commission is **4.39% of gross for AG* agents and 4.39% for growers** (233 vs 1,036 schedules over $1,000). The retail rebate is passed through to them. There is no purchase-price or fixed-$/box line anywhere in the GP charge data. **On the data, the agents look like commission relationships, not margin ones** — the opposite of the assumption. Worth an ops answer.

## 3. Can the portal expose non-grower data today? YES — and one gate is all that stands in the way

**Nothing is mis-exposed right now.** All 32 activated consignors are `is_grower=true`, active, non-test. No AG* code, no avocado marketer, no MM site.

But the protection is thinner than it looks:

- **No RLS policy anywhere in `raw`/`core`/`semantic` references `is_grower`, `is_test`, `order_type`, or activation.** Every grower policy is `consignor_id = ANY(claimed set)`. Confirmed by two independent verifiers against `pg_policies`.
- **`portal_grower_activation` gates nothing but a display column.** It is read by exactly one object — `semantic.grower_directory` — as a LEFT JOIN producing `portal_enabled`. A token for a *non-activated* grower still reads that grower's full dispatch, sales and settlement.
- **`semantic.auth0_consignor_ids()` never joins `dim_grower`.** Any uuid in the claim that exists returns its rows, grower or not.

**So: for non-grower data to appear in the portal, exactly one thing must happen — someone puts that consignor's uuid into a user's `consignor_ids` claim in Auth0.** There is no second gate. Proven live:

| minted claim | reads |
|---|---|
| AGDBM (agent) | 104 GP schedules **$1,421,136.47 net**, 106 loads, 647 pallets |
| MMTRU (our own DC) | **$95,918,521.15** of revenue by load × retailer group, 54,147 shipped-pallet rows |

Two secondary holes worth naming:
- **The write path has no grower check.** `semantic.set_grower_portal_enabled` validates only that the uuid exists in `dim_grower` — an admin can activate MMTRU, AGDBM, or a `*TEST` consignor by passing the uuid directly, even though the picker would never offer them.
- **A staff token reads everything underneath the directory**: all 156 `dim_grower` rows (incl. 3 test), 179,822 shipped-pallet rows, $205,794,056.25 load-sale gross, $150,027,802.80 GP net, $148,112,414.03 NetSuite RCTI net. The curated directory sits in front of the picker, not in front of the data.
- **`semantic.grower_dispatch_detail`** (what the MCP serves) has no order_type, no state, no grower, and no archived filter — 2,058 of its 48,073 rows are Buy loads and 12,194 are archived. In practice it is 78.5% Mackays' own DC movements and 0.11% agents.

**Buy-load revenue is already visible to real, activated growers today**: `semantic.grower_load_sale` has no `order_type` filter — 393 rows / **$841,892.78 gross** on Buy loads belong to the 32 activated consignors (1,597 rows / $4,170,494.50 across all consignors). Not a leak of someone else's data, but it is Buy-origin money already in growers' hands.

## 4. Recommended predicate

**Do not use `order_type`.** It would wrongly exclude 1,067 loads belonging to commission-settled consignors carrying $4.75m of settlement gross, and wrongly include 11,420 Sell loads consigned by our own depots.

**Do not use `is_grower` alone** — it admits all 13 rows above plus the 41-entity margin book.

**Use a corroboration predicate as the candidate list, and keep `portal_grower_activation` as the gate** (the 0059 lesson: curation must never sit on a rebuilt dim):

```
is_grower AND NOT is_test
AND (has GP settlement OR is a NetSuite cat-110 vendor OR tags @> '{Grower}')
AND NOT (tags is non-empty AND tags does not contain 'Grower')   -- kills the agent/customer/vendor contradictions
```

**What it changes:**

| | now | with predicate |
|---|---|---|
| `semantic.grower_directory` rows offered to staff | **100** | **41** (−59) |
| of which agents / marketers / MM-corporate | 13 | **0** |
| currently activated growers retained | 32 | **31** |
| currently activated growers dropped | — | **GJFSD only** |
| data rows/$ exposed on any surface | — | **0 change** (activation gates nothing today) |

GJFSD "G & J Flegler – South Davidson Farm" is the sole casualty — untagged, no settlement, not a NetSuite vendor, 1 Buy load, but you enabled it. Whitelist it explicitly.

Ten entities qualify but are not yet enabled: HOWEE, DANDY, GOLTR, KUREE, LEAHY, JUSTE, OBIFW, WADDA, ALCOC, SANGH.

**A settlement-only predicate is unsafe** — it drops 10 of your 32 activated consignors, because settlement lands on the *child* farm while the portal login is often the *parent* (LRCOL→LRCLA/LRCTU, LMBFA→LMBEP/LMBCO/LMBBF, MACMR→MACKF, NOUHO/NOUSB→NOUBC). Nine of those 10 are NetSuite cat-110 growers, which is why the NS-110 leg is load-bearing.

**Separately, and independent of the directory:** if you want a hub-side guarantee rather than trusting the Auth0 tenant, intersect the claimed consignor set against the same predicate inside `auth0_consignor_ids()` / `current_consignor_ids()`. One change, flips all seven relations, all views, Cube and the MCP at once. Verified safe: no `is_grower=false` entity outside the six agents has any settlement, so nobody loses access. AGSCU must be reclassified first or it loses access.

Also add: an `is_grower`/`is_test` guard inside `set_grower_portal_enabled` — the picker cannot be the only control.

## 5. Open questions only you can answer

1. **The 41 never-settled `is_grower=true` entities (BARAM 288 B loads, FERRA 147, JAHFA 137, ALTIT 97, COSAV 100, SIMPS 106, …) — are these farms we buy outright, or third-party marketers?** Nothing in the hub distinguishes them. This is the core of your margin book and it is unresolved.
2. **AVOLU "Avolution"** — tagged `{Vendor}` but a NetSuite cat-110 grower with $134,880 GP settlement. Grower or not?
3. **Agents are on the same 4.39% commission rate card as growers, with the retail rebate passed through.** Is that intended? It contradicts "agents = margin". Also: AGPER −$4,521.68, AGSQB −$5,684.31, AGPFM −$936.47 net commission — commission paid *out* to the agent, or reversals?
4. **GJFTF, HOWEE, KUREE, GOLTR** — set up in NetSuite as growers, zero RCTIs ever, buy-only dispatch. Commission growers not yet settled, or purchase suppliers mis-set-up?
5. **Should AGSCU / QPIWA / MG be fixed in FreshTrack** (the flag is source master data, not a hub bug) or worked around in the hub?
6. **Who mints `consignor_ids` in the Auth0 tenant, and from what?** Neither audit could inspect the `mackaysmarketing` tenant (`auth0_list_actions` returned a config error). If that Action reads free-form `app_metadata` on the user record, the only real gate is manual discipline.
7. **How is the $1.17m of cash paid to AGDBM booked?** (net settlement $1,421,136.47; `sum(paid_amount)` $1,165,380.00). No AGDBM vendor exists in the landed NetSuite set. Requires a NetSuite query outside the hub.

**Flagged unverified:** the FreshTrack definition of `isGrower` and of `order_type` — both inferred behaviourally, neither read from source. The entity master has not re-synced since 2026-07-11, so any FreshTrack reclassification in the last 10 days is invisible here. One verifier disputed the 1,043-row / $4.04m Buy-origin figure on a different join; the two that reproduced it used `origin_dispatch_load_id`, which is the correct grain — but note 1,158 further settlement rows have a NULL origin (multi-origin loads) carrying $16.6m gross that no origin-based analysis can classify at all.
