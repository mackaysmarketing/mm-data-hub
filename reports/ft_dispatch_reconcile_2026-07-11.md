# Dispatch backfill reconciliation — 2026-07-11T13:39:57.863Z

Tolerance: 2% (source is live — in-flight loads are the residual). Test consignors excluded both sides: 3.

## A. Counts (hub vs source, test-excluded)
| stream | hub | source | Δ | Δ% | ok |
|---|---:|---:|---:|---:|:--:|
| ft_dispatch_load | 23,137 | 23,073 | 64 | 0.28% | ✅ |
| ft_pallet | 210,436 | 210,302 | 134 | 0.06% | ✅ |

## D. Volumes (all landed pallets)
| measure | hub | source | Δ% | ok |
|---|---:|---:|---:|:--:|
| Σ net_weight_value | 135,015,636 | 134,966,672 | 0.04% | ✅ |
| Σ (stock+reconsigned) boxes | 14,680,989 | 14,673,005 | 0.05% | ✅ |

## E. Currency
- source max(actual_pickup_on) = 2026-07-13 02:00:00+00 · hub raw max = 2026-07-13 02:00:00+00 · view max(dispatched_on) = 2026-07-13
- source max(last_modified_on) = 2026-07-11 02:15:03.844375+00

## B. Per-grower load-count variances (8 growers differ)
| grower | hub | source | Δ |
|---|---:|---:|---:|
| MACKM | 78 | 43 | 35 |
| MACSD | 1493 | 1481 | 12 |
| MMANN | 2690 | 2684 | 6 |
| AGRRF | 73 | 69 | 4 |
| MACRR | 1222 | 1218 | 4 |
| NULL | 26 | 25 | 1 |
| MMLAR | 2745 | 2744 | 1 |
| MMTRU | 5169 | 5168 | 1 |

## C. Per-pack-week load counts (recent 8)
| pack_week | hub | source | Δ |
|---|---:|---:|---:|
| Y26W26 | 377 | 373 | 4 |
| Y26W27 | 367 | 366 | 1 |
| Y26W28 | 352 | 352 | 0 |
| Y26W29 | 118 | 118 | 0 |
| Y26W30 | 11 | 11 | 0 |
| Y26W32 | 1 | 1 | 0 |
| Y26W36 | 1 | 1 | 0 |
| Y26W53 | 5 | 5 | 0 |
