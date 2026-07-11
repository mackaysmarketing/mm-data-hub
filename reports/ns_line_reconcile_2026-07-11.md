# NetSuite RCTI line-reconciliation — 2026-07-11T13:39:26.009Z

Bills: **1167** · fact rows: **1167** · tolerance: 0.01

| Check | Result |
|---|---|
| A. DB fact recon_diff within tol | PASS (0 over tol) |
| B. Oracle net == −bill_total (sum lines = total) | PASS (0 mismatch) |
| C. Oracle net == SQL fact net_paid (no drift) | PASS (0 mismatch) |

## Surfaced (not hidden)
- Unmapped growers (consignor_id null): **0**
- Bills with OTHER-category (unclassified) deduction lines: **1** (Σ -221.00)
