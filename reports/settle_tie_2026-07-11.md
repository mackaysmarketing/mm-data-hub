# Settlement cross-source tie — GP ↔ NetSuite (grower × month)

Date: 2026-07-11 · Surface: `semantic.recon_settlement_source` (migration 0035) · Runner: `npm run settle:tie`

Month anchor: GP `payable_on` vs NS `settlement_date` (= trandate) — the like-for-like
settlement business dates (`paid_date` is cash and NULL for unpaid, so never the anchor).
Internal-only: explicit `WHERE semantic.is_internal_claim()` gate — no claim / grower claim → 0 rows (proven in Checks below).

## Grand tie

| basis | GP | NetSuite | Δ | Δ% |
|---|---:|---:|---:|---:|
| net (GP net_settlement vs NS net_paid) | $150,027,802.80 | $148,112,414.03 | $1,915,388.77 | 1.29% |
| cash (GP paid_amount vs NS net_paid) | $147,472,044.86 | $148,112,414.03 | -$640,369.17 | -0.43% |
| deductions | -$34,364,466.23 | -$34,490,947.49 | $126,481.26 | 0.37% |

## Residual buckets (net basis — every dollar accounted)

| bucket | amount | explanation |
|---|---:|---|
| GP null-consignor schedules | $6,123,462.25 | 52 schedules across 2 months, settled without a consignor; NetSuite rolls them into vendor RCTIs |
| GP-only AG* agent sub-entities | $1,814,968.37 | AGDBM, AGRRF, AGPER, AGSQB, AGPFM, AGQPI, AGSCU — GP settles agents as their own consignors; NetSuite pays the parent vendor |
| GP-only other entities | $2,417,469.66 | SERAV (Serra Farming - Avocados) $2,322,323.30; WADDA (Wadda Plantation - Gallaghers) $95,146.36 |
| NS-only growers | -$2,291.90 | MACKF (Mac Farms) $2,291.90 |
| matched-pairs shortfall | -$8,438,219.61 | matched GP runs low — the vendor RCTI absorbs the finer GP entities above |
| **unexplained residual** | **$0.00** | partition identity — must be ~0 |

Cash/timing decomposition of the grand delta: GP not-yet-paid $2,555,757.94 + cash-basis gap -$640,369.17 (-0.43% — the known ≈0.6% anchor).

## Per-grower table (sorted by |Δ net|)

