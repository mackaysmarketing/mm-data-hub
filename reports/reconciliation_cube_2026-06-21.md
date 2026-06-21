# Cube reconciliation — dispatch measures vs raw SQL

Date: 2026-06-21  ·  Context: internal/unscoped  ·  Project: data_hub (uqzfkhsdyeokwnkpcxui)
Baked-in filters: order_type='S' (Sell), actual_pickup_on not null, non-test consignor.

## Result: ✅ all measures reconcile within tolerance

| Measure | Overall (Cube = SQL) | by-grower groups | by-pack_week groups |
|---|---|---|---|
| `load_count` | 5621 = 5621 | 28/28 match | 55/55 match |
| `pallet_count` | 38322 = 38322 | 28/28 match | 55/55 match |
| `net_weight_dispatched` | 27822146 = 27822146 | 28/28 match | 55/55 match |
| `line_count` | 8849 = 8849 | 28/28 match | 55/55 match |

## Produce capture rate (null integrity — nulls excluded, never 0)
net_weight_kg is the SUM; **null** (e.g. Mango — sold by count) proves the sum is NOT coalesced to 0.
| crop | pallets | with net_weight | net_weight_kg | capture | Cube=SQL |
|---|---|---|---|---|---|
| Banana | 33046 | 32235 | 25673243 | 97.5% | ✓ |
| Papaya | 3079 | 3079 | 1472862 | 100.0% | ✓ |
| Avocado | 1394 | 1159 | 604542 | 83.1% | ✓ |
| Mango | 591 | 0 | **null** | 0.0% | ✓ |
| Passionfruit | 184 | 172 | 48825 | 93.5% | ✓ |
|  | 28 | 27 | 22674 | 96.4% | ✓ |
| ∅(null) | 0 | 0 | **null** | —% | ✓ |

## Variances
None — every measure matched on every group (counts exact, net weight within 0.01 kg).
