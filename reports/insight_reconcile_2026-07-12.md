# Insight-layer reconciliation — 2026-07-12

  dim_cust | cw_cust | cust_missing | dim_prod | cw_prod | prod_missing | cust_unmapped | prod_unmapped
  135 | 135 | 0 | 251 | 251 | 0 | 0 | 0
PASS  every dim_customer row has a crosswalk row — dim=135 crosswalk=135 missing=0 (unmapped surfaced: 0)
PASS  every dim_product row has a crosswalk row — dim=251 crosswalk=251 missing=0 (unmapped surfaced: 0)
  retail_mapped_pct | retail_state_pct | pallets | seg_pct | out_of_scope
  100.00 | 100.00 | 158039 | 98.76 | 1963
PASS  ≥95% of Coles/WOW/ALDI dispatch volume mapped (independent name-regex denominator) — 100.00%
PASS  ≥95% of mapped retail volume carries a state — 100.00%
PASS  ≥95% of banana pallets map to an in-scope segment — 98.76% of 158039 (OUT_OF_SCOPE bins/value-added: 1963 — correct, surfaced)

  unmapped / other-bucket consignees with retail-looking volume (expect none):
  (no rows)
  src_rows | mart_rows | src_dollars | mart_dollars | src_kg | mart_kg | src_units | mart_units
  1761 | 1761 | 1612083127.28 | 1612083127.28 | 361259872.06 | 361259872.06 | 369374039.06 | 369374039.06
PASS  mart scan cells == fact_retail_scan rows (causal total, own-brand) — src=1761 mart=1761
PASS  scan-side sums identical (dollars/kg/units) — $ 1612083127.28==1612083127.28 · kg 361259872.06==361259872.06 · units 369374039.06==369374039.06
  retailer_group | i_boxes | m_boxes | i_kg | m_kg | i_sell | m_sell
  coles | 2231935.00 | 2231935.00 | 32226180.00 | 32226180.00 | 91683156.30 | 91683156.30
  woolworths | 1455952.00 | 1455952.00 | 20769273.00 | 20769273.00 | 54180702.74 | 54180702.74
  aldi | 342621.00 | 342621.00 | 5139315.00 | 5139315.00 | 12927018.17 | 12927018.17
PASS  supply parity at AU×ALL per retailer (boxes/kg/sell$) — coles: 2231935.00==2231935.00 · woolworths: 1455952.00==1455952.00 · aldi: 342621.00==342621.00
  i_boxes | m_boxes | i_kg | m_kg | i_cells | m_cells
  4030508.00 | 4030508.00 | 58134768.00 | 58134768.00 | 820 | 820
PASS  supply parity at state×segment grain (boxes/kg + cell count) — boxes 4030508.00==4030508.00 · kg 58134768.00==58134768.00 · cells 820==820
  i_fg | m_fg | i_kg | m_kg
  157158593.26 | 157158593.26 | 57576297.30 | 57576297.30
PASS  farm-gate parity at AU×ALL ($ / kg) — $ 157158593.26==157158593.26 · kg 57576297.30==57576297.30
  cells | au_bad | absurd | pooled_bad | weekly_over | nonpos | mn | mx
  963 | 0 | 0 | 0 | 88 | 0 | 0.001 | 1.481
PASS  H1: every coles AU (national) cell share in (0, 1.05] — violations=0 of 963 cells (overall range 0.001..1.481)
PASS  H2: every coles (state, segment) POOLED share in (0, 1.10] — violating cell-groups=0
PASS  H3: no weekly cell share > 2.0 (unit-error ceiling) — violations=0
  weekly state cells > 1.05 (stock timing — DC receipts lead till sales): 88
  weekly cells with non-positive share (net-adjustment weeks, surfaced): 0
  pooled state groups in (1.05, 1.10] (sole-supplier + carton-vs-pack kg wedge):
  state_code | segment | weeks | pooled_share
  VIC | PRE_PACK | 54 | 1.055
  TAS | PRE_PACK | 54 | 1.051
  top weekly outliers (> 1.05):
  state_code | segment | week_ending | share
  TAS | PRE_PACK | 2025-09-02 | 1.481
  SA+NT | PRE_PACK | 2025-07-22 | 1.352
  SA+NT | PRE_PACK | 2026-06-16 | 1.339
  SA+NT | PRE_PACK | 2026-05-05 | 1.293
  VIC | PRE_PACK | 2026-05-26 | 1.291
  cells | full_ladder | pct
  110 | 109 | 99.1
PASS  ladder populated on the majority of coles REGULAR × VIC/QLD cells (SPRINT AC) — 109/110 = 99.1%
  ordering (informational — farm ≈ wholesale by agency construction):
  cells | farm_le_wholesale | wholesale_le_till | avg_farm | avg_wholesale | avg_till
  960 | 949 | 953 | 3.434 | 3.431 | 5.418
PASS  [core.fact_market_week] internal>0; grower/no-claim/forged/user_meta = 0 — internal=2605 grower=0 none=0 forged=0 user_meta=0
PASS  [core.crosswalk_customer_retail] internal>0; grower/no-claim/forged/user_meta = 0 — internal=135 grower=0 none=0 forged=0 user_meta=0
PASS  [core.crosswalk_product_segment] internal>0; grower/no-claim/forged/user_meta = 0 — internal=251 grower=0 none=0 forged=0 user_meta=0
PASS  [semantic.market_week] internal>0; grower/no-claim/forged/user_meta = 0 — internal=2605 grower=0 none=0 forged=0 user_meta=0
PASS  [semantic.customer_margin] internal>0; grower/no-claim/forged/user_meta = 0 — internal=818 grower=0 none=0 forged=0 user_meta=0
PASS  [semantic.grower_scorecard] internal>0; grower/no-claim/forged/user_meta = 0 — internal=349 grower=0 none=0 forged=0 user_meta=0
PASS  [semantic.retail_supplier_share] internal>0; grower/no-claim/forged/user_meta = 0 — internal=6942 grower=0 none=0 forged=0 user_meta=0