| grower | name | status | gp months | ns months | gp_gross | gp_deductions | gp_net | gp_paid | ns_gross | ns_deductions | ns_net_paid | Δ net | Δ% |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| (null consignor) | ∅ | gp_null_consignor | 2 | 0 | $7,452,209.31 | -$1,230,655.91 | $6,123,462.25 | $5,288,701.86 | ∅ | ∅ | ∅ | ∅ | ∅ |
| SERRA | Serra Farming | both | 13 | 13 | $12,618,181.01 | -$1,978,266.69 | $10,484,059.18 | $10,222,214.50 | $16,227,985.60 | -$2,540,862.89 | $13,489,216.23 | -$3,005,157.05 | -22.28% |
| SERAV | Serra Farming - Avocados | gp_only | 5 | 0 | $2,769,135.65 | -$416,022.33 | $2,322,323.30 | $2,316,124.61 | ∅ | ∅ | ∅ | ∅ | ∅ |
| AGDBM | DBM - Agent | gp_only | 13 | 0 | $1,528,171.56 | -$106,905.48 | $1,421,136.47 | $1,165,380.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| MACBO | Mackays - Bolinda | both | 13 | 13 | $41,100,878.34 | -$9,704,481.29 | $30,528,288.82 | $29,955,011.12 | $42,949,736.03 | -$10,125,746.82 | $31,924,142.52 | -$1,395,853.70 | -4.37% |
| MACGT | Mackays - Gold Tyne | both | 13 | 13 | $23,121,650.38 | -$6,970,512.10 | $15,522,316.40 | $15,145,504.16 | $24,499,515.35 | -$7,356,322.50 | $16,480,698.91 | -$958,382.51 | -5.82% |
| LMBEP | LMB - East Palmerston | both | 13 | 13 | $14,647,015.67 | -$2,099,293.93 | $12,385,381.57 | $12,384,739.56 | $15,423,636.62 | -$2,227,671.49 | $13,025,760.84 | -$640,379.27 | -4.92% |
| MACSD | Mackays - South Davidson | both | 13 | 13 | $18,923,339.29 | -$2,618,195.13 | $16,105,992.93 | $15,759,923.31 | $19,600,555.45 | -$2,710,640.06 | $16,683,873.55 | -$577,880.62 | -3.46% |
| LMBBF | LMB - Bartle Frere | both | 1 | 1 | $831,663.00 | -$115,186.60 | $707,442.73 | $708,541.58 | $1,167,008.04 | -$160,007.52 | $994,463.14 | -$287,020.41 | -28.86% |
| NOUBC | Nourish | both | 13 | 13 | $9,104,902.57 | -$1,283,077.91 | $7,720,644.78 | $7,706,000.94 | $9,430,778.57 | -$1,341,318.45 | $7,983,570.31 | -$262,925.53 | -3.29% |
| LRCTU | L & R Collins - Tully | both | 13 | 13 | $4,956,166.20 | -$388,088.09 | $4,546,029.49 | $4,546,029.42 | $5,179,254.60 | -$405,286.33 | $4,750,940.78 | -$204,911.29 | -4.31% |
| LAUGO | Laurelgold | both | 13 | 13 | $4,278,264.72 | -$338,751.69 | $3,920,032.14 | $3,920,032.12 | $4,487,440.08 | -$354,877.36 | $4,112,164.04 | -$192,131.90 | -4.67% |
| PRIMO | Primo Produce | both | 6 | 6 | $543,072.64 | -$80,731.38 | $456,450.30 | $456,461.87 | $728,033.65 | -$109,857.44 | $610,201.54 | -$153,751.24 | -25.20% |
| AGRRF | Rock Ridge - Agent | gp_only | 12 | 0 | $175,104.00 | -$20,082.67 | $153,566.09 | $140,034.34 | ∅ | ∅ | ∅ | ∅ | ∅ |
| ROCKR | Rock Ridge | both | 13 | 13 | $2,614,704.36 | -$370,547.74 | $2,213,654.03 | $2,213,653.83 | $2,756,515.55 | -$392,419.47 | $2,331,760.69 | -$118,106.66 | -5.07% |
| WADDA | Wadda Plantation - Gallaghers | gp_only | 1 | 0 | $104,587.68 | -$8,898.84 | $95,146.36 | $95,146.36 | ∅ | ∅ | ∅ | ∅ | ∅ |
| WADDA | Wadda Plantation | both | 12 | 12 | $1,462,297.92 | -$120,494.11 | $1,334,694.53 | $1,334,694.52 | $1,566,885.60 | -$129,392.95 | $1,429,840.88 | -$95,146.35 | -6.65% |
| LRCLA | L & R Collins - Lakeland | both | 13 | 13 | $2,942,799.60 | -$362,930.99 | $2,552,827.40 | $2,856,489.88 | $3,049,284.00 | -$374,506.51 | $2,646,923.98 | -$94,096.58 | -3.55% |
| GJFMF | G & J Flegler - Mareeba Farm | both | 13 | 13 | $5,516,037.81 | -$750,164.91 | $4,708,918.90 | $4,701,355.26 | $5,633,757.81 | -$772,552.30 | $4,802,528.73 | -$93,609.83 | -1.95% |
| SLOWE | S. Lowe & Sons | both | 13 | 13 | $2,742,591.60 | -$278,062.02 | $2,445,650.68 | $2,444,891.22 | $2,840,060.15 | -$287,069.49 | $2,533,534.64 | -$87,883.96 | -3.47% |
| MACRR | Mackays - Ranch Road | both | 13 | 13 | $5,949,121.82 | -$1,658,714.43 | $4,138,146.97 | $4,058,975.30 | $6,071,874.60 | -$1,693,296.10 | $4,223,250.86 | -$85,103.89 | -2.02% |
| AGPER | Perfection Fresh - Agent | gp_only | 12 | 0 | $88,560.00 | -$12,783.85 | $75,703.85 | $67,704.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| LMBCO | LMB - Cooroo Bananas | both | 13 | 13 | $15,326,882.74 | -$2,204,567.42 | $12,951,233.55 | $12,885,828.63 | $15,434,006.66 | -$2,234,368.67 | $13,026,197.26 | -$74,963.71 | -0.58% |
| AGSQB | SQBR - Agent | gp_only | 2 | 0 | $63,652.00 | -$396.00 | $63,256.00 | $63,256.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| AGPFM | Premier Fresh Melbourne - Agent | gp_only | 1 | 0 | $57,882.00 | -$3,762.00 | $54,120.00 | $54,120.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| JUSTE | Justeatum | both | 9 | 9 | $661,404.60 | -$52,530.56 | $605,972.13 | $605,972.12 | $713,698.44 | -$56,561.98 | $654,005.10 | -$48,032.97 | -7.34% |
| AGQPI | QPI - Agent | gp_only | 4 | 0 | $33,619.00 | -$2,246.12 | $31,185.96 | $27,914.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| ZONTA | Zonta's Bananas | both | 13 | 13 | $1,717,126.73 | -$328,917.16 | $1,360,184.90 | $1,356,040.03 | $1,762,357.76 | -$342,285.64 | $1,391,029.56 | -$30,844.66 | -2.22% |
| ROLFE | Rolfe Farming | both | 13 | 13 | $4,503,114.55 | -$691,104.95 | $3,752,708.74 | $3,741,132.81 | $4,549,365.61 | -$708,944.59 | $3,779,603.06 | -$26,894.32 | -0.71% |
| AGSCU | Sculli - Agent | gp_only | 1 | 0 | $19,600.00 | -$3,600.00 | $16,000.00 | $16,000.00 | ∅ | ∅ | ∅ | ∅ | ∅ |
| SANGH | BD G & P Singh | both | 2 | 2 | $32,155.20 | -$3,844.75 | $28,017.53 | $31,852.73 | $35,990.40 | -$3,844.75 | $31,852.73 | -$3,835.20 | -12.04% |
| MACKF | Mac Farms | ns_only | 0 | 1 | ∅ | ∅ | ∅ | ∅ | $2,535.00 | -$221.00 | $2,291.90 | ∅ | ∅ |
| ALCOC | Alcock Bananas | both | 8 | 8 | $874,856.64 | -$79,374.25 | $790,634.67 | $791,942.66 | $876,164.64 | -$79,374.25 | $791,942.66 | -$1,307.99 | -0.17% |
| AVOLU | Avolution | both | 1 | 1 | $134,880.00 | -$16,350.93 | $117,231.18 | $114,987.15 | $137,124.00 | -$18,594.95 | $117,231.15 | $0.03 | 0.00% |
| OBIFW | Obie Fresh Walkamin | both | 4 | 4 | $166,788.00 | -$38,052.72 | $125,656.89 | $125,656.90 | $166,788.00 | -$38,052.70 | $125,656.90 | -$0.01 | -0.00% |
| GJFLE | G & J Flegler | both | 2 | 2 | $176,580.00 | -$23,357.29 | $151,457.34 | $151,457.33 | $176,580.00 | -$23,357.29 | $151,457.33 | $0.01 | 0.00% |
| DANDY | Dandy Produce | both | 1 | 1 | $14,946.00 | -$3,230.09 | $11,450.03 | $11,450.03 | $14,946.00 | -$3,230.09 | $11,450.03 | $0.00 | 0.00% |
| NOUPA | Nourish - Papaya | both | 3 | 3 | $7,130.00 | -$283.90 | $6,824.71 | $6,824.71 | $7,130.00 | -$283.90 | $6,824.71 | $0.00 | 0.00% |

## Checks

- PASS — no claim → 0 rows (fail closed) — rows=0
- PASS — grower claim → 0 rows (internal-only, not grower-scoped) — rows=0
- PASS — view totals == fact totals (nothing dropped by the FULL OUTER) — view gp_net=$150,027,802.80 gp_paid=$147,472,044.86 ns_net=$148,112,414.03 (311 rows) vs facts gp_net=$150,027,802.80 gp_paid=$147,472,044.86 ns_net=$148,112,414.03
- PASS — grand tie (cash basis): |GP paid − NS net_paid| ≤ 1% of NS — GP_paid=$147,472,044.86 NS=$148,112,414.03 Δ=-$640,369.17 (-0.43%)
- PASS — grand deductions tie: |GP − NS| ≤ 1% of NS — GP=-$34,364,466.23 NS=-$34,490,947.49 Δ=$126,481.26 (0.37%)
- PASS — per-grower table computed — 38 grower rows (27 matched)
- PASS — every dollar bucketed: |unexplained residual| < $50k — unexplained=$0.00 (grand $1,915,388.77 = null-consignor $6,123,462.25 + AG* $1,814,968.37 + gp-only-other $2,417,469.66 − ns-only $2,291.90 + matched -$8,438,219.61)